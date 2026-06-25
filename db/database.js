import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 计算数据库文件路径，优先级：
 *   1. DB_PATH 环境变量（直接使用，相对路径会基于 cwd 解析为绝对路径）
 *   2. DATA_DIR 环境变量（在 DATA_DIR 下使用 accounts.db）
 *   3. 默认：项目内 ../data/accounts.db
 */
function resolveDbPath() {
  if (process.env.DB_PATH) {
    return resolve(process.env.DB_PATH);
  }
  if (process.env.DATA_DIR) {
    return resolve(join(process.env.DATA_DIR, 'accounts.db'));
  }
  return join(__dirname, '..', 'data', 'accounts.db');
}

const DB_PATH = resolveDbPath();

/**
 * 返回当前数据库文件绝对路径（供健康检查/调试展示，不包含敏感数据）。
 */
export function getDatabasePath() {
  return DB_PATH;
}

let db;

export function getDb() {
  if (!db) {
    // 确保数据库所在目录存在（Zeabur Volume 挂载点可能为空目录）
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');   // 写冲突时等待 5s，避免 SQLITE_BUSY
    db.pragma('foreign_keys = ON');      // 启用外键约束
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      last_used_at DATETIME,
      request_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      plan TEXT,
      daily_used_percent REAL,
      weekly_used_percent REAL,
      monthly_used_percent REAL,
      daily_reset_at TEXT,
      weekly_reset_at TEXT,
      monthly_reset_at TEXT,
      prepaid_balance REAL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);
    CREATE INDEX IF NOT EXISTS idx_accounts_last_used ON accounts(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_usage_history_account ON usage_history(account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_history_time ON usage_history(checked_at);
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
