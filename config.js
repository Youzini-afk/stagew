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

  // 管理后台 Token：保护账号池、设置、自动注册等管理 API；WebUI 通过前端登录遮罩使用它
  // 公网部署必须设置，否则管理接口一律返回 503
  adminToken: process.env.ADMIN_TOKEN || '',

  // 代理 API Key：保护账号池/.env token 免被公网滥用
  // 设置后，OpenAI 客户端必须用此 key 才能消费账号池或 .env token
  // 兼容别名 API_KEY；客户端可通过 Authorization: Bearer <KEY> 或 X-API-Key: <KEY> 传入
  proxyApiKey: process.env.PROXY_API_KEY || process.env.API_KEY || '',

  // 临时邮箱 Provider：gptmail / cfmail
  mailProvider: process.env.MAIL_PROVIDER || 'gptmail',

  // GPTMail 临时邮箱
  mailUrl: process.env.MAIL_URL || 'https://mail.chatgpt.org.uk',
  mailToken: process.env.MAIL_TOKEN || '',

  // CFMail 临时邮箱（不要硬编码真实 api_key/api_base，请通过环境变量或设置页配置）
  cfmailApiBase: process.env.CFMAIL_API_BASE || '',
  cfmailApiKey: process.env.CFMAIL_API_KEY || '',
  cfmailDomains: process.env.CFMAIL_DOMAINS || '',
  cfmailAdminAuthHeader: process.env.CFMAIL_ADMIN_AUTH_HEADER || 'x-admin-auth',
  cfmailAdminAuthScheme: process.env.CFMAIL_ADMIN_AUTH_SCHEME || 'raw',
  cfmailMailboxAuthHeader: process.env.CFMAIL_MAILBOX_AUTH_HEADER || 'Authorization',
  cfmailMailboxAuthScheme: process.env.CFMAIL_MAILBOX_AUTH_SCHEME || 'bearer',
  cfmailCreateEndpoint: process.env.CFMAIL_CREATE_ENDPOINT || '/admin/new_address',
  cfmailListEndpoint: process.env.CFMAIL_LIST_ENDPOINT || '/api/mails',
  cfmailHealthEndpoint: process.env.CFMAIL_HEALTH_ENDPOINT || '/healthz',

  // 转发时额外的请求头
  extraHeaders: {
    'User-Agent': 'stagewise-2api/1.0',
  },

  // 代理池（自动注册时按轮询/随机选代理，失败冷却指数退避）
  // 支持 http://、https://、socks5:// 直连执行；
  // ss/vmess/vless/trojan/hysteria2/tuic 等高级协议经 mihomo 子进程聚合后使用。
  proxyPoolEnabled: process.env.PROXY_POOL_ENABLED === 'true',
  proxyPoolUrls: process.env.PROXY_POOL_URLS || '',
  proxyUrl: process.env.PROXY_URL || '',
  proxyPoolStrategy: process.env.PROXY_POOL_STRATEGY || 'round-robin',

  // mihomo 子进程管理（用于 ss/vmess/vless/trojan/hysteria2/tuic 等高级协议聚合）
  // MIHOMO_ENABLED：池中存在高级节点时是否启用 mihomo；默认 true，关闭后遇高级节点会 fail closed。
  mihomoEnabled: process.env.MIHOMO_ENABLED !== 'false',
  // MIHOMO_PATH：mihomo 二进制路径；默认在 PATH 中查找 mihomo
  mihomoPath: process.env.MIHOMO_PATH || 'mihomo',
  // MIHOMO_MIXED_PORT：本地混合代理端口（仅 127.0.0.1）
  mihomoMixedPort: parsePort(process.env.MIHOMO_MIXED_PORT, 7890),
  // MIHOMO_CONTROLLER_PORT：mihomo external-controller 端口（仅 127.0.0.1）
  mihomoControllerPort: parsePort(process.env.MIHOMO_CONTROLLER_PORT, 9090),
  // MIHOMO_GROUP_STRATEGY：mihomo REG_AUTO 组策略，可选 fallback / url-test / load-balance
  mihomoGroupStrategy: (process.env.MIHOMO_GROUP_STRATEGY || 'fallback').trim().toLowerCase(),
  // MIHOMO_TEST_URL：mihomo url-test/fallback 探活 URL
  mihomoTestUrl: process.env.MIHOMO_TEST_URL || 'https://www.gstatic.com/generate_204',
};
