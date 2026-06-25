# syntax=docker/dockerfile:1

# ─── mihomo 下载层（固定版本 + sha256 校验） ───────────────────
# amd64 用 compatible 资产；arm64 用标准资产
FROM alpine:3.20 AS mihomo-downloader
ARG MIHOMO_VERSION=v1.19.27
ARG TARGETARCH
# sha256（与 release 资产对应）
ARG MIHOMO_AMD64_SHA256=36850c946615f5c712946b62dbbbd06f6941d6d8a7543b315198bcb24ada3ea9
ARG MIHOMO_ARM64_SHA256=87db0c6660a9557a901b5750f997967e71d8c0af07ea1d1dd4d04c28da7f7e6f
RUN apk add --no-cache curl gzip ca-certificates
WORKDIR /tmp
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) \
        ASSET="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; \
        EXPECTED="${MIHOMO_AMD64_SHA256}"; \
        ;; \
      arm64) \
        ASSET="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; \
        EXPECTED="${MIHOMO_ARM64_SHA256}"; \
        ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${ASSET}"; \
    echo "downloading ${URL}"; \
    curl -fL --retry 3 --retry-delay 2 --retry-all-errors -o mihomo.gz "${URL}"; \
    ACTUAL="$(sha256sum mihomo.gz | awk '{print $1}')"; \
    if [ "${ACTUAL}" != "${EXPECTED}" ]; then \
      echo "sha256 mismatch for ${ASSET}"; \
      echo "expected: ${EXPECTED}"; \
      echo "actual:   ${ACTUAL}"; \
      exit 1; \
    fi; \
    echo "sha256 OK"; \
    gunzip mihomo.gz; \
    chmod +x mihomo; \
    ./mihomo -v

# ─── Node 依赖构建层 ──────────────────────────────────────────
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 是原生模块；保留编译工具在构建层，运行层不带
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ─── 运行层 ──────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/accounts.db \
    MIHOMO_PATH=/usr/local/bin/mihomo \
    MIHOMO_ENABLED=true

WORKDIR /app

RUN mkdir -p /data \
  && chown -R node:node /app /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=mihomo-downloader --chown=root:root /tmp/mihomo /usr/local/bin/mihomo
COPY --chown=node:node . .

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
