import { getDb } from '../db/database.js';

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
 * 邮箱配置（从数据库读取，优先于 .env）
 */
export function getMailConfig() {
  return {
    url: getSetting('mail_url', process.env.MAIL_URL || 'https://mail.chatgpt.org.uk'),
    token: getSetting('mail_token', process.env.MAIL_TOKEN || ''),
  };
}

/**
 * 保存邮箱配置
 */
export function saveMailConfig(url, token) {
  if (url) setSetting('mail_url', url);
  if (token) setSetting('mail_token', token);
}
