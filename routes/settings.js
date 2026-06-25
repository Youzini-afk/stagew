import express from 'express';
import { getMailConfig, saveMailConfig, getAllSettings, setSetting, deleteSetting } from '../services/settings.js';

const router = express.Router();

/**
 * GET /v1/settings - 获取所有设置
 */
router.get('/', (req, res) => {
  try {
    const settings = getAllSettings();
    if (settings.mail_token) {
      settings.mail_token.value = settings.mail_token.value.substring(0, 4) + '****';
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /v1/settings/mail - 获取邮箱 API 配置
 */
router.get('/mail', (req, res) => {
  try {
    const config = getMailConfig();
    const masked = config.token
      ? config.token.substring(0, 4) + '****' + config.token.slice(-4)
      : '';
    res.json({
      url: config.url,
      token: masked,
      tokenLength: config.token ? config.token.length : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/settings/mail - 保存邮箱 API 配置
 */
router.post('/mail', (req, res) => {
  try {
    const { url, token } = req.body;
    if (!url || !token) {
      return res.status(400).json({ error: 'url 和 token 都是必需的' });
    }
    saveMailConfig(url, token);
    res.json({ success: true, message: '邮箱 API 配置已保存' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /v1/settings - 保存通用设置
 */
router.post('/', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'key 和 value 都是必需的' });
    }
    setSetting(key, value);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /v1/settings/:key - 删除设置
 */
router.delete('/:key', (req, res) => {
  try {
    deleteSetting(req.params.key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
