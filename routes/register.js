import express from 'express';
import { autoRegister } from '../services/auto-register.js';
import * as mailProvider from '../services/mail-provider.js';

const router = express.Router();

/**
 * POST /v1/register/auto — 自动注册 Stagewise 账号
 * Body: { prefix?, addToPool?, maxWait? }
 */
router.post('/auto', async (req, res) => {
  const { prefix, addToPool, maxWait } = req.body || {};
  const logs = [];

  try {
    const result = await autoRegister({
      prefix,
      addToPool: addToPool ?? true,
      maxWait: maxWait ?? 60000,
      onProgress: (step, message) => {
        logs.push({ step, message, time: new Date().toISOString() });
      },
    });

    res.json({ ...result, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

/**
 * POST /v1/register/batch — 批量自动注册
 * Body: { count: 100 }
 * count 向上取整到 100 的倍数，最大 1000
 */
router.post('/batch', async (req, res) => {
  const { count = 100 } = req.body || {};
  const max = Math.min(Math.ceil(count / 100) * 100, 1000);
  const results = [];

  for (let i = 0; i < max; i++) {
    const logs = [];
    try {
      const result = await autoRegister({
        addToPool: true,
        maxWait: 60000,
        onProgress: (step, message) => { logs.push({ step, message }); },
      });
      results.push({ index: i, success: true, email: result.email, provider: result.provider, logs });
    } catch (err) {
      results.push({ index: i, success: false, error: err.message, logs });
    }
  }

  res.json({
    results,
    summary: {
      total: max,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    },
  });
});

/**
 * GET /v1/register/domains — 获取可用邮箱域名
 */
router.get('/domains', async (req, res) => {
  try {
    const provider = mailProvider.getMailProviderName();
    const health = await mailProvider.checkHealth();
    const domains = health.domains && health.domains.length > 0
      ? health.domains
      : await mailProvider.getDomains();
    res.json({ provider, domains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
