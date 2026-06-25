import { config } from '../config.js';
import { getDb } from '../db/database.js';

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
const PER_ACCOUNT_TIMEOUT_MS = 12000; // 单账号查询超时
const POOL_CONCURRENCY = 5; // 账号池额度查询并发上限

/**
 * 带超时的 fetch 封装
 */
function fetchWithTimeout(url, options = {}, timeoutMs = PER_ACCOUNT_TIMEOUT_MS) {
  if (!options.signal && timeoutMs > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }
  return fetch(url, options);
}

/**
 * 获取单个账号的用量信息（带持久化缓存）
 */
export async function getAccountUsage(token, accountId = null, opts = {}) {
  const { timeoutMs = PER_ACCOUNT_TIMEOUT_MS, forceFresh = false } = opts;
  return fetchUsageFromApi(token, accountId, { forceFresh, timeoutMs });
}

/**
 * 内部统一查询：先查缓存（非强制刷新时），再走带超时的 API
 */
async function fetchUsageFromApi(token, accountId, { forceFresh = false, timeoutMs = PER_ACCOUNT_TIMEOUT_MS }) {
  if (!forceFresh && accountId) {
    const cached = getCachedUsage(accountId);
    if (cached) return cached;
  }

  try {
    const response = await fetchWithTimeout(`${config.apiUrl}/v1/usage/current`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    }, timeoutMs);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `获取用量失败 (${response.status}): ${text}` };
    }

    const raw = await response.json();
    const formatted = formatUsage(raw);

    const result = { success: true, raw, ...formatted };

    // 写入缓存
    if (accountId) saveUsageToCache(accountId, raw);

    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        success: false,
        error: `查询超时 (${Math.round(timeoutMs / 1000)}s)`,
        timedOut: true,
      };
    }
    return { success: false, error: err.message };
  }
}

/**
 * 从缓存获取用量（5 分钟 TTL）
 */
function getCachedUsage(accountId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM usage_history
    WHERE account_id = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(accountId);

  if (!row) return null;

  const age = Date.now() - new Date(row.checked_at + 'Z').getTime();
  if (age > CACHE_TTL) return null;

  const raw = {
    plan: row.plan,
    prepaidBalance: row.prepaid_balance,
    windows: [
      { type: 'daily', usedPercent: row.daily_used_percent, exceeded: false, resetsAt: row.daily_reset_at },
      { type: 'weekly', usedPercent: row.weekly_used_percent, exceeded: false, resetsAt: row.weekly_reset_at },
      { type: 'monthly', usedPercent: row.monthly_used_percent, exceeded: false, resetsAt: row.monthly_reset_at },
    ].filter(w => w.usedPercent != null),
  };

  return { success: true, raw, ...formatUsage(raw), cached: true };
}

/**
 * 保存用量到缓存
 */
