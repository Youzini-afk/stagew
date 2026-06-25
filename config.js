// Stagewise 2api — 配置
function parsePort(value, fallback = 3000) {
  const port = Number.parseInt(value || '', 10);
  return Number.isInteger(port) && port >= 0 && port < 65536 ? port : fallback;
}

export const config = {
  // Stagewise LLM 网关地址
  llmGateway: process.env.STAGEWISE_LLM_URL || 'https://api.stagewise.io/v1/ai',

  // Stagewise API 地址（用于 auth 等）
  apiUrl: process.env.STAGEWISE_API_URL || 'https://api.stagewise.io',

  // 监听端口
  port: parsePort(process.env.PORT),

  // 默认 Bearer Token（可选，也可以在请求头带）
  defaultToken: process.env.STAGEWISE_TOKEN || '',

  // GPTMail 临时邮箱
  mailUrl: process.env.MAIL_URL || 'https://mail.chatgpt.org.uk',
  mailToken: process.env.MAIL_TOKEN || '',

  // 转发时额外的请求头
  extraHeaders: {
    'User-Agent': 'stagewise-2api/1.0',
  },
};
