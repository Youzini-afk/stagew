import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '..', 'data', 'accounts.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
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
