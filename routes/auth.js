import express from 'express';
import { sendOtp, verifyOtp, getSession, listSessions } from '../services/auth.js';

const router = express.Router();

/**
 * POST /v1/auth/login - 发送验证码
 */
router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'email 是必需的' });
  }
  const result = await sendOtp(email);
  res.json(result);
});

/**
 * POST /v1/auth/verify - 验证并获取 Token
 */
router.post('/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'email 和 code 是必需的' });
  }
  const result = await verifyOtp(email, code);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json({ success: true, token: result.token });
});

/**
 * GET /v1/auth/session - 检查会话
 */
router.get('/session', async (req, res) => {
  const token = req.token;
  if (!token) {
    return res.status(401).json({ error: '需要 Bearer Token' });
  }
  const result = await getSession(token);
  res.json(result);
});

/**
 * GET /v1/auth/sessions - 列出所有会话
 */
router.get('/sessions', async (req, res) => {
  const token = req.token;
  if (!token) {
    return res.status(401).json({ error: '需要 Bearer Token' });
  }
  const result = await listSessions(token);
  res.json(result);
});

export default router;
