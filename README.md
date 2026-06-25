# Stagewise 2api

> Stagewise API 逆向代理 — 将 [Stagewise](https://stagewise.io) 接口转换为 OpenAI 兼容格式，支持多账号池管理、自动注册、额度监控。

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## ✨ 功能特性

- 🔄 **OpenAI 兼容 API** — 直接对接 ChatGPT-Next-Web、LobeChat、OpenCat 等客户端
- 👥 **多账号池** — SQLite 存储，轮询调度，自动故障切换（连续错误 3 次自动跳过，5 分钟冷却）
- 🤖 **自动注册** — 接入 GPTMail / CFMail 临时邮箱，一键批量注册 Stagewise 账号（单次最多 1000 个）
- 💰 **额度监控** — 实时查看日/周/月配额使用情况，5 分钟 SQLite 缓存，减少 API 调用
- 📊 **Material Design 3 前端** — Google 风格管理面板，进度条可视化配额
- 🧪 **API 测试** — 内置 44 个模型测试，按厂商分组
- 🔐 **System Prompt 自动注入** — 注入 5515 字符验证 prompt，绕过 Stagewise 401 限制
- ⚙️ **在线配置** — 邮箱 Provider、API 地址和 Key 可在前端"设置"页面修改，保存到数据库，无需重启

## 📦 支持模型（44 个）

| 厂商 | 数量 | 模型列表 |
|------|------|----------|
| 🟣 Anthropic | 10 | Claude Fable 5, Mythos 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 |
| 🟢 OpenAI | 11 | GPT-5.5/5.4/5.4-mini/5.4-nano/5.3-codex/5.3-chat/5.2/5.1/5/5-chat/5-nano |
| 🔵 Google | 6 | Gemini 3.1-pro-preview/3.5-flash/3-pro/3-flash-preview/3.1-flash-lite/2.5 |
| 🟠 DeepSeek | 2 | V4-pro, V4-flash |
| 🌙 Kimi | 4 | K2.7-code, K2.6, K2.5, Plan |
| 🔶 Qwen | 3 | Qwen3-coder-30b, Plan, Turbo |
| ⚡ GLM | 5 | GLM-5.2/5.1/5v-turbo/4.5-flash, Coding-plan |
| 🔷 MiniMax | 3 | M3, M2.7, Plan |

## 🚀 快速开始

### 环境要求

- Node.js >= 20
- npm

### 安装

```bash
# 解压
tar xzf stagewise-2api.tar.gz
cd stagewise-2api

# 安装依赖
npm install

# 复制并编辑配置（可选，也可在前端"设置"页面配置）
cp .env.example .env
# vim .env

# 启动
npm start        # 生产模式
# 或
npm run dev      # 开发模式（热重载）
```

### 访问

- **管理面板**: http://localhost:3000/dashboard
- **API 端点**: http://localhost:3000/v1
- **健康检查**: http://localhost:3000/healthz

## ☁️ Zeabur 部署

适配已就绪：仓库已内置 `Dockerfile`，并提供 GitHub Actions 自动构建镜像到 GHCR。服务默认监听 `0.0.0.0`，数据库路径支持 `DB_PATH` / `DATA_DIR` 注入，提供 `/healthz` 探活端点，并内置公网管理鉴权。

### 推荐：Zeabur 直接拉 GHCR 镜像

如果 Zeabur 源码构建触发风控，推荐让 GitHub Actions 构建镜像，然后 Zeabur 只拉镜像运行。

镜像地址：

```text
ghcr.io/youzini-afk/stagewise-2api:latest
```

GitHub Actions 会在以下情况推送镜像：

- push 到 `main`：推送 `latest` 和 `sha-<commit>` 标签
- push `v*` tag：推送对应版本标签
- 手动运行 workflow：Actions → Build Docker image → Run workflow

Zeabur 操作：

1. Zeabur → New Service → Docker Image / Container Image
2. Image 填：`ghcr.io/youzini-afk/stagewise-2api:latest`
3. 挂载 Volume：`/data`
4. 设置环境变量：
   - `DB_PATH=/data/accounts.db`
   - `ADMIN_TOKEN=一串足够长的随机密码`
   - `PROXY_API_KEY=给 OpenAI 客户端使用的 API Key`
   - `MAIL_PROVIDER=`、`MAIL_URL=`、`MAIL_TOKEN=` 或 `CFMAIL_*`（按需）
5. Health Check Path：`/healthz`

> 如果 GHCR 包是 private，Zeabur 拉取会需要镜像凭证。建议在 GitHub 仓库 Packages 页面把 `stagewise-2api` package visibility 改为 Public，或在 Zeabur 配置 GHCR 账号/Token。

### 备选：Zeabur 从源码构建

1. 在 Zeabur 控制台 → New Project → 通过 GitHub 仓库导入本项目
2. Zeabur 检测到仓库根目录的 `Dockerfile` / `zbpack.json` 后，会按 Docker 镜像构建部署
3. 平台自动注入 `PORT`，无需手动设置；容器已固定监听 `0.0.0.0`
4. 挂载持久化 Volume（强烈建议，否则重启丢数据）：
   - Volumes → Add Volume → 挂载路径填 `/data`
5. 设置环境变量：
   - `DB_PATH=/data/accounts.db`
   - `ADMIN_TOKEN=一串足够长的随机密码`（必填，用于登录 WebUI）
   - `PROXY_API_KEY=给 OpenAI 客户端使用的 API Key`（公网部署强烈建议，防止陌生人消耗账号池）
   - `STAGEWISE_TOKEN=`、`MAIL_PROVIDER=`、`MAIL_URL=`、`MAIL_TOKEN=` 或 `CFMAIL_*`（按需）
6. Networking → 生成域名（如 `stagewise-2api.zeabur.app`）
7. Health Check 配置：
   - **Path**：`/healthz`
   - 探活会实际 `SELECT 1`，数据库异常时返回 503，平台自动重启实例

如果构建计划预览仍显示 `nodejs/npm`，在 Zeabur 配置里这样处理：

| 项 | 值 |
|----|----|
| Root Directory | `/` |
| 环境变量 | `ZBPACK_DOCKERFILE_PATH=Dockerfile` |

不要勾选“使用 AI Dockerfile 生成器”，本仓库已经提供固定的 `Dockerfile`。

### 部署后访问

- WebUI 管理面板：`https://<your-app>.zeabur.app/dashboard`
- OpenAI 兼容 Base URL：`https://<your-app>.zeabur.app/v1`
- 健康检查：`https://<your-app>.zeabur.app/healthz`

WebUI 首次打开会要求输入 `ADMIN_TOKEN`。Token 只保存在浏览器 `localStorage`，可点右上角“退出”清除。

### Zeabur 配置临时邮箱 Provider

自动注册默认使用 GPTMail；如需使用 CFMail Worker，在 Zeabur 环境变量中设置（以下均为占位示例，不要把真实 Key 提交到仓库）：

| 变量 | 示例 |
|------|------|
| `MAIL_PROVIDER` | `cfmail` |
| `CFMAIL_API_BASE` | `https://your-cfmail-worker.example.workers.dev` |
| `CFMAIL_API_KEY` | `replace-with-your-cfmail-admin-key` |
| `CFMAIL_DOMAINS` | `example.com,example.net` |

CFMail 默认管理员认证 Header 为 `x-admin-auth: <CFMAIL_API_KEY>`，邮箱读取认证 Header 为 `Authorization: Bearer <mailbox_token>`。如果你的 Worker 路径或 Header 不同，可按需设置 `CFMAIL_ADMIN_AUTH_HEADER`、`CFMAIL_ADMIN_AUTH_SCHEME`、`CFMAIL_MAILBOX_AUTH_HEADER`、`CFMAIL_MAILBOX_AUTH_SCHEME`、`CFMAIL_CREATE_ENDPOINT`、`CFMAIL_LIST_ENDPOINT`、`CFMAIL_HEALTH_ENDPOINT`。

> WebUI 设置会保存到 SQLite，优先级高于 Zeabur 环境变量。若已在 WebUI 保存过邮箱配置，之后修改 Zeabur 环境变量可能不会覆盖它；请在 WebUI 重新保存，或删除对应 settings 记录。

OpenAI 客户端建议这样填：

| 配置项 | 值 |
|--------|----|
| Base URL | `https://<your-app>.zeabur.app/v1` |
| API Key | `PROXY_API_KEY` 的值 |

如果你不设置 `PROXY_API_KEY`，公网任何人都可能调用接口消耗账号池，不建议这样部署。

### 数据持久化

| 项 | 推荐值 |
|----|--------|
| Volume 挂载点 | `/data` |
| `DB_PATH` | `/data/accounts.db` |
| 备份对象 | `/data/accounts.db` 及其 `-wal` / `-shm` 文件 |

> 提示：未挂载 Volume 时数据库会写入容器临时层，重启即丢。务必按上表挂载 `/data`。

### 本地 Docker 运行

```bash
docker build -t stagewise-2api .

docker run --rm -p 3000:3000 \
  -e ADMIN_TOKEN=change-me \
  -e PROXY_API_KEY=sk-local-test \
  -e DB_PATH=/data/accounts.db \
  -v stagewise-2api-data:/data \
  stagewise-2api
```

访问：

- WebUI：`http://localhost:3000/dashboard`
- 健康检查：`http://localhost:3000/healthz`

## 📖 使用方式

### 作为 OpenAI API 代理

在任意支持 OpenAI API 的客户端中，将 Base URL 改为：

```
http://localhost:3000/v1
```

**curl 示例：**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**Python OpenAI SDK：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="not-needed"  # 使用账号池或 .env 中的 token
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}]
)
print(response.choices[0].message.content)
```

**ChatGPT-Next-Web / LobeChat：**

在设置中填写：
- API 地址：`http://localhost:3000/v1`
- API Key：如果设置了 `PROXY_API_KEY`，填它；否则可填任意值（或 `not-needed`）

