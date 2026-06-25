/**
 * 代理池
 *
 * 支持 http://、https://、socks5:// 代理 URL（基于 undici ProxyAgent / Socks5ProxyAgent，纯 JS 无 native 编译）。
 * 不支持 ss/vmess/trojan（需 mihomo，Node 无法原生处理）。
 *
 * 数据模型：
 *   ProxyNode（持久化于 SQLite settings 表）: { id, url, name, disabled, createdAt }
 *     - id 用 `${protocol}//${host}:${port}` 去重主键（不含凭证，避免凭证进 id）。
 *   NodeHealth（仅内存，重启清空）: { successCount, failCount, consecutiveFailures, lastTestMs, lastSuccessAt, lastFailAt, cooldownUntil }
 *
 * 配置来源：DB 优先于 env；DB 无节点时从 env 种子导入。
 */

import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';

const SUPPORTED_SCHEMES = ['http:', 'https:', 'socks5:', 'socks:'];
const COOLDOWN_CAP_MS = 30 * 60 * 1000; // 最大冷却 30 分钟
const COOLDOWN_BASE_MS = 30 * 1000; // 基础冷却 30s
const SETTINGS_KEY_ENABLED = 'proxy_pool_enabled';
const SETTINGS_KEY_STRATEGY = 'proxy_pool_strategy';
const SETTINGS_KEY_NODES = 'proxy_pool_nodes';

// dispatcher 缓存：id → { dispatcher, url }
const dispatcherCache = new Map();

// 健康度：id → NodeHealth
const healthMap = new Map();

// round-robin 游标
let rrCursor = 0;

let bootstrapped = false;

/* ─── 工具函数 ─────────────────────────────────────────── */

export function maskProxyUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch (e) {
    return '[invalid-url]';
  }
}

function nodeIdFromUrl(url) {
  const u = new URL(url);
  const port = u.port || defaultPortForScheme(u.protocol);
  return `${u.protocol}//${u.hostname}:${port}`;
}

function defaultPortForScheme(protocol) {
  if (protocol === 'https:') return '443';
  if (protocol === 'http:') return '80';
  if (protocol === 'socks5:' || protocol === 'socks:') return '1080';
  return '';
}

function parseProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    const scheme = u.protocol.toLowerCase();
    if (!SUPPORTED_SCHEMES.includes(scheme)) return null;
    if (!u.hostname) return null;
    return value;
  } catch (e) {
    return null;
  }
}

