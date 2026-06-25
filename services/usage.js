import { config } from '../config.js';
import { getDb } from '../db/database.js';

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 获取单个账号的用量信息（带持久化缓存）
 */
export async function getAccountUsage(token, accountId = null) {
  // 先查缓存
  if (accountId) {
    const cached = getCachedUsage(accountId);
    if (cached) return cached;
  }

  try {
    const response = await fetch(`${config.apiUrl}/v1/usage/current`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    });

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
 * 获取账号池所有账号的额度汇总（带缓存 + 强制刷新选项）
 */
export async function getPoolUsage(forceRefresh = false) {
  const db = getDb();
  const stmt = db.prepare('SELECT id, email, token, name FROM accounts WHERE is_active = 1');
  const accounts = stmt.all();

  // 并行请求（带 accountId 用于缓存）
  const results = await Promise.all(
    accounts.map(async (account) => {
      const usage = forceRefresh
        ? await getAccountUsageFresh(account.token, account.id)
        : await getAccountUsage(account.token, account.id);
      return {
        id: account.id,
        email: account.email,
        name: account.name,
        ...usage,
      };
    })
  );

  // 汇总
  let totalDaily = 0, totalWeekly = 0, totalMonthly = 0;
  let successCount = 0;

  for (const r of results) {
    if (r.success && r.raw) {
      successCount++;
      for (const w of r.raw.windows || []) {
        if (w.type === 'daily') totalDaily += w.usedPercent || 0;
        if (w.type === 'weekly') totalWeekly += w.usedPercent || 0;
        if (w.type === 'monthly') totalMonthly += w.usedPercent || 0;
      }
    }
  }

  const avgDaily = successCount > 0 ? ((totalDaily / successCount) * 100).toFixed(1) : '0';
  const avgWeekly = successCount > 0 ? ((totalWeekly / successCount) * 100).toFixed(1) : '0';
  const avgMonthly = successCount > 0 ? ((totalMonthly / successCount) * 100).toFixed(1) : '0';

  return {
    accounts: results,
    summary: {
      totalAccounts: accounts.length,
      successCount,
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
async function getAccountUsageFresh(token, accountId) {
  try {
    const response = await fetch(`${config.apiUrl}/v1/usage/current`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `获取用量失败 (${response.status}): ${text}` };
    }

    const raw = await response.json();
    if (accountId) saveUsageToCache(accountId, raw);
    return { success: true, raw, ...formatUsage(raw), cached: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