### Token 来源优先级

1. **请求头** `Authorization: Bearer <token>` — 最高优先
2. **账号池轮询** — 自动选取可用账号（推荐，无需手动管理 token）
3. **.env 默认 Token** — 回退方案

## 📡 API 端点

### OpenAI 兼容

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 聊天补全 |
| GET | `/v1/models` | 模型列表（44 个） |

### 账号池管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/pool` | 列出所有账号 |
| POST | `/v1/pool` | 添加账号（body: `{email, token, name?}`） |
| GET | `/v1/pool/stats` | 账号池统计 |
| PATCH | `/v1/pool/:email` | 启用/禁用账号（body: `{isActive}`） |
| DELETE | `/v1/pool/:email` | 删除账号 |

### 添加账号（引导式）

前端"账号池"页面提供 3 步引导流程：

1. 输入邮箱 → 点"发送验证码"
2. 输入邮箱收到的 6 位码 → 点"验证并添加"（自动获取 token 入库）
3. 成功提示，可继续添加

对应 API：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/auth/login` | 发送邮箱验证码（body: `{email}`） |
| POST | `/v1/auth/verify` | 验证并获取 Token（body: `{email, code}`） |

### 自动注册

通过当前临时邮箱 Provider（GPTMail 或 CFMail）自动注册 Stagewise 账号，注册成功后自动加入账号池。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/register/auto` | 注册单个账号（body: `{prefix?, maxWait?}`） |
| POST | `/v1/register/batch` | 批量注册（body: `{count: 100, concurrency?: 1, delayMs?: 3000, maxWait?: 60000}`，count 上限 1000） |
| POST | `/v1/register/stop` | 停止当前自动注册任务 |
| GET | `/v1/register/status` | 查看当前或最近一次自动注册任务状态（含 params/progress/logs/results/summary，可用于刷新恢复与实时进度） |
| GET | `/v1/register/domains` | 获取当前 Provider 与可用邮箱域名（返回 `{ provider, domains }`） |

