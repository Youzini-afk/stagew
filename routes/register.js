import express from 'express';
import { autoRegister } from '../services/auto-register.js';
import * as mailProvider from '../services/mail-provider.js';

const router = express.Router();

function clampInt(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /v1/register/auto — 自动注册 Stagewise 账号
 * Body: { prefix?, addToPool?, maxWait? }
 */
router.post('/auto', async (req, res) => {
  const { prefix, addToPool, maxWait } = req.body || {};
  const normalizedMaxWait = clampInt(maxWait, 60000, 10000, 300000);
  const logs = [];

  try {
    const result = await autoRegister({
      prefix,
      addToPool: addToPool ?? true,
      maxWait: normalizedMaxWait,
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
 * Body: { count: 100, concurrency?: 1, delayMs?: 3000, maxWait?: 60000 }
 * count 最大 1000；concurrency 1-5；delayMs 0-60000；maxWait 10000-300000
 */
router.post('/batch', async (req, res) => {
  const body = req.body || {};
  const total = clampInt(body.count, 100, 1, 1000);
  const concurrency = clampInt(body.concurrency, 1, 1, 5);
  const delayMs = clampInt(body.delayMs, 3000, 0, 60000);
  const maxWait = clampInt(body.maxWait, 60000, 10000, 300000);
  const results = new Array(total);
  let nextIndex = 0;
  let nextStartAt = Date.now();

  async function waitForStartSlot() {
    if (delayMs <= 0) return;
    const now = Date.now();
    const scheduledAt = nextStartAt;
    nextStartAt = Math.max(nextStartAt, now) + delayMs;
    const waitMs = Math.max(0, scheduledAt - now);
    if (waitMs > 0) await sleep(waitMs);
  }

  async function runOne(index) {
    const logs = [];
    try {
      await waitForStartSlot();
      const result = await autoRegister({
        addToPool: true,
        maxWait,
        onProgress: (step, message) => { logs.push({ step, message }); },
      });
      results[index] = { index, success: true, email: result.email, provider: result.provider, logs };
    } catch (err) {
      results[index] = { index, success: false, error: err.message, logs };
    }
  }

  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex++;
      await runOne(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  res.json({
    results,
    summary: {
      total,
      concurrency,
      delayMs,
      maxWait,
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