function saveUsageToCache(accountId, raw) {
  const db = getDb();
  const windows = raw.windows || [];
  const daily = windows.find(w => w.type === 'daily');
  const weekly = windows.find(w => w.type === 'weekly');
  const monthly = windows.find(w => w.type === 'monthly');

  db.prepare(`
    INSERT INTO usage_history (account_id, plan, daily_used_percent, weekly_used_percent, monthly_used_percent,
      daily_reset_at, weekly_reset_at, monthly_reset_at, prepaid_balance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    raw.plan || 'unknown',
    daily?.usedPercent ?? null,
    weekly?.usedPercent ?? null,
    monthly?.usedPercent ?? null,
    daily?.resetsAt ?? null,
    weekly?.resetsAt ?? null,
    monthly?.resetsAt ?? null,
    raw.prepaidBalance ?? 0
  );
}

/**
 * 格式化用量数据
 */
function formatUsage(data) {
  const windows = data.windows || [];

  const result = {
    plan: data.plan || 'unknown',
    windows: [],
  };

  for (const w of windows) {
    const usedPercent = (w.usedPercent || 0) * 100;
    const remainingPercent = Math.max(0, 100 - usedPercent); // 防止负数

    result.windows.push({
      period: w.type,  // API 返回 type 字段
      usedPercent: usedPercent.toFixed(1) + '%',
      remainingPercent: remainingPercent.toFixed(1) + '%',
      resetAt: w.resetsAt,  // API 返回 resetsAt 字段
      exceeded: w.exceeded || false,
    });
  }

  // 生成可视化文本
  const lines = [];
  lines.push(`📊 计划: ${result.plan.toUpperCase()}`);

  for (const w of result.windows) {
    const bar = createProgressBar(parseFloat(w.usedPercent));
    const periodLabel = w.period === 'daily' ? '日配额' :
                       w.period === 'weekly' ? '周配额' :
                       w.period === 'monthly' ? '月配额' : w.period;

    lines.push(`\n${periodLabel}:`);
    lines.push(`  ${bar}`);
    lines.push(`  已用 ${w.usedPercent} | 剩余 ${w.remainingPercent}`);

    if (w.resetAt) {
      const resetDate = new Date(w.resetAt);
      const now = new Date();
      const diffMs = resetDate - now;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

      lines.push(`  ⏰ 重置: ${diffHours}小时后 (${resetDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    }

    if (w.exceeded) {
      lines.push(`  ⚠️ 已超出配额!`);
    }
  }

  result.display = lines.join('\n');
  return result;
}

/**
 * 创建进度条
 */
function createProgressBar(percent, width = 20) {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let color = '🟢';
  if (percent > 80) color = '🔴';
  else if (percent > 60) color = '🟡';

  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent.toFixed(0)}%`;
}

/**
 * 获取账号池所有账号的额度汇总（带缓存 + 强制刷新选项 + 分页）
 *
 * - 分页：opts.page（默认 1）、opts.pageSize（默认 20，限制 1-100）
 * - SQL 只查当前页活跃账号：ORDER BY id ASC LIMIT ? OFFSET ?
 * - 每账号查询带超时（PER_ACCOUNT_TIMEOUT_MS），慢/无响应账号不阻塞其它账号
 * - 并发上限 POOL_CONCURRENCY，避免一次打爆 Stagewise
 * - 返回部分结果 + summary（含 totalAccounts/totalPages/page/pageSize/pageAccounts）
 */
export async function getPoolUsage(forceRefresh = false, opts = {}) {
  const db = getDb();

  // 分页参数解析与钳制
  let page = Number.parseInt(opts.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = Number.parseInt(opts.pageSize, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 20;
  pageSize = Math.min(pageSize, 100);

  const totalAccounts = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_active = 1').get().n;
  const totalPages = Math.max(1, Math.ceil(totalAccounts / pageSize));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * pageSize;

  const accounts = db.prepare(
    'SELECT id, email, token, name FROM accounts WHERE is_active = 1 ORDER BY id ASC LIMIT ? OFFSET ?'
  ).all(pageSize, offset);
  const pageAccounts = accounts.length;

  const startedAt = Date.now();
  const results = new Array(pageAccounts);
  let cursor = 0;

  async function worker() {
    while (cursor < pageAccounts) {
      const idx = cursor++;
      const account = accounts[idx];
      try {
        const usage = await fetchUsageFromApi(account.token, account.id, {
          forceFresh: forceRefresh,
          timeoutMs: PER_ACCOUNT_TIMEOUT_MS,
        });
        results[idx] = {
          id: account.id,
          email: account.email,
          name: account.name,
          ...usage,
        };
      } catch (err) {
        const timedOut = err?.name === 'AbortError';
        results[idx] = {
          id: account.id,
          email: account.email,
          name: account.name,
          success: false,
          error: timedOut ? `查询超时 (${Math.round(PER_ACCOUNT_TIMEOUT_MS / 1000)}s)` : (err?.message || '查询失败'),
          timedOut,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(POOL_CONCURRENCY, pageAccounts) }, () => worker())
  );

  // 汇总（基于本页）
  let totalDaily = 0, totalWeekly = 0, totalMonthly = 0;
  let successCount = 0;
  let failedCount = 0;
  let timeoutCount = 0;

  for (const r of results) {
    if (r?.success && r.raw) {
      successCount++;
      for (const w of r.raw.windows || []) {
        if (w.type === 'daily') totalDaily += w.usedPercent || 0;
        if (w.type === 'weekly') totalWeekly += w.usedPercent || 0;
        if (w.type === 'monthly') totalMonthly += w.usedPercent || 0;
      }
    } else {
      failedCount++;
      if (r?.timedOut) timeoutCount++;
    }
  }

  const avgDaily = successCount > 0 ? ((totalDaily / successCount) * 100).toFixed(1) : '0';
  const avgWeekly = successCount > 0 ? ((totalWeekly / successCount) * 100).toFixed(1) : '0';
  const avgMonthly = successCount > 0 ? ((totalMonthly / successCount) * 100).toFixed(1) : '0';

  return {
    accounts: results,
    summary: {
      // 分页信息
      totalAccounts,
      total: totalAccounts,
      totalPages,
      page,
      pageSize,
      pageAccounts,
      // 统计
      successCount,
      success: successCount,
      failedCount,
      failed: failedCount,
      timeoutCount,
      timeout: timeoutCount,
      elapsedMs: Date.now() - startedAt,
      updatedAt: new Date().toISOString(),
      avgDailyUsed: avgDaily + '%',
      avgWeeklyUsed: avgWeekly + '%',
      avgMonthlyUsed: avgMonthly + '%',
      estimatedDailyTotal: (successCount > 0 ? (100 - parseFloat(avgDaily)).toFixed(1) : '0') + '%',
      cached: !forceRefresh,
    },
  };
}

/**
 * 强制从 API 获取（跳过缓存）
 */
export async function getAccountUsageFresh(token, accountId, opts = {}) {
  const { timeoutMs = PER_ACCOUNT_TIMEOUT_MS } = opts;
  return fetchUsageFromApi(token, accountId, { forceFresh: true, timeoutMs });
}