**流程：** 创建临时邮箱 → 发送 Stagewise OTP → 轮询收件箱 → 获取验证码 → 完成验证 → 自动加入账号池

批量注册默认串行执行（`concurrency=1`），并按全局账号启动时间间隔 `3000ms` 限速，用于降低 Stagewise 频率限制风险。可按需调高并发（1-5），但并发过高仍可能触发 429 Too many requests。

`GET /v1/register/status` 在任务运行期间会返回实时 `progress`（已启动/完成/成功/失败/停止/总数）、带 `index` 的 `logs`（最近 1000 条）、`results` 数组与 `params`。WebUI 注册开始后会每秒轮询该接口展示进度；刷新页面后会自动恢复正在运行任务的按钮、日志与进度，继续轮询直到任务结束。日志不会记录 token / api_key。

WebUI 自动注册开始后可点击“停止”，后端会通过 `/v1/register/stop` 取消当前任务；已成功加入账号池的账号不会被删除。

### 额度查询

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/usage` | 单账号用量（使用当前 token） |
| GET | `/v1/usage/pool` | 账号池额度汇总（分页，5 分钟缓存） |
| GET | `/v1/usage/pool?page=1&pageSize=20` | 分页查询当前页活跃账号（pageSize 1-100，默认 20） |
| GET | `/v1/usage/pool?refresh=true&page=1&pageSize=20` | 强制刷新当前页（绕过缓存，仍受并发/超时限制） |

额度查询按分页执行：`page`（默认 1）与 `pageSize`（默认 20，最大 100）。接口只查询当前页活跃账号（`ORDER BY id ASC LIMIT ? OFFSET ?`），summary 返回 `totalAccounts`（全量）、`totalPages`、`page`、`pageSize`、`pageAccounts`，以及本页的 `success/failed/timeout/elapsedMs/updatedAt`。单账号查询带 12s 超时、并发上限 5，慢账号不阻塞其它账号。

### 代理池

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/proxy-pool` | 代理池概览（启用状态、策略、节点列表，URL 脱敏只显示 host:port） |
| POST | `/v1/proxy-pool/nodes` | 添加节点 `body:{url, name?}` |
| DELETE | `/v1/proxy-pool/nodes/:id` | 删除节点 |
| POST | `/v1/proxy-pool/nodes/:id/toggle` | 启停 `body:{disabled}` |
| POST | `/v1/proxy-pool/nodes/:id/test` | 测试节点连通性（10s 超时） |
| POST | `/v1/proxy-pool/import` | 批量导入 `body:{text}`（按行/逗号拆分） |
| PUT | `/v1/proxy-pool/settings` | 更新设置 `body:{enabled?, strategy?}` |

