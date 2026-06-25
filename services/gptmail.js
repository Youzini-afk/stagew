/**
 * GPTMail 临时邮箱 API 封装
 * https://mail.chatgpt.org.uk/zh/api
 *
 * 端点：
 *   GET/POST /api/generate-email  — 创建邮箱
 *   GET  /api/emails?email=...    — 获取邮件列表
 *   GET  /api/email/{id}          — 邮件详情
 *   DELETE /api/email/{id}        — 删除邮件
 *   DELETE /api/emails/clear?email=... — 清空邮箱
 *   GET  /api/stats               — 站点统计
 *
 * 认证：Header X-API-Key
 */

import { getMailConfig } from './settings.js';

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

function getHeaders() {
  const cfg = getMailConfig();
  return {
    'Content-Type': 'application/json',
    'X-API-Key': cfg.token,
  };
}

function getBaseUrl() {
  const cfg = getMailConfig();
  return cfg.url;
}

/**
 * 生成临时邮箱
 * GET = 随机生成; POST = 可指定 prefix/domain
 */
export async function createMailbox(prefix = null, domain = null, opts = {}) {
  const { signal, dispatcher } = opts;
  throwIfAborted(signal);
  const base = getBaseUrl();
  const headers = getHeaders();

  if (prefix || domain) {
    const body = {};
    if (prefix) body.prefix = prefix;
    if (domain) body.domain = domain;

    const fetchOpts = {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body),
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const res = await fetch(`${base}/api/generate-email`, fetchOpts);
    throwIfAborted(signal);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '创建邮箱失败');
    return { email: data.data.email, usage: data.usage, provider: 'gptmail' };
  }

  const fetchOpts = {
    method: 'GET',
    signal,
    headers,
  };
  if (dispatcher) fetchOpts.dispatcher = dispatcher;
  const res = await fetch(`${base}/api/generate-email`, fetchOpts);
  throwIfAborted(signal);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '创建邮箱失败');
  return { email: data.data.email, usage: data.usage, provider: 'gptmail' };
}

/**
 * 获取域名列表
 * GPTMail 没有专门的域名 API，通过生成邮箱后提取域名并缓存
 */
let cachedDomains = null;

export async function getDomains(opts = {}) {
  if (cachedDomains && cachedDomains.length > 0) {
    return cachedDomains;
  }
  try {
    const mailbox = await createMailbox(null, null, opts);
    const domain = mailbox.email.split('@')[1];
    cachedDomains = [domain];
    return cachedDomains;
  } catch (e) {
    return [];
  }
}

export function clearDomainCache() {
  cachedDomains = null;
}

/**
 * 获取邮件列表
 */
export async function getEmails(mailbox, limit = 20, opts = {}) {
  const { signal, dispatcher } = opts;
  throwIfAborted(signal);
  const base = getBaseUrl();
  const headers = getHeaders();
  const emailAddress = typeof mailbox === 'string' ? mailbox : (mailbox?.email || mailbox?.address || '');

  if (!emailAddress) {
    throw new Error('GPTMail 读取邮件需要邮箱地址');
  }

  const fetchOpts = { headers, signal };
  if (dispatcher) fetchOpts.dispatcher = dispatcher;
  const res = await fetch(
    `${base}/api/emails?email=${encodeURIComponent(emailAddress)}`,
    fetchOpts
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '获取邮件失败');

  return (data.data.emails || []).slice(0, limit).map(e => ({
    id: e.id,
    sender: e.from_address,
    subject: e.subject,
    preview: e.content ? e.content.substring(0, 200) : '',
    verification_code: extractCode(e.subject, e.content),
    content_length: String(e.content || '').length,
    received_at: e.created_at,
  }));
}

/**
 * 获取单封邮件详情
 */
export async function getEmailDetail(emailId) {
  const base = getBaseUrl();
  const headers = getHeaders();
  const res = await fetch(`${base}/api/email/${emailId}`, { headers });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '获取邮件详情失败');
  return data.data;
}

/**
 * 轮询等待验证码邮件
 */
export async function waitForVerificationCode(mailbox, opts = {}) {
  const { maxWait = 60000, interval = 3000, senderFilter, signal, dispatcher } = opts;
  const deadline = Date.now() + maxWait;
  const seenIds = new Set();

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const emails = await getEmails(mailbox, 20, { signal, dispatcher });
      throwIfAborted(signal);
      for (const email of emails) {
        const seenKey = `${email.id || ''}:${email.verification_code || ''}:${email.content_length || 0}`;
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
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      /* 继续轮询 */
    }
    await abortableSleep(interval, signal);
  }

  throw new Error(`等待验证码超时 (${maxWait / 1000}s)`);
}

/**
 * 删除邮件
 */
export async function deleteEmail(emailId) {
  const base = getBaseUrl();
  const headers = getHeaders();
  const res = await fetch(`${base}/api/email/${emailId}`, { method: 'DELETE', headers });
  return res.json();
}

/**
 * 清空邮箱
 */
export async function clearMailbox(mailbox) {
  const base = getBaseUrl();
  const headers = getHeaders();
  const res = await fetch(
    `${base}/api/emails/clear?email=${encodeURIComponent(mailbox)}`,
    { method: 'DELETE', headers }
  );
  return res.json();
}

/**
 * 从主题和内容中提取验证码
 */
export function extractCode(subject, content) {
  const text = `${subject || ''} ${content || ''}`;
  const invalidCodes = new Set(['000000', '111111', '123456', '654321']);
  const re = /(?:^|\D)(\d{6})(?!\d)/g;
  let match;
  while ((match = re.exec(text))) {
    if (!invalidCodes.has(match[1])) return match[1];
  }
  return null;
}
