import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { closeDb } from '../db/database.js';
import { extractToken, requireAdmin } from '../middleware/auth.js';
import healthRouter from '../routes/health.js';
import authRouter from '../routes/auth.js';
import poolRouter from '../routes/pool.js';
import usageRouter from '../routes/usage.js';
import registerRouter from '../routes/register.js';
import settingsRouter from '../routes/settings.js';
import proxyPoolRouter from '../routes/proxy-pool.js';
import { handleListModels, handleChatCompletions } from '../services/proxy.js';
import { STAGEWISE_MODELS } from '../services/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ─── 中间件 ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-API-Key'],
}));

// 聊天请求可能较大；其他管理/API 请求用较小限制，减少公网滥用面
app.use('/v1/chat/completions', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Token 提取中间件（仅对 /v1 路由）
app.use('/v1', extractToken);

// ─── 路由 ─────────────────────────────────────────────────────────────────
app.use('/', healthRouter);

// 管理面板页面本身可打开；敏感管理 API 由 ADMIN_TOKEN 保护
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.use('/v1/pool', requireAdmin, poolRouter);
app.use('/v1/settings', requireAdmin, settingsRouter);
app.use('/v1/register', requireAdmin, registerRouter);
app.use('/v1/auth', requireAdmin, authRouter);
app.use('/v1/proxy-pool', requireAdmin, proxyPoolRouter);

// /v1/usage：仅 /pool 子路由需要 admin；普通 / 用账号 token 流程，不挂 admin
app.use('/v1/usage/pool', requireAdmin);
app.use('/v1/usage', usageRouter);

// OpenAI 兼容端点（不需要 admin token；防滥用由 extractToken 的 PROXY_API_KEY 逻辑处理）
app.get('/v1/models', handleListModels);
app.post('/v1/chat/completions', handleChatCompletions);

// ─── 启动 ─────────────────────────────────────────────────────────────────
// 显式绑定 0.0.0.0，符合 Zeabur 官方排障建议（容器内必须监听全部网卡）
const HOST = '0.0.0.0';
const server = app.listen(config.port, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║              Stagewise 2api v2.0                 ║
╠══════════════════════════════════════════════════╣
║  代理网关: ${config.llmGateway.padEnd(35)}║
║  监听地址: ${(HOST + ':' + config.port).padEnd(35)}║
║  模型数量: ${String(STAGEWISE_MODELS.length).padEnd(35)}║
║  默认Token: ${config.defaultToken ? '✅ 已设置'.padEnd(29) : '❌ 未设置'.padEnd(29)}║
╠══════════════════════════════════════════════════╣
║  OpenAI 兼容:                                     ║
║    POST /v1/chat/completions                      ║
║    GET  /v1/models                                ║
╠══════════════════════════════════════════════════╣
║  账号池管理:                                      ║
║    GET/POST    /v1/pool                           ║
║    GET         /v1/pool/stats                     ║
║    DELETE      /v1/pool/:email                    ║
║    PATCH       /v1/pool/:email                    ║
╠══════════════════════════════════════════════════╣
║  额度查询:                                        ║
║    GET /v1/usage         单账号用量                ║
║    GET /v1/usage/pool    账号池汇总                ║
╠══════════════════════════════════════════════════╣
║  自动注册:                                        ║
║    POST /v1/register/auto   自动注册账号           ║
║    POST /v1/register/batch  批量注册               ║
║    GET  /v1/register/domains 可用域名              ║
╠══════════════════════════════════════════════════╣
║  前端面板: http://localhost:${config.port}/dashboard  ║
╚══════════════════════════════════════════════════╝
  `);
});

// 优雅关闭
function gracefulShutdown() {
  console.log('\n正在关闭服务...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // 5 秒超时强制退出
  setTimeout(() => {
    console.error('强制退出');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
