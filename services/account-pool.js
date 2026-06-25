import { getDb } from '../db/database.js';

/**
 * 账号池管理服务
 * - 增删查账号
 * - 轮询调度选取可用 token
 * - 故障标记与自动跳过
 */

let roundRobinIndex = 0;

/**
 * 添加账号到池
 */
export function addAccount(email, token, name = null) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO accounts (email, token, name)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      token = excluded.token,
      name = COALESCE(excluded.name, accounts.name),
      updated_at = CURRENT_TIMESTAMP
  `);
  const result = stmt.run(email, token, name);
  return { id: result.lastInsertRowid, email, token, name };
}

/**
 * 移除账号
 */
export function removeAccount(email) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM accounts WHERE email = ?');
  return stmt.run(email);
}

/**
 * 列出所有账号（脱敏 token）
 */
export function listAccounts() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, email, name, created_at, updated_at, is_active,
           last_used_at, request_count, error_count, last_error,
           substr(token, 1, 20) || '...' as token_preview
    FROM accounts ORDER BY created_at DESC
  `);
  return stmt.all();
}

/**
 * 获取下一个可用 token（轮询调度）
 * - 跳过 is_active=0 的账号
 * - 跳过最近连续出错 > 3 次且冷却期（5分钟）内的账号
 * - 按 last_used_at ASC 排序，选取最久未用的
 */
export function getNextToken() {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT id, email, token FROM accounts
    WHERE is_active = 1
      AND (error_count <= 3 OR
           julianday('now') - julianday(last_used_at) > 0.0035)
    ORDER BY last_used_at ASC NULLS FIRST
  `);
  const accounts = stmt.all();

  if (accounts.length === 0) {
    return null;
  }

  // 轮询选取
  const idx = roundRobinIndex % accounts.length;
  roundRobinIndex++;

  const selected = accounts[idx];

  // 更新 last_used_at 和 request_count
  db.prepare(`
    UPDATE accounts SET last_used_at = CURRENT_TIMESTAMP, request_count = request_count + 1
    WHERE id = ?
  `).run(selected.id);

  return {
    token: selected.token,
    email: selected.email,
    accountId: selected.id,
  };
}

/**
 * 标记账号成功（重置错误计数）
 */
export function markSuccess(accountId) {
  const db = getDb();
  db.prepare('UPDATE accounts SET error_count = 0, last_error = NULL WHERE id = ?').run(accountId);
}

/**
 * 标记账号失败
 */
export function markError(accountId, error) {
  const db = getDb();
  db.prepare(`
    UPDATE accounts
    SET error_count = error_count + 1,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(error, accountId);
}

/**
 * 启用/禁用账号
 */
export function setAccountActive(email, isActive) {
  const db = getDb();
  db.prepare('UPDATE accounts SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?')
    .run(isActive ? 1 : 0, email);
}

/**
 * 获取账号池统计
 */
export function getPoolStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(is_active), 0) as active,
      COALESCE(SUM(request_count), 0) as total_requests,
      COALESCE(SUM(error_count), 0) as total_errors
    FROM accounts
  `).get();
}
