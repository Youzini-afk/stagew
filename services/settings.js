import { getDb } from '../db/database.js';

export const SUPPORTED_MAIL_PROVIDERS = ['gptmail', 'cfmail'];

function normalizeProvider(provider) {
  const value = String(provider || 'gptmail').trim().toLowerCase();
  return SUPPORTED_MAIL_PROVIDERS.includes(value) ? value : 'gptmail';
}

function parseDomains(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * 获取设置项
 */
export function getSetting(key, defaultValue = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

/**
 * 设置配置项
 */
export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

/**
 * 获取所有设置
 */
export function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value, updated_at FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, { value: r.value, updatedAt: r.updated_at }]));
}

/**
 * 删除设置
 */
export function deleteSetting(key) {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/**
 * 当前临时邮箱 Provider（从数据库读取，优先于 .env）
 */
export function getMailProviderName() {
  return normalizeProvider(getSetting('mail_provider', process.env.MAIL_PROVIDER || 'gptmail'));
}

/**
 * GPTMail 配置（从数据库读取，优先于 .env）
 */
export function getMailConfig() {
  return {
    provider: getMailProviderName(),
    url: getSetting('mail_url', process.env.MAIL_URL || 'https://mail.chatgpt.org.uk'),
    token: getSetting('mail_token', process.env.MAIL_TOKEN || ''),
  };
}

/**
 * CFMail 配置（从数据库读取，优先于 .env）
 */
export function getCfMailConfig() {
  return {
    provider: getMailProviderName(),
    apiBase: getSetting('cfmail_api_base', process.env.CFMAIL_API_BASE || ''),
    apiKey: getSetting('cfmail_api_key', process.env.CFMAIL_API_KEY || ''),
    domains: parseDomains(getSetting('cfmail_domains', process.env.CFMAIL_DOMAINS || '')),
    adminAuthHeader: getSetting('cfmail_admin_auth_header', process.env.CFMAIL_ADMIN_AUTH_HEADER || 'x-admin-auth'),
    adminAuthScheme: getSetting('cfmail_admin_auth_scheme', process.env.CFMAIL_ADMIN_AUTH_SCHEME || 'raw'),
    mailboxAuthHeader: getSetting('cfmail_mailbox_auth_header', process.env.CFMAIL_MAILBOX_AUTH_HEADER || 'Authorization'),
    mailboxAuthScheme: getSetting('cfmail_mailbox_auth_scheme', process.env.CFMAIL_MAILBOX_AUTH_SCHEME || 'bearer'),
    createEndpoint: getSetting('cfmail_create_endpoint', process.env.CFMAIL_CREATE_ENDPOINT || '/admin/new_address'),
    listEndpoint: getSetting('cfmail_list_endpoint', process.env.CFMAIL_LIST_ENDPOINT || '/api/mails'),
    healthEndpoint: getSetting('cfmail_health_endpoint', process.env.CFMAIL_HEALTH_ENDPOINT || '/healthz'),
  };
}

/**
 * 保存邮箱配置
 */
export function saveMailConfig(url, token) {
  if (url) setSetting('mail_url', url);
  if (token) setSetting('mail_token', token);
}

export function saveMailProviderName(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!SUPPORTED_MAIL_PROVIDERS.includes(normalized)) {
    throw new Error('mail_provider 只能是 gptmail 或 cfmail');
  }
  setSetting('mail_provider', normalized);
}

export function formatDomains(domains) {
  return parseDomains(domains).join(',');
}