代理池在**自动注册**时生效：每次注册开始时按策略（`round-robin` 轮询 / `random` 随机）选一个未禁用且未冷却的代理，把 dispatcher 注入到创建邮箱、发送 OTP、收取验证码、验证 OTP 的每一步 fetch。注册成功/失败后调用 `recordProxyResult` 更新健康度；失败节点按指数退避冷却（30s 起，2^(n-1) 倍增，上限 30 分钟）。

- 仅支持 `http://`、`https://`、`socks5://` 代理 URL（基于 undici `ProxyAgent` / `Socks5ProxyAgent`，纯 JS 无 native 编译）。
- **不支持** ss/vmess/trojan（需 mihomo 等本地客户端转为 socks5 后再用本代理池）。
- 代理池禁用或池空时，降级到 `PROXY_URL`；两者都无则直连。
- 节点 URL 含凭证会存入 SQLite（脱敏只在展示/日志层进行，存储是必要的）。
- 日志只显示 `host:port`，不显示用户名密码。

### 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/settings/mail` | 获取邮箱 Provider 与 API 配置（token/apiKey 脱敏） |
| POST | `/v1/settings/mail` | 保存邮箱 API 配置（支持 `{provider,gptmail,cfmail}`，兼容旧 `{url, token}`） |

`GET /v1/settings/mail` 会返回类似结构：

