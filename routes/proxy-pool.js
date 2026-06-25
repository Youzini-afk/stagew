import express from 'express';
import * as proxyPool from '../services/proxy-pool.js';

const router = express.Router();

/**
 * GET /v1/proxy-pool — 代理池概览（节点脱敏）
 */
router.get('/', (req, res) => {
  try {
    res.json({
      enabled: proxyPool.isProxyPoolEnabled(),
      strategy: proxyPool.getProxyPoolStrategy(),
      nodes: proxyPool.listProxyNodes(),
      fallbackProxy: proxyPool.maskedFallbackProxy(),
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/nodes — 添加节点
 * body: { url, name? }
 */
router.post('/nodes', (req, res) => {
  try {
    const { url, name } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: { message: 'url 不能为空' } });
    }
    const node = proxyPool.addProxyNode(url, name);
    res.json({ success: true, node });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

/**
 * DELETE /v1/proxy-pool/nodes/:id — 删除节点
 */
router.delete('/nodes/:id', (req, res) => {
  try {
    proxyPool.deleteProxyNode(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/nodes/:id/toggle — 启停节点
 * body: { disabled }
 */
router.post('/nodes/:id/toggle', (req, res) => {
  try {
    const { disabled } = req.body || {};
    const node = proxyPool.toggleProxyNode(req.params.id, disabled);
    res.json({ success: true, node });
  } catch (err) {
    res.status(404).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/nodes/:id/test — 测试节点连通性
 */
router.post('/nodes/:id/test', async (req, res) => {
  try {
    const result = await proxyPool.testProxyNode(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(404).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/import — 批量导入
 * body: { text }
 */
router.post('/import', (req, res) => {
  try {
    const { text } = req.body || {};
    const result = proxyPool.importProxyNodes(text || '');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

/**
 * PUT /v1/proxy-pool/settings — 更新代理池设置
 * body: { enabled?, strategy? }
 */
router.put('/settings', (req, res) => {
  try {
    const { enabled, strategy } = req.body || {};
    proxyPool.updateProxyPoolSettings({ enabled, strategy });
    res.json({
      success: true,
      enabled: proxyPool.isProxyPoolEnabled(),
      strategy: proxyPool.getProxyPoolStrategy(),
    });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

export default router;
