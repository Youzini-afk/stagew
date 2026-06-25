import express from 'express';
import { getAccountUsage, getPoolUsage } from '../services/usage.js';

const router = express.Router();

/**
 * GET /v1/usage - 当前 token 用量
 */
router.get('/', async (req, res) => {
  const token = req.token;
  if (!token) {
    return res.status(401).json({ error: '需要 Bearer Token' });
  }
  const result = await getAccountUsage(token);
  res.json(result);
});

/**
 * GET /v1/usage/pool - 账号池总额度
 * ?refresh=true 强制刷新（跳过缓存）
 */
router.get('/pool', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const result = await getPoolUsage(forceRefresh);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
