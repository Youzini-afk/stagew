import express from 'express';
import {
  addAccount,
  removeAccount,
  listAccounts,
  setAccountActive,
  getPoolStats,
} from '../services/account-pool.js';

const router = express.Router();

/**
 * GET /v1/pool/stats - 池统计（必须在 /:email 之前，否则被拦截）
 */
router.get('/stats', (req, res) => {
  const stats = getPoolStats();
  res.json(stats);
});

/**
 * GET /v1/pool - 列出账号池
 */
router.get('/', (req, res) => {
  const accounts = listAccounts();
  res.json({ accounts, count: accounts.length });
});

/**
 * POST /v1/pool - 添加账号
 */
router.post('/', (req, res) => {
  const { email, token, name } = req.body;
  if (!email || !token) {
    return res.status(400).json({ error: 'email 和 token 是必需的' });
  }
  try {
    const account = addAccount(email, token, name);
    res.json({ success: true, account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /v1/pool/:email - 删除账号
 */
router.delete('/:email', (req, res) => {
  try {
    const result = removeAccount(req.params.email);
    res.json({ success: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /v1/pool/:email - 启用/禁用账号
 */
router.patch('/:email', (req, res) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive 必须是布尔值' });
  }
  try {
    setAccountActive(req.params.email, isActive);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
