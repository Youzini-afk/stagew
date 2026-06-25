/**
 * CFMail Worker 临时邮箱 API 封装
 *
 * 默认适配接口：
 *   GET  /                         — 发现服务信息与 allowed_domains
 *   GET  /healthz                  — 健康检查（可配置）
 *   POST /admin/new_address        — 创建邮箱，Header: x-admin-auth: <api_key>
 *   GET  /api/mails?limit=20&offset=0 — 拉取邮件，Header: Authorization: Bearer <mailbox token>
 */

import { getCfMailConfig } from './settings.js';

let cachedDiscovery = null;

function createAbortError() {
  const err = new Error('注册已停止');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function abortableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeDomains(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeEndpoint(value, fallback) {
  const endpoint = String(value || fallback || '').trim();
  return endpoint || fallback;
}

function buildUrl(base, endpoint = '/', query = {}) {
  const ep = normalizeEndpoint(endpoint, '/');
  const url = /^https?:\/\//i.test(ep)
    ? new URL(ep)
    : new URL(`${cleanBaseUrl(base)}/${ep.replace(/^\/+/, '')}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    return value;
  }
  return null;
}

function sanitizeMessage(message, cfg = getCfMailConfig(), extraSecrets = []) {
  let text = String(message || '');
  const secrets = [cfg.apiKey, ...extraSecrets].filter(Boolean);
  for (const secret of secrets) {
    text = text.split(secret).join('[secret]');
  }
  return text;
}

function publicErrorFromPayload(data, fallback) {
  return firstNonEmpty(
    data?.error,
    data?.message,
    data?.data?.error,
    data?.data?.message,
    fallback
  );
}

async function requestJson(url, options, cfg, extraSecrets = []) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`CFMail 请求失败: ${sanitizeMessage(err.message, cfg, extraSecrets)}`);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`CFMail 响应不是有效 JSON (HTTP ${res.status})`);
    }
  }

  if (!res.ok) {
    const detail = publicErrorFromPayload(data, `HTTP ${res.status}`);
    throw new Error(`CFMail 请求失败: ${sanitizeMessage(detail, cfg, extraSecrets)}`);
  }
  return data;
}

function assertSuccess(data, fallback, cfg, extraSecrets = []) {
  if (data && data.success === false) {
    throw new Error(sanitizeMessage(publicErrorFromPayload(data, fallback), cfg, extraSecrets));
  }
}

function authHeader(headerName, scheme, secret) {
  const header = String(headerName || '').trim();
  if (!header || !secret) return {};

  const normalized = String(scheme || 'raw').trim().toLowerCase();
  let value;
  if (!normalized || normalized === 'raw' || normalized === 'none') {
    value = secret;
  } else if (normalized === 'bearer') {
    value = `Bearer ${secret}`;
  } else {
    value = `${scheme} ${secret}`;
  }
  return { [header]: value };
}

function extractAllowedDomains(data) {
  const domains = firstNonEmpty(
    data?.config?.allowed_domains,
    data?.allowed_domains,
    data?.domains,
    data?.data?.config?.allowed_domains,
    data?.data?.allowed_domains,
    data?.data?.domains
  );
  return normalizeDomains(domains);
}

function extractAddress(data) {
  return firstNonEmpty(
    data?.address,
    data?.email,
    typeof data?.mailbox === 'string' ? data.mailbox : null,
    data?.mailbox?.address,
    data?.mailbox?.email,
    data?.data?.address,
    data?.data?.email,
    typeof data?.data?.mailbox === 'string' ? data.data.mailbox : null,
    data?.data?.mailbox?.address,
    data?.data?.mailbox?.email
  );
}

function extractMailboxToken(data) {
  return firstNonEmpty(
    data?.jwt,
    data?.token,
    data?.mailbox_token,
    data?.mailboxToken,
    data?.mailbox?.jwt,
    data?.mailbox?.token,
    data?.mailbox?.mailbox_token,
    data?.mailbox?.mailboxToken,
    data?.data?.jwt,
    data?.data?.token,
    data?.data?.mailbox_token,
    data?.data?.mailboxToken,
    data?.data?.mailbox?.jwt,
    data?.data?.mailbox?.token,
    data?.data?.mailbox?.mailbox_token,
    data?.data?.mailbox?.mailboxToken
  );
}

function normalizeMailbox(mailboxOrObject) {
  if (!mailboxOrObject) return {};
  if (typeof mailboxOrObject === 'string') {
    const value = mailboxOrObject.trim();
    return value.includes('@') ? { email: value } : { token: value };
  }

  return {
    email: firstNonEmpty(
      mailboxOrObject.email,
      mailboxOrObject.address,
      typeof mailboxOrObject.mailbox === 'string' ? mailboxOrObject.mailbox : null,
      mailboxOrObject.mailbox?.address,
      mailboxOrObject.mailbox?.email
    ),
    token: firstNonEmpty(
      mailboxOrObject.token,
      mailboxOrObject.jwt,
      mailboxOrObject.mailbox_token,
      mailboxOrObject.mailboxToken,
      mailboxOrObject.mailbox?.token,
      mailboxOrObject.mailbox?.jwt,
      mailboxOrObject.mailbox?.mailbox_token,
      mailboxOrObject.mailbox?.mailboxToken
    ),
  };
}

function extractMailArray(data) {
  const candidates = [
    data?.results,
    data?.mails,
    data?.emails,
    data?.data,
    data?.data?.results,
    data?.data?.mails,
    data?.data?.emails,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ');
}

function decodeQuotedPrintable(text) {
  return String(text || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractRawBody(raw) {
  const text = String(raw || '');
  const parts = text.split(/\r?\n\r?\n/);
  return parts.length > 1 ? parts.slice(1).join('\n\n') : text;
}

const INVALID_VERIFICATION_CODES = new Set(['000000', '111111', '123456', '654321']);
const CODE_KEYWORDS = 'stagewise|verification|verify|code|otp|验证码|驗證碼|校验码|驗證|验证';

function isValidVerificationCode(code) {
  return /^\d{6}$/.test(code) && !INVALID_VERIFICATION_CODES.has(code);
}

function normalizeSearchText(text) {
  return stripHtml(decodeQuotedPrintable(text))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findContextualCode(text) {
  const normalized = normalizeSearchText(text);
  if (!normalized) return null;

  const re = new RegExp(
    `(?:${CODE_KEYWORDS})[\\s\\S]{0,120}?(\\d{6})|(\\d{6})[\\s\\S]{0,120}?(?:${CODE_KEYWORDS})`,
    'gi'
  );
  let match;
  while ((match = re.exec(normalized))) {
    const code = match[1] || match[2];
    if (isValidVerificationCode(code)) return code;
  }
  return null;
}

function findUniquePlainCode(text) {
  const normalized = normalizeSearchText(text);
  if (!normalized) return null;

  const codes = new Set();
  const re = /(?:^|\D)(\d{6})(?!\d)/g;
  let match;
  while ((match = re.exec(normalized))) {
    if (isValidVerificationCode(match[1])) codes.add(match[1]);
  }
  return codes.size === 1 ? [...codes][0] : null;
}

function findCodeWithSource(fields, { allowPlain = true } = {}) {
  const normalizedFields = fields
    .map(field => ({ name: field.name, value: normalizeSearchText(field.value) }))
    .filter(field => field.value);

  // 优先匹配带语义上下文的验证码，避免从日期、Message-ID、占位内容中误取 000000。
  for (const field of normalizedFields) {
    const code = findContextualCode(field.value);
    if (code) return { code, field: field.name };
  }

  const combined = normalizedFields.map(field => field.value).join(' ');
  const contextual = findContextualCode(combined);
  if (contextual) return { code: contextual, field: 'combined' };

  // 非 raw 正文字段允许唯一 6 位数字兜底；raw 应传 allowPlain=false，避免盲扫 MIME 元数据。
  if (allowPlain) {
    for (const field of normalizedFields) {
      const code = findUniquePlainCode(field.value);
      if (code) return { code, field: field.name };
    }
    const plain = findUniquePlainCode(combined);
    if (plain) return { code: plain, field: 'combined' };
  }

  return { code: null, field: null };
}

export function extractCode(...parts) {
  const fields = parts.flat().map((part, index) => ({ name: `part${index + 1}`, value: part }));
  return findCodeWithSource(fields, { allowPlain: true }).code;
}

function normalizeEmail(mail) {
  const source = typeof mail?.source === 'object' && mail.source ? mail.source : {};
  const sourceText = typeof mail?.source === 'string' ? mail.source : '';
  const subject = firstNonEmpty(mail?.subject, source.subject) || '';
  const sender = firstNonEmpty(
    mail?.sender,
    mail?.from,
    mail?.from_address,
    source.sender,
    source.from,
    source.from_address
  );
  const text = firstNonEmpty(mail?.text, source.text);
  const html = firstNonEmpty(mail?.html, source.html);
  const content = firstNonEmpty(mail?.content, mail?.body, source.content, source.body);
  const raw = firstNonEmpty(mail?.raw, source.raw, sourceText);
  const createdAt = firstNonEmpty(mail?.created_at, mail?.received_at, mail?.date, source.created_at, source.date);
  const codeMatch = findCodeWithSource([
    { name: 'subject', value: subject },
    { name: 'text', value: text },
    { name: 'html', value: html },
    { name: 'content', value: content },
  ], { allowPlain: true });
  const rawCodeMatch = codeMatch.code
    ? { code: null, field: null }
    : findCodeWithSource([{ name: 'raw', value: extractRawBody(raw) }], { allowPlain: false });
  const verificationCode = codeMatch.code || rawCodeMatch.code;
  const matchedField = codeMatch.field || rawCodeMatch.field;

  return {
    id: firstNonEmpty(mail?.id, mail?.message_id, source.id, source.message_id) || `${sender || 'mail'}-${subject}-${createdAt || ''}`,
    sender,
    subject,
    preview: String(firstNonEmpty(text, content, stripHtml(html), raw, '') || '').substring(0, 200),
    verification_code: verificationCode,
    matched_field: matchedField,
    text_length: String(text || '').length,
    html_length: String(html || '').length,
    content_length: String(content || '').length,
    raw_length: String(raw || '').length,
    received_at: createdAt,
  };
}

export function clearDomainCache() {
  cachedDiscovery = null;
}

/**
 * 检查 CFMail Worker 健康状态，同时尝试读取声明的 allowed_domains。
 */
export async function checkHealth(opts = {}) {
  const cfg = getCfMailConfig();
  const base = cleanBaseUrl(cfg.apiBase);
  if (!base) {
    throw new Error('CFMail 未配置 api_base，请设置 CFMAIL_API_BASE 或在设置页保存 API Base');
  }

  const reqOpts = {
    method: 'GET',
    headers: { Accept: 'application/json' },
  };
  if (opts.dispatcher) reqOpts.dispatcher = opts.dispatcher;
  const data = await requestJson(buildUrl(base, cfg.healthEndpoint), reqOpts, cfg);
  assertSuccess(data, 'CFMail 健康检查失败', cfg);

  const domains = extractAllowedDomains(data);
  if (domains.length > 0) {
    cachedDiscovery = { apiBase: base, domains };
  }
  return { ok: true, domains };
}

/**
 * 获取域名列表：优先使用配置，其次从 Worker 根路径发现 config.allowed_domains。
 */
export async function getDomains(opts = {}) {
  const cfg = getCfMailConfig();
  if (cfg.domains && cfg.domains.length > 0) return cfg.domains;

  const base = cleanBaseUrl(cfg.apiBase);
  if (!base) {
    throw new Error('CFMail 未配置 api_base 或 domains，请设置 CFMAIL_API_BASE/CFMAIL_DOMAINS 或在设置页保存配置');
  }

  if (cachedDiscovery && cachedDiscovery.apiBase === base) {
    return cachedDiscovery.domains;
  }

  const reqOpts = { method: 'GET', headers: { Accept: 'application/json' } };
  if (opts.dispatcher) reqOpts.dispatcher = opts.dispatcher;
  const data = await requestJson(`${base}/`, reqOpts, cfg);
  const domains = extractAllowedDomains(data);
  cachedDiscovery = { apiBase: base, domains };
  return domains;
}

/**
 * 创建邮箱。返回 { email, token, provider: 'cfmail' }。
 */
export async function createMailbox(prefix = null, domain = null, opts = {}) {
  const { signal, dispatcher } = opts;
  throwIfAborted(signal);
  const cfg = getCfMailConfig();
  const base = cleanBaseUrl(cfg.apiBase);
  if (!base) {
    throw new Error('CFMail 未配置 api_base，请设置 CFMAIL_API_BASE 或在设置页保存 API Base');
  }
  if (!cfg.apiKey) {
    throw new Error('CFMail 未配置 api_key，请设置 CFMAIL_API_KEY 或在设置页保存 API Key');
  }

  const domains = await getDomains(opts);
  const selectedDomain = domain || domains[0];
  if (!selectedDomain) {
    throw new Error('CFMail 未配置 domains，且无法从 Worker 发现 config.allowed_domains');
  }

  const body = { enablePrefix: false, domain: selectedDomain };
  if (prefix) body.name = prefix;

  const reqOpts = {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeader(cfg.adminAuthHeader, cfg.adminAuthScheme, cfg.apiKey),
    },
    body: JSON.stringify(body),
  };
  if (dispatcher) reqOpts.dispatcher = dispatcher;
  const data = await requestJson(buildUrl(base, cfg.createEndpoint), reqOpts, cfg);
  throwIfAborted(signal);
  assertSuccess(data, '创建邮箱失败', cfg);

  const email = extractAddress(data);
  const token = extractMailboxToken(data);
  if (!email) throw new Error('CFMail 创建邮箱响应缺少 address/email 字段');
  if (!token) throw new Error('CFMail 创建邮箱响应缺少邮箱 token/jwt 字段');

  return { email, token, provider: 'cfmail' };
}

/**
 * 获取邮件列表。CFMail 必须使用 createMailbox 返回的邮箱 token。
 */
export async function getEmails(mailboxOrObject, limit = 20, opts = {}) {
  const { signal, dispatcher } = opts;
  throwIfAborted(signal);
  const cfg = getCfMailConfig();
  const base = cleanBaseUrl(cfg.apiBase);
  if (!base) {
    throw new Error('CFMail 未配置 api_base，请设置 CFMAIL_API_BASE 或在设置页保存 API Base');
  }

  const mailbox = normalizeMailbox(mailboxOrObject);
  if (!mailbox.token) {
    throw new Error('CFMail 读取邮件需要邮箱 token，请传入 createMailbox 返回的邮箱对象');
  }

  const reqOpts = {
    method: 'GET',
    signal,
    headers: {
      Accept: 'application/json',
      ...authHeader(cfg.mailboxAuthHeader, cfg.mailboxAuthScheme, mailbox.token),
    },
  };
  if (dispatcher) reqOpts.dispatcher = dispatcher;
  const data = await requestJson(buildUrl(base, cfg.listEndpoint, { limit, offset: 0 }), reqOpts, cfg, [mailbox.token]);
  assertSuccess(data, '获取邮件失败', cfg, [mailbox.token]);

  return extractMailArray(data).slice(0, limit).map(normalizeEmail);
}

/**
 * 轮询等待 Stagewise 验证码邮件。
 */
export async function waitForVerificationCode(mailboxOrObject, opts = {}) {
  const { maxWait = 60000, interval = 3000, senderFilter, signal, dispatcher } = opts;
  const mailbox = normalizeMailbox(mailboxOrObject);
  const deadline = Date.now() + maxWait;
  const seenIds = new Set();
  let lastError = null;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const emails = await getEmails(mailboxOrObject, 20, { signal, dispatcher });
      throwIfAborted(signal);
      for (const email of emails) {
        const seenKey = [
          email.id || '',
          email.verification_code || '',
          email.text_length || 0,
          email.html_length || 0,
          email.content_length || 0,
          email.raw_length || 0,
        ].join(':');
        if (seenIds.has(seenKey)) continue;
        seenIds.add(seenKey);
        if (senderFilter && email.sender &&
            !email.sender.toLowerCase().includes(senderFilter.toLowerCase())) {
          continue;
        }
        if (email.verification_code) {
          return { code: email.verification_code, email };
        }
      }
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') throw err;
      if (/未配置|需要邮箱 token/.test(err.message)) throw err;
    }
    await abortableSleep(interval, signal);
  }

  const suffix = lastError ? `，最后错误: ${sanitizeMessage(lastError.message, getCfMailConfig(), [mailbox.token])}` : '';
  throw new Error(`等待验证码超时 (${maxWait / 1000}s)${suffix}`);
}
