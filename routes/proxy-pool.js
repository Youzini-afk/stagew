import express from 'express';
import * as proxyPool from '../services/proxy-pool.js';

const router = express.Router();

/**
 * GET /v1/proxy-pool — 代理池概览（节点脱敏，不含 secret/proxy/rawUri）
 */
router.get('/', async (req, res) => {
  try {
    const mihomo = await proxyPool.getMihomoStatus();
    const nodes = proxyPool.listProxyNodes();
    const directCount = nodes.filter(n => n.executor === 'direct' && !n.disabled).length;
    const advancedCount = nodes.filter(n => n.executor === 'mihomo' && !n.disabled).length;
    res.json({
      enabled: proxyPool.isProxyPoolEnabled(),
      strategy: proxyPool.getProxyPoolStrategy(),
      mihomoStrategy: proxyPool.getMihomoGroupStrategy(),
      nodes,
      counts: {
        total: nodes.length,
        enabled: nodes.filter(n => !n.disabled).length,
        direct: directCount,
        advanced: advancedCount,
      },
      fallbackProxy: proxyPool.maskedFallbackProxy(),
      mihomo: {
        available: mihomo.available,
        running: mihomo.running,
        port: mihomo.port,
        controllerPort: mihomo.controllerPort,
        group: mihomo.group,
        nodeCount: mihomo.nodeCount,
        skippedNodeCount: mihomo.skippedNodeCount,
        lastError: mihomo.lastError,
        startedAt: mihomo.startedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/nodes — 添加节点（支持 URI：http(s)/socks5/ss/vmess/vless/trojan/hy2/tuic）
 * body: { url, name? }
 */
router.post('/nodes', (req, res) => {
  try {
    const { url, name } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: { message: 'url 不能为空' } });
    }
    const node = proxyPool.addProxyNode(url, name, 'manual');
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
 * DELETE /v1/proxy-pool/nodes — 清空全部节点（重新按原始订阅导入时使用）
 */
router.delete('/nodes', (req, res) => {
  try {
    proxyPool.clearProxyNodes();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
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
 * direct 节点：直接 fetch 测试；advanced 节点：触发 mihomo ensure running + 聚合测试，不泄漏 secret/config。
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
 * POST /v1/proxy-pool/import — 订阅/批量导入
 * body: { text, subscriptionId? }
 * 支持 Clash/Mihomo YAML（仅读取顶层 proxies）、base64 URI list、plain URI list。
 * 返回 { added, skipped, invalid, total }，绝不返回 secret/proxy/rawUri。
 */
router.post('/import', (req, res) => {
  try {
    const { text, subscriptionId } = req.body || {};
    const result = proxyPool.importProxyNodes(text || '', { subscriptionId: subscriptionId || null, source: 'import' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

/**
 * PUT /v1/proxy-pool/settings — 更新代理池设置
 * body: { enabled?, strategy?, mihomoStrategy? }
 */
router.put('/settings', (req, res) => {
  try {
    const { enabled, strategy, mihomoStrategy } = req.body || {};
    proxyPool.updateProxyPoolSettings({ enabled, strategy, mihomoStrategy });
    res.json({
      success: true,
      enabled: proxyPool.isProxyPoolEnabled(),
      strategy: proxyPool.getProxyPoolStrategy(),
      mihomoStrategy: proxyPool.getMihomoGroupStrategy(),
    });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/proxy-pool/mihomo/restart — 强制重启 mihomo（不返回 secret/config）
 */
router.post('/mihomo/restart', async (req, res) => {
  try {
    const mihomo = await import('../services/mihomo-manager.js');
    const status = await mihomo.restart();
    res.json({
      success: true,
      mihomo: {
        available: status.available,
        running: status.running,
        port: status.port,
        controllerPort: status.controllerPort,
        group: status.group,
        nodeCount: status.nodeCount,
        skippedNodeCount: status.skippedNodeCount,
        lastError: status.lastError,
        startedAt: status.startedAt,
      },
    });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

export default router;