function isTruthy(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function parseNodeList(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/* ─── 持久化节点读写 ─────────────────────────────────────── */

function readNodesRaw() {
  const raw = getSetting(SETTINGS_KEY_NODES, null);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeNodesRaw(nodes) {
  setSetting(SETTINGS_KEY_NODES, JSON.stringify(nodes));
}

/* ─── bootstrap：DB 无节点时从 env 种子导入 ────────────────── */

function bootstrapFromEnv() {
  if (bootstrapped) return;
  bootstrapped = true;
  const existing = readNodesRaw();
  if (existing.length > 0) return;

  const urls = parseNodeList(config.proxyPoolUrls);
  if (urls.length === 0) return;

  const now = new Date().toISOString();
  const nodes = [];
  const seen = new Set();
  for (const raw of urls) {
    const valid = parseProxyUrl(raw);
    if (!valid) continue;
    const id = nodeIdFromUrl(valid);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, url: valid, name: '', disabled: false, createdAt: now });
  }
  if (nodes.length > 0) writeNodesRaw(nodes);
}

/* ─── 设置 ─────────────────────────────────────────────── */

export function isProxyPoolEnabled() {
  const dbValue = getSetting(SETTINGS_KEY_ENABLED, null);
  if (dbValue !== null) return isTruthy(dbValue);
  return isTruthy(config.proxyPoolEnabled);
}

export function getProxyPoolStrategy() {
  const dbValue = getSetting(SETTINGS_KEY_STRATEGY, null);
  if (dbValue) {
    const v = String(dbValue).trim().toLowerCase();
    if (v === 'round-robin' || v === 'random') return v;
  }
  const envValue = String(config.proxyPoolStrategy || 'round-robin').trim().toLowerCase();
  return envValue === 'random' ? 'random' : 'round-robin';
}

export function updateProxyPoolSettings({ enabled, strategy }) {
  if (enabled !== undefined && enabled !== null) {
    setSetting(SETTINGS_KEY_ENABLED, isTruthy(enabled) ? 'true' : 'false');
  }
  if (strategy !== undefined && strategy !== null) {
    const v = String(strategy).trim().toLowerCase();
    if (v === 'round-robin' || v === 'random') {
      setSetting(SETTINGS_KEY_STRATEGY, v);
    } else {
      throw new Error('strategy 只能是 round-robin 或 random');
    }
  }
}

/* ─── 节点 CRUD ────────────────────────────────────────── */

function publicNode(node) {
  const health = healthMap.get(node.id) || freshHealth();
  return {
    id: node.id,
    scheme: (() => { try { return new URL(node.url).protocol; } catch (e) { return ''; } })(),
    host: (() => { try { return new URL(node.url).hostname; } catch (e) { return ''; } })(),
    port: (() => {
      try {
        const u = new URL(node.url);
        return u.port || defaultPortForScheme(u.protocol);
      } catch (e) { return ''; }
    })(),
    maskedUrl: maskProxyUrl(node.url),
    name: node.name || '',
    disabled: !!node.disabled,
    createdAt: node.createdAt || null,
    health: {
      successCount: health.successCount,
      failCount: health.failCount,
      consecutiveFailures: health.consecutiveFailures,
      lastTestMs: health.lastTestMs,
      lastSuccessAt: health.lastSuccessAt,
      lastFailAt: health.lastFailAt,
      cooldownUntil: health.cooldownUntil,
      coolingDown: health.cooldownUntil > Date.now(),
    },
  };
}

function freshHealth() {
  return {
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    lastTestMs: null,
    lastSuccessAt: null,
    lastFailAt: null,
    cooldownUntil: 0,
  };
}

export function listProxyNodes() {
  bootstrapFromEnv();
  return readNodesRaw().map(publicNode);
}

export function addProxyNode(rawUrl, name = '') {
  bootstrapFromEnv();
  const url = parseProxyUrl(rawUrl);
  if (!url) {
    throw new Error('代理 URL 无效，仅支持 http://、https://、socks5://');
  }
  const id = nodeIdFromUrl(url);
  const nodes = readNodesRaw();
  if (nodes.some(n => n.id === id)) {
    throw new Error('该代理节点已存在');
  }
  const node = { id, url, name: String(name || '').trim(), disabled: false, createdAt: new Date().toISOString() };
  nodes.push(node);
  writeNodesRaw(nodes);
  return publicNode(node);
}

export function deleteProxyNode(id) {
  bootstrapFromEnv();
  const nodes = readNodesRaw();
  const filtered = nodes.filter(n => n.id !== id);
  if (filtered.length === nodes.length) {
    throw new Error('代理节点不存在');
  }
  writeNodesRaw(filtered);
  // 关闭并移除 dispatcher 缓存
  const cached = dispatcherCache.get(id);
  if (cached) {
    try { cached.dispatcher.close(); } catch (e) { /* ignore */ }
    dispatcherCache.delete(id);
  }
  healthMap.delete(id);
}

export function toggleProxyNode(id, disabled) {
  bootstrapFromEnv();
  const nodes = readNodesRaw();
  const node = nodes.find(n => n.id === id);
  if (!node) throw new Error('代理节点不存在');
  node.disabled = !!disabled;
  writeNodesRaw(nodes);
  return publicNode(node);
}

export function importProxyNodes(text) {
  bootstrapFromEnv();
  const items = parseNodeList(text);
  let added = 0;
  let skipped = 0;
  for (const raw of items) {
    const url = parseProxyUrl(raw);
    if (!url) { skipped++; continue; }
    const id = nodeIdFromUrl(url);
    const nodes = readNodesRaw();
    if (nodes.some(n => n.id === id)) { skipped++; continue; }
    nodes.push({ id, url, name: '', disabled: false, createdAt: new Date().toISOString() });
    writeNodesRaw(nodes);
    added++;
  }
  return { added, skipped };
}

/* ─── dispatcher 缓存 ──────────────────────────────────── */

export function getDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const id = nodeIdFromUrl(proxyUrl);
  const cached = dispatcherCache.get(id);
  if (cached && cached.url === proxyUrl) return cached.dispatcher;

  let u;
  try {
    u = new URL(proxyUrl);
  } catch (e) {
    throw new Error('代理 URL 无效');
  }
  const scheme = u.protocol.toLowerCase();
  let dispatcher;
  if (scheme === 'socks5:' || scheme === 'socks:') {
    // Socks5ProxyAgent 接收 URL 字符串（首参），支持从 URL 提取 username/password
    dispatcher = new Socks5ProxyAgent(proxyUrl);
  } else {
    // http/https ProxyAgent 接收 { uri } 选项
    dispatcher = new ProxyAgent({ uri: proxyUrl });
  }
  dispatcherCache.set(id, { dispatcher, url: proxyUrl });
  return dispatcher;
}