```json
{
  "provider": "cfmail",
  "gptmail": { "url": "https://mail.chatgpt.org.uk", "token": "sk-****abcd", "tokenLength": 32 },
  "cfmail": {
    "apiBase": "https://your-cfmail-worker.example.workers.dev",
    "apiKey": "abcd****wxyz",
    "apiKeyLength": 40,
    "domains": ["example.com"],
    "adminAuthHeader": "x-admin-auth",
    "adminAuthScheme": "raw",
    "mailboxAuthHeader": "Authorization",
    "mailboxAuthScheme": "bearer",
    "createEndpoint": "/admin/new_address",
    "listEndpoint": "/api/mails",
    "healthEndpoint": "/healthz"
  }
}
```

保存时 `token` / `apiKey` 留空表示保留旧值；不要提交带 `****` 的脱敏值。

## 🏗️ 项目结构

```
stagewise-2api/
├── config.js                        # 全局配置
├── src/
│   └── index.js                     # 入口 & 路由注册
├── middleware/
│   └── auth.js                      # Token 提取、管理鉴权、代理 API Key 防滥用
├── routes/
│   ├── health.js                    # 健康检查
│   ├── auth.js                      # 认证端点
│   ├── pool.js                      # 账号池管理
│   ├── usage.js                     # 额度查询
│   ├── register.js                  # 自动注册
│   └── settings.js                  # 设置管理
├── services/
│   ├── account-pool.js              # 账号池逻辑（SQLite）
│   ├── auth.js                      # Stagewise Auth 封装
│   ├── auto-register.js             # 自动注册流程
│   ├── cfmail.js                    # CFMail Worker 临时邮箱 API
│   ├── gptmail.js                   # GPTMail 临时邮箱 API
│   ├── mail-provider.js             # 临时邮箱 Provider 统一适配层
│   ├── models.js                    # 模型列表（44 个）
│   ├── proxy.js                     # 请求转发核心（含 system prompt 注入）
│   ├── settings.js                  # 设置持久化（SQLite）
│   ├── stagewise-system-prompt.js   # 验证 prompt（5515 字符）
│   └── usage.js                     # 用量查询 + 5 分钟缓存
├── db/
│   └── database.js                  # SQLite 初始化（accounts, usage_history, settings）；支持 DB_PATH / DATA_DIR
├── public/
│   └── index.html                   # Material Design 3 管理面板
├── data/                            # 默认 SQLite 数据目录（git-ignored，Zeabur 上改用 /data）
├── .env                             # 环境变量（git-ignored）
├── .env.example                     # 配置模板
└── package.json
```

## ⚙️ 配置说明

### .env 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口（Zeabur 平台自动注入，请勿固定） | `3000` |
| `DB_PATH` | SQLite 数据库文件绝对路径，最高优先级 | 空（默认 `../data/accounts.db`） |
| `DATA_DIR` | 数据目录；未设 `DB_PATH` 时使用 `${DATA_DIR}/accounts.db` | 空 |
| `ADMIN_TOKEN` | 管理后台 Token；保护 WebUI 管理操作和管理 API | 空（管理接口返回 503） |
| `PROXY_API_KEY` | OpenAI 客户端 API Key；设置后必须带此 Key 才能使用账号池 / `.env` 默认 token | 空 |
| `API_KEY` | `PROXY_API_KEY` 的兼容别名 | 空 |
| `STAGEWISE_LLM_URL` | Stagewise LLM 网关 | `https://api.stagewise.io/v1/ai` |
| `STAGEWISE_API_URL` | Stagewise API 地址 | `https://api.stagewise.io` |
| `STAGEWISE_TOKEN` | 默认 Bearer Token | 空 |
| `MAIL_PROVIDER` | 临时邮箱 Provider，可选 `gptmail` / `cfmail` | `gptmail` |
| `MAIL_URL` | 临时邮箱 API 地址 | `https://mail.chatgpt.org.uk` |
| `MAIL_TOKEN` | 临时邮箱 API Key | 空 |
| `CFMAIL_API_BASE` | CFMail Worker API Base（占位示例：`https://your-cfmail-worker.example.workers.dev`） | 空 |
| `CFMAIL_API_KEY` | CFMail 管理 API Key（请用真实环境变量，不要写入仓库） | 空 |
| `CFMAIL_DOMAINS` | CFMail 可用域名，逗号分隔；未设置时尝试从 Worker 根路径发现 | 空 |
| `CFMAIL_ADMIN_AUTH_HEADER` | CFMail 创建邮箱管理员认证 Header | `x-admin-auth` |
| `CFMAIL_ADMIN_AUTH_SCHEME` | CFMail 创建邮箱管理员认证 Scheme：`raw` / `bearer` / 自定义前缀 | `raw` |
| `CFMAIL_MAILBOX_AUTH_HEADER` | CFMail 读取邮件认证 Header | `Authorization` |
| `CFMAIL_MAILBOX_AUTH_SCHEME` | CFMail 读取邮件认证 Scheme | `bearer` |
| `CFMAIL_CREATE_ENDPOINT` | CFMail 创建邮箱 Endpoint | `/admin/new_address` |
| `CFMAIL_LIST_ENDPOINT` | CFMail 读取邮件 Endpoint | `/api/mails` |
| `CFMAIL_HEALTH_ENDPOINT` | CFMail 健康检查 Endpoint | `/healthz` |
| `PROXY_POOL_ENABLED` | 启用代理池（自动注册时按轮询/随机选代理） | `false` |
| `PROXY_POOL_URLS` | 代理 URL 列表（逗号或换行分隔，DB 无节点时种子导入；示例占位 `http://host:port,socks5://host:port`） | 空 |
| `PROXY_POOL_STRATEGY` | 代理池策略：`round-robin` 或 `random` | `round-robin` |
| `PROXY_URL` | 降级代理（代理池关闭或空时使用；可为空即直连） | 空 |

