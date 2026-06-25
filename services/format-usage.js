/**
 * 格式化 Stagewise 用量数据
 */
export function formatUsage(data) {
  const lines = [];

  // 计划和预付余额
  lines.push(`📊 计划: ${data.plan.toUpperCase()}`);
  if (data.prepaidBalance > 0) {
    lines.push(`💰 预付余额: $${data.prepaidBalance.toFixed(2)}`);
  }
  lines.push('');

  // 时间窗口
  if (data.windows && data.windows.length > 0) {
    lines.push('⏰ 用量配额:');

    for (const window of data.windows) {
      const type = window.type.padEnd(8);
      const percent = (window.usedPercent * 100).toFixed(1);
      const bar = createProgressBar(window.usedPercent);
      const status = window.exceeded ? '❌ 已超额' : '✅';

      // 计算重置时间
      const resetTime = new Date(window.resetsAt);
      const now = new Date();
      const timeLeft = resetTime - now;
      const resetStr = formatTimeLeft(timeLeft);

      lines.push(`  ${type} ${bar} ${percent.padStart(5)}% ${status}`);
      lines.push(`           重置: ${resetStr} (${resetTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    }
  }

  return lines.join('\n');
}

/**
 * 创建进度条
 */
function createProgressBar(percent, width = 20) {
  const filled = Math.round(percent * width);
  const empty = width - filled;

  let color = '🟩'; // 绿色
  if (percent > 0.8) color = '🟥'; // 红色
  else if (percent > 0.6) color = '🟨'; // 黄色

  return color.repeat(filled) + '⬜'.repeat(empty);
}

/**
 * 格式化剩余时间
 */
function formatTimeLeft(ms) {
  if (ms <= 0) return '已过期';

  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}天${hours % 24}小时`;
  }
  return `${hours}小时${minutes}分钟`;
}

/**
 * 格式化为 JSON（用于 API 响应）
 */
export function formatUsageJSON(data) {
  return {
    plan: data.plan,
    prepaidBalance: data.prepaidBalance,
    windows: data.windows.map(w => ({
      type: w.type,
      usedPercent: Math.round(w.usedPercent * 10000) / 100, // 转为百分比
      exceeded: w.exceeded,
      resetsAt: w.resetsAt,
      resetsIn: formatTimeLeft(new Date(w.resetsAt) - new Date()),
    })),
  };
}