/* ─── 健康度与选择 ──────────────────────────────────────── */

export function recordProxyResult(url, ok, ms = null, err = null) {
  if (!url) return;
  let id;
  try { id = nodeIdFromUrl(url); } catch (e) { return; }
  let health = healthMap.get(id) || freshHealth();
  const now = Date.now();
  if (ok) {
    health.successCount++;
    health.consecutiveFailures = 0;
    health.cooldownUntil = 0;
    health.lastSuccessAt = new Date().toISOString();
    if (ms != null && Number.isFinite(ms)) health.lastTestMs = ms;
  } else {
    health.failCount++;
    health.consecutiveFailures++;
    health.lastFailAt = new Date().toISOString();
    if (ms != null && Number.isFinite(ms)) health.lastTestMs = ms;
    const backoff = COOLDOWN_BASE_MS * Math.pow(2, Math.min(health.consecutiveFailures - 1, 6));
    health.cooldownUntil = now + Math.min(COOLDOWN_CAP_MS, backoff);
  }
  healthMap.set(id, health);
}

function eligibleNodes() {
  bootstrapFromEnv();
  const now = Date.now();
  return readNodesRaw().filter(n => !n.disabled);
}

function pickRoundRobin(candidates) {
  if (candidates.length === 0) return null;
  const now = Date.now();
  const ready = candidates.filter(n => (healthMap.get(n.id)?.cooldownUntil || 0) <= now);
  const pool = ready.length > 0 ? ready : candidates;
  if (pool.length === 0) return null;
  // round-robin 游标在 ready 池上推进
  const node = pool[rrCursor % pool.length];
  rrCursor = (rrCursor + 1) % pool.length;
  return node;
}

function pickRandom(candidates) {
  if (candidates.length === 0) return null;
  const now = Date.now();
  const ready = candidates.filter(n => (healthMap.get(n.id)?.cooldownUntil || 0) <= now);
  let pool = ready;
  if (pool.length === 0) {
    // 全部冷却：选 cooldownUntil 最近的
    pool = [...candidates].sort((a, b) => {
      const ca = healthMap.get(a.id)?.cooldownUntil || 0;
      const cb = healthMap.get(b.id)?.cooldownUntil || 0;
      return ca - cb;
    });
  }
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

/**
 * 获取一个可用代理（不标记使用）。
 * - 池启用且有可用节点：返回 { url, dispatcher }
 * - 池禁用或空，但 PROXY_URL 有值：返回 { url: PROXY_URL, dispatcher }
 * - 否则返回 null（直连）
 */
export function acquireProxy() {
  bootstrapFromEnv();
  if (isProxyPoolEnabled()) {
    const candidates = eligibleNodes();
    if (candidates.length > 0) {
      const strategy = getProxyPoolStrategy();
      const node = strategy === 'random' ? pickRandom(candidates) : pickRoundRobin(candidates);
      if (node) {
        return { url: node.url, dispatcher: getDispatcher(node.url) };
      }
    }
  }
  // 降级到 PROXY_URL
  if (config.proxyUrl) {
    const valid = parseProxyUrl(config.proxyUrl);
    if (valid) {
      return { url: valid, dispatcher: getDispatcher(valid) };
    }
  }
  return null;
}

/* ─── 测试单个节点 ─────────────────────────────────────── */

const TEST_URL = 'https://www.google.com/generate_204';
const TEST_TIMEOUT_MS = 10000;

export async function testProxyNode(id) {
  bootstrapFromEnv();
  const nodes = readNodesRaw();
  const node = nodes.find(n => n.id === id);
  if (!node) throw new Error('代理节点不存在');

  const dispatcher = getDispatcher(node.url);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let ok = false;
  let error = null;
  try {
    const res = await fetch(TEST_URL, {
      dispatcher,
      signal: controller.signal,
      headers: { 'User-Agent': 'stagewise-2api/1.0' },
    });
    // generate_204 返回 204
    ok = res.ok || res.status === 204;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    if (err.name === 'AbortError') {
      error = `超时 (${TEST_TIMEOUT_MS / 1000}s)`;
    } else {
      error = err.message || '测试失败';
    }
  } finally {
    clearTimeout(timer);
  }
  const elapsed = Date.now() - start;
  recordProxyResult(node.url, ok, elapsed, error);
  return { ok, elapsedMs: elapsed, error };
}

/**
 * 用于脱敏展示降级代理（不返回凭证）。
 */
export function maskedFallbackProxy() {
  const valid = parseProxyUrl(config.proxyUrl);
  return valid ? maskProxyUrl(valid) : null;
}