> 数据库路径解析顺序：`DB_PATH` > `DATA_DIR/accounts.db` > 项目内 `../data/accounts.db`。父目录不存在时会自动 `mkdirSync(..., { recursive: true })`。

> 健康检查 `/healthz` 实际执行 `SELECT 1 AS ok` 探活 SQLite，正常返回 200，异常返回 503。

### 前端在线配置

访问 http://localhost:3000/dashboard → 输入 `ADMIN_TOKEN` 登录 → "设置" 标签页，可在线选择 GPTMail / CFMail，配置 API 地址、Key、域名和 CFMail 高级 Header/Endpoint，保存到 SQLite 数据库，无需重启服务。Key 留空表示保留原配置；前端和接口只显示脱敏值与长度。

## ⚠️ 注意事项

- **System Prompt 注入**：Stagewise 后端会验证 system prompt 内容，本代理会自动注入 5515 字符的验证 prompt，无需客户端额外处理
- **账号池调度**：采用轮询 + 故障自动跳过机制，连续错误 > 3 次的账号会被跳过 5 分钟
- **额度缓存**：5 分钟 SQLite 缓存，避免频繁调用 Stagewise 用量 API
- **自动注册**：依赖外部临时邮箱服务（GPTMail 或 CFMail），请确保 API Key 有效且有足够配额
- **Token 安全**：前端显示 token 时会自动脱敏，只显示前 4 位和后 4 位
- **公网安全**：Zeabur 等公网部署必须设置 `ADMIN_TOKEN`；强烈建议设置 `PROXY_API_KEY`

## 🛠️ 常见问题

**Q: 调用返回 401？**
A: 如果设置了 `PROXY_API_KEY`，客户端 API Key 必须填它；否则检查账号池或 `.env` 中的 `STAGEWISE_TOKEN` 是否有效。

**Q: WebUI 提示管理接口未启用？**
A: 环境变量里没有设置 `ADMIN_TOKEN`，设置后重启服务。

**Q: 自动注册失败？**
A: 检查前端"设置"页面中当前临时邮箱 Provider（GPTMail 或 CFMail）的 API 地址、API Key、域名是否正确且有配额。CFMail 还需要确认 Worker 支持创建邮箱返回邮箱 token，并能用该 token 拉取邮件。

**Q: 额度显示不准确？**
A: 点击"强制刷新"按钮绕过 5 分钟缓存，从 Stagewise API 实时获取。

**Q: 如何获取 Stagewise Token？**
A: 在前端"账号池"页面，输入 Stagewise 注册邮箱，按引导流程发送验证码并验证即可。

## 📄 License

MIT
