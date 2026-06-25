import express from 'express';
import { getDb } from '../db/database.js';

const router = express.Router();

// 根路径：服务基本信息（不暴露任何敏感数据）
router.get('/', (req, res) => {
  res.json({
    name: 'stagewise-2api',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
      auth: '/v1/auth',
      pool: '/v1/pool',
      usage: '/v1/usage',
      dashboard: '/dashboard',
    },
    provider: 'https://stagewise.io',
  });
});

// 轻量健康检查：实际 ping SQLite，供 Zeabur / 平台探活使用
// 故意只返回极简信息，不泄露数据库路径、原始错误或任何内部细节
router.get('/healthz', (req, res) => {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    if (row && row.ok === 1) {
      return res.status(200).json({ status: 'ok' });
    }
    console.error('[healthz] database ping returned unexpected result');
    return res.status(503).json({ status: 'error', message: 'database unavailable' });
  } catch (err) {
    // 仅在服务端日志记录简短错误，不回传给公网客户端
    console.error('[healthz] database error:', err && err.message ? err.message : err);
    return res.status(503).json({ status: 'error', message: 'database unavailable' });
  }
});

export default router;
