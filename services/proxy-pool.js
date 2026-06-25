/**
 * 代理池（多协议订阅版）
 *
 * 数据模型（持久化于 SQLite settings 表）:
 *   ProxyNode: {
 *     id,                 // canonical sanitized proxy object 的 sha256 hash
 *     type,               // mihomo proxy type: http/socks5/ss/vmess/vless/trojan/hysteria2/tuic...
 *     name,               // 节点名（裁剪后）
 *     executor,           // 'direct' | 'mihomo'：direct 用 undici 直接代理；mihomo 由 mihomo 聚合
 *     disabled,           // 是否禁用
 *     source,             // 'env' | 'manual' | 'import' | 'subscription'
 *     subscriptionId,    // 订阅 ID（可选，仅订阅导入时设置）
 *     proxy,              // 清洗后的 mihomo proxy object，是生成 config 的 source of truth
 *     rawUri?,            // 仅 URI 导入时保留；API/WebUI/日志不返回
 *     createdAt, updatedAt
 *   }
 *
 *   NodeHealth（仅内存）: { successCount, failCount, consecutiveFailures, lastTestMs, lastSuccessAt, lastFailAt, cooldownUntil }
 *
 * 兼容：旧 `{ id, url, name, disabled, createdAt }` 节点读取时转为新模型。
 *
 * 安全：
 *   - API/publicNode 永不返回 proxy / rawUri。
 *   - 日志只输出 masked host 或 `mihomo:REG_AUTO`。
 *   - importProxyNodes 返回 { added, skipped, invalid, total }，不含 secret。
 */

import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';

// 直接执行（direct）协议：可以用 undici 自行代理，不需要 mihomo
const DIRECT_TYPES = new Set(['http', 'socks5', 'socks']);
// 全部支持的 mihomo proxy type（导入/解析层）
const SUPPORTED_TYPES = new Set([
  'http', 'socks5', 'socks',
  'ss', 'vmess', 'vless', 'trojan',
  'hysteria2', 'hy2', 'tuic',
]);

const COOLDOWN_CAP_MS = 30 * 60 * 1000; // 最大冷却 30 分钟
const COOLDOWN_BASE_MS = 30 * 1000; // 基础冷却 30s
const SETTINGS_KEY_ENABLED = 'proxy_pool_enabled';
const SETTINGS_KEY_STRATEGY = 'proxy_pool_strategy';
const SETTINGS_KEY_MIHOMO_STRATEGY = 'proxy_pool_mihomo_strategy';
// 沿用旧 key：旧 {id,url,name,...} 节点在 readNodesRaw → migrateLegacyNode 时自动转为新模型
const SETTINGS_KEY_NODES = 'proxy_pool_nodes';

// 导入限制
const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const IMPORT_MAX_NODES = 2000;
const NODE_NAME_MAX = 128;
const NODE_FIELD_MAX = 1024;

// dispatcher 缓存：direct 节点 id → { dispatcher, url }
const dispatcherCache = new Map();
let mihomoDispatcherCache = null;

// 健康度：id → NodeHealth（仅 direct 节点用）
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

function isTruthy(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function defaultPortForType(type) {
  switch (type) {
    case 'http': return 80;
    case 'https': return 443;
    case 'socks5':
    case 'socks': return 1080;
    case 'ss': return 8388;
    case 'vmess': return 443;
    case 'vless': return 443;
    case 'trojan': return 443;
    case 'hysteria2':
    case 'hy2': return 443;
    case 'tuic': return 443;
    default: return 0;
  }
}

function truncate(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

function safeStr(value) {
  if (value == null) return '';
  return String(value);
}

/* ─── 节点 ID：sanitized proxy object 的 sha256 ─────────── */

function canonicalizeProxy(proxy) {
  // 用规范化后的完整代理对象做 hash；排除展示名，避免同一节点仅改名就重复导入。
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        if (key === 'name') continue;
        out[key] = normalize(value[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(normalize(proxy || {}));
}

function nodeIdFromProxy(proxy) {
  const canon = canonicalizeProxy(proxy);
  return createHash('sha256').update(canon).digest('hex');
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

/* ─── 旧数据迁移：旧 {id,url,name,...} 节点 → 新模型 ─────── */

function migrateLegacyNode(n) {
  if (n && n.proxy && n.type && n.executor) return n; // 已是新模型
  if (!n || !n.url) return null;
  try {
    const u = new URL(n.url);
    const scheme = u.protocol.toLowerCase().replace(':', '');
    const type = scheme === 'socks5' || scheme === 'socks' ? 'socks5' : scheme === 'https' ? 'http' : scheme === 'http' ? 'http' : scheme;
    if (!SUPPORTED_TYPES.has(type)) return null;
    const port = Number(u.port || defaultPortForType(type) || '');
    const proxy = {
      type,
      name: truncate(n.name || u.hostname, NODE_NAME_MAX),
      server: u.hostname,
      port,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(scheme === 'https' ? { tls: true } : {}),
    };
    const id = nodeIdFromProxy(proxy);
    return {
      id,
      type: proxy.type,
      name: proxy.name,
      executor: 'direct',
      disabled: !!n.disabled,
      source: n.source || 'env',
      subscriptionId: null,
      proxy,
      rawUri: undefined,
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

function bootstrapFromEnv() {
  if (bootstrapped) return;
  bootstrapped = true;

  // 先迁移旧节点
  const existing = readNodesRaw().map(migrateLegacyNode).filter(Boolean);
  if (existing.length > 0) {
    writeNodesRaw(existing);
    if (!config.proxyPoolUrls) return;
  }

  // 旧 env 种子
  const urls = String(config.proxyPoolUrls || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (urls.length === 0) return;

  const now = new Date().toISOString();
  const seen = new Set(existing.map(n => n.id));
  const nodes = [...existing];
  for (const raw of urls) {
    const parsed = parseSingleUri(raw);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    nodes.push({
      id: parsed.id,
      type: parsed.proxy.type,
      name: parsed.proxy.name || truncate(parsed.proxy.server, NODE_NAME_MAX),
      executor: DIRECT_TYPES.has(parsed.proxy.type) ? 'direct' : 'mihomo',
      disabled: false,
      source: 'env',
      subscriptionId: null,
      proxy: parsed.proxy,
      rawUri: undefined,
      createdAt: now,
      updatedAt: now,
    });
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

export function getMihomoGroupStrategy() {
  const dbValue = getSetting(SETTINGS_KEY_MIHOMO_STRATEGY, null);
  if (dbValue) {
    const v = String(dbValue).trim().toLowerCase();
    if (v === 'fallback' || v === 'url-test' || v === 'load-balance') return v;
  }
  const envValue = String(config.mihomoGroupStrategy || 'fallback').trim().toLowerCase();
  return (envValue === 'url-test' || envValue === 'load-balance') ? envValue : 'fallback';
}

export function updateProxyPoolSettings({ enabled, strategy, mihomoStrategy }) {
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
  if (mihomoStrategy !== undefined && mihomoStrategy !== null) {
    const v = String(mihomoStrategy).trim().toLowerCase();
    if (v === 'fallback' || v === 'url-test' || v === 'load-balance') {
      setSetting(SETTINGS_KEY_MIHOMO_STRATEGY, v);
    } else {
      throw new Error('mihomoStrategy 只能是 fallback / url-test / load-balance');
    }
  }
}

/* ─── 公共视图（脱敏，绝不返回 proxy/rawUri） ──────────── */

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

function maskedServerOf(proxy) {
  try {
    const host = proxy && proxy.server;
    if (!host) return '';
    // 仅保留 host 末两段（域名）或 IPv4 末两段，端口不隐藏（端口对脱敏意义不大）
    if (typeof host === 'string') {
      const parts = host.split('.');
      if (parts.length >= 2) {
        return '*.' + parts.slice(-2).join('.');
      }
      return host;
    }
    return String(host || '');
  } catch (e) {
    return '';
  }
}

function publicNode(node) {
  const health = healthMap.get(node.id) || freshHealth();
  const proxy = node.proxy || {};
  const port = Number(proxy.port || defaultPortForType(node.type) || 0) || 0;
  return {
    id: node.id,
    type: node.type || '',
    name: node.name || '',
    executor: node.executor || 'direct',
    maskedServer: maskedServerOf(proxy),
    port,
    source: node.source || '',
    disabled: !!node.disabled,
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || null,
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

export function listProxyNodes() {
  bootstrapFromEnv();
  return readNodesRaw().map(publicNode);
}

function findNodeRaw(id) {
  return readNodesRaw().find(n => n.id === id) || null;
}

/* ─── 节点 CRUD ────────────────────────────────────────── */

export function addProxyNode(uriOrUrl, name = '', source = 'manual') {
  bootstrapFromEnv();
  const parsed = parseSingleUri(uriOrUrl);
  if (!parsed) {
    throw new Error('节点 URI 无效，仅支持 http(s)/socks5/ss/vmess/vless/trojan/hysteria2/tuic');
  }
  const nodes = readNodesRaw();
  if (nodes.some(n => n.id === parsed.id)) {
    throw new Error('该代理节点已存在');
  }
  const now = new Date().toISOString();
  const node = {
    id: parsed.id,
    type: parsed.proxy.type,
    name: truncate(name || parsed.proxy.name || parsed.proxy.server, NODE_NAME_MAX),
    executor: DIRECT_TYPES.has(parsed.proxy.type) ? 'direct' : 'mihomo',
    disabled: false,
    source,
    subscriptionId: null,
    proxy: parsed.proxy,
    rawUri: parsed.rawUri,
    createdAt: now,
    updatedAt: now,
  };
  // 覆盖 name
  node.proxy.name = node.name;
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
  node.updatedAt = new Date().toISOString();
  writeNodesRaw(nodes);
  return publicNode(node);
}

/* ─── 订阅 / 批量导入解析 ───────────────────────────────── */

function tolerantBase64Decode(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim().replace(/\s+/g, '');
  if (!s) return null;
  // URL-safe → standard
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  // pad
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad === 1) return null; // 1 char leftover is invalid
  try {
    // Node 16+ supports atob; Buffer also works
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function looksLikeYaml(text) {
  // Clash YAML 通常以 `proxies:` 或包含 `proxies:\n  - name:` 之类
  if (!text) return false;
  if (/^proxies\s*:\s*\n/i.test(text)) return true;
  if (/\nproxies\s*:\s*\n/i.test(text)) return true;
  // 也可能是带 `mixed-port:` 之类的完整 Clash config
  if (/^(mixed-port|port|socks-port|allow-lan|external-controller|dns|proxies|proxy-groups|rules|tun|script)\s*:/m.test(text)) {
    return true;
  }
  return false;
}

function sanitizeProxyObject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let type = String(raw.type || '').toLowerCase().trim();
  if (type === 'hy2') type = 'hysteria2';
  if (type === 'socks') type = 'socks5';
  if (!SUPPORTED_TYPES.has(type)) return null;
  const server = String(raw.server || '').trim();
  if (!server) return null;
  const port = Number(raw.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const obj = { type, name: truncate(safeStr(raw.name || server), NODE_NAME_MAX), server, port };

  // 通用字段（按需复制，限制长度）
  const copyStr = (key) => {
    const v = raw[key];
    if (v != null && v !== '') obj[key] = truncate(safeStr(v), NODE_FIELD_MAX);
  };
  const copyNum = (key) => {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) obj[key] = v;
  };
  const copyBool = (key) => {
    if (raw[key] != null) obj[key] = !!raw[key];
  };

  // 类型特定字段
  switch (type) {
    case 'http':
    case 'socks5':
    case 'socks':
      copyStr('username');
      copyStr('password');
      if (type === 'http') {
        copyBool('tls');
        copyStr('sni');
        copyStr('servername');
        copyBool('skip-cert-verify');
      }
      if (type === 'socks5' || type === 'socks') {
        copyStr('username');
        copyStr('password');
        copyNum('udp');
      }
      break;
    case 'ss':
      copyStr('cipher');
      copyStr('password');
      copyStr('plugin');
      if (raw['plugin-opts'] && typeof raw['plugin-opts'] === 'object') {
        obj['plugin-opts'] = sanitizePlainObject(raw['plugin-opts']);
      } else {
        copyStr('plugin-opts');
      }
      break;
    case 'vmess':
      copyStr('uuid');
      copyNum('alterId');
      copyStr('cipher');
      copyStr('network');
      copyStr('servername');
      copyBool('tls');
      copyStr('sni');
      copyBool('skip-cert-verify');
      if (raw['ws-opts']) obj['ws-opts'] = sanitizeWsOpts(raw['ws-opts']);
      if (raw['grpc-opts'] && raw['grpc-opts']) obj['grpc-opts'] = { 'grpc-service-name': truncate(safeStr(raw['grpc-opts']['grpc-service-name']), NODE_FIELD_MAX) };
      if (raw['h2-opts']) obj['h2-opts'] = raw['h2-opts'];
      copyStr('host');
      copyStr('path');
      break;
    case 'vless':
      copyStr('uuid');
      copyStr('network');
      copyStr('flow');
      copyBool('tls');
      copyStr('servername');
      copyStr('sni');
      copyBool('skip-cert-verify');
      if (raw['reality-opts']) obj['reality-opts'] = sanitizeRealityOpts(raw['reality-opts']);
      if (raw['ws-opts']) obj['ws-opts'] = sanitizeWsOpts(raw['ws-opts']);
      if (raw['grpc-opts']) obj['grpc-opts'] = { 'grpc-service-name': truncate(safeStr(raw['grpc-opts']['grpc-service-name']), NODE_FIELD_MAX) };
      copyStr('host');
      copyStr('path');
      break;
    case 'trojan':
      copyStr('password');
      copyStr('network');
      copyBool('tls');
      copyStr('sni');
      copyStr('servername');
      copyBool('skip-cert-verify');
      if (raw['ws-opts']) obj['ws-opts'] = sanitizeWsOpts(raw['ws-opts']);
      if (raw['grpc-opts']) obj['grpc-opts'] = { 'grpc-service-name': truncate(safeStr(raw['grpc-opts']['grpc-service-name']), NODE_FIELD_MAX) };
      copyStr('host');
      copyStr('path');
      break;
    case 'hysteria2':
    case 'hy2':
      copyStr('password');
      copyStr('obfs');
      copyStr('obfs-password');
      copyStr('sni');
      copyStr('servername');
      copyBool('skip-cert-verify');
      copyNum('up');
      copyNum('down');
      break;
    case 'tuic':
      copyStr('uuid');
      copyStr('password');
      copyStr('congestion-controller');
      copyStr('udp-relay-mode');
      copyStr('sni');
      copyStr('servername');
      copyBool('skip-cert-verify');
      copyNum('alpn');
      break;
  }

  // 通用 alpn
  if (raw.alpn) {
    if (Array.isArray(raw.alpn)) obj.alpn = raw.alpn.map(s => truncate(safeStr(s), 32)).slice(0, 8);
    else obj.alpn = [truncate(safeStr(raw.alpn), 32)];
  }

  return obj;
}

function sanitizeWsOpts(ws) {
  if (!ws || typeof ws !== 'object') return undefined;
  const o = {};
  if (ws.path) o.path = truncate(safeStr(ws.path), NODE_FIELD_MAX);
  if (ws.headers && typeof ws.headers === 'object') {
    o.headers = {};
    for (const [k, v] of Object.entries(ws.headers)) {
      o.headers[k] = truncate(safeStr(v), NODE_FIELD_MAX);
    }
  }
  return o;
}

function sanitizeRealityOpts(r) {
  if (!r || typeof r !== 'object') return undefined;
  const o = {};
  if (r['public-key']) o['public-key'] = truncate(safeStr(r['public-key']), NODE_FIELD_MAX);
  if (r['short-id']) o['short-id'] = truncate(safeStr(r['short-id']), 32);
  if (r['private-key']) o['private-key'] = truncate(safeStr(r['private-key']), NODE_FIELD_MAX);
  if (r['spider-x']) o['spider-x'] = truncate(safeStr(r['spider-x']), NODE_FIELD_MAX);
  return o;
}

function sanitizePlainObject(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (v == null) continue;
    out[k] = truncate(safeStr(v), NODE_FIELD_MAX);
  }
  return out;
}

/* ─── URI → mihomo proxy object ─────────────────────────── */

function parseSingleUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return null;
  const uri = rawUri.trim();
  if (!uri) return null;

  try {
    const schemeMatch = uri.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
    if (!schemeMatch) return null;
    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === 'http' || scheme === 'https' || scheme === 'socks5' || scheme === 'socks') {
      return parseHttpSocksUri(uri, scheme);
    }
    if (scheme === 'vmess') return parseVmessUri(uri);
    if (scheme === 'vless') return parseVlessTrojanUri(uri, 'vless');
    if (scheme === 'trojan') return parseVlessTrojanUri(uri, 'trojan');
    if (scheme === 'ss') return parseSsUri(uri);
    if (scheme === 'hysteria2' || scheme === 'hy2') return parseHysteria2Uri(uri, scheme === 'hy2' ? 'hysteria2' : scheme);
    if (scheme === 'tuic') return parseTuicUri(uri);
    return null;
  } catch (e) {
    return null;
  }
}

function parseHttpSocksUri(uri, scheme) {
  const u = new URL(uri);
  const type = (scheme === 'socks5' || scheme === 'socks') ? 'socks5' : 'http';
  const port = Number(u.port || defaultPortForType(type));
  const proxy = {
    type,
    name: truncate(u.hostname, NODE_NAME_MAX),
    server: u.hostname,
    port,
  };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  if (scheme === 'https') proxy.tls = true;
  const hash = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
  if (hash) proxy.name = truncate(hash, NODE_NAME_MAX);
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

function parseVmessUri(uri) {
  // vmess://base64(json)
  const b64 = uri.slice('vmess://'.length);
  const json = tolerantBase64Decode(b64);
  if (!json) return null;
  let obj;
  try { obj = JSON.parse(json); } catch (e) { return null; }
  if (!obj || !obj.add || !obj.id) return null;
  const proxy = {
    type: 'vmess',
    name: truncate(safeStr(obj.ps || obj.add), NODE_NAME_MAX),
    server: String(obj.add).trim(),
    port: Number(obj.port) || 443,
    uuid: String(obj.id).trim(),
    alterId: Number(obj.aid != null ? obj.aid : 0) || 0,
    cipher: String(obj.scy || obj.cipher || 'auto'),
    network: String(obj.net || 'tcp').toLowerCase(),
    tls: obj.tls === 'tls' || obj.tls === true,
  };
  if (obj.sni) proxy.sni = String(obj.sni);
  if (obj.sni || obj.host) proxy.servername = String(obj.sni || obj.host || '');
  if (obj.path) proxy.path = truncate(safeStr(obj.path), NODE_FIELD_MAX);
  if (obj.host) proxy.host = truncate(safeStr(obj.host), NODE_FIELD_MAX);
  if (proxy.network === 'ws') {
    proxy['ws-opts'] = {
      path: proxy.path || '/',
      ...(proxy.host ? { headers: { Host: proxy.host } } : {}),
    };
  }
  if (proxy.network === 'grpc' && obj.path) {
    proxy['grpc-opts'] = { 'grpc-service-name': truncate(safeStr(obj.path), NODE_FIELD_MAX) };
  }
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

function parseVlessTrojanUri(uri, type) {
  // vless/trojan: scheme://uuid-or-password@host:port?params#name
  const u = new URL(uri);
  const cred = type === 'vless' ? decodeURIComponent(u.username) : decodeURIComponent(u.username);
  if (!cred) return null;
  const port = Number(u.port || 443);
  const proxy = {
    type,
    name: truncate(decodeURIComponent(u.hash ? u.hash.slice(1) : u.hostname) || u.hostname, NODE_NAME_MAX),
    server: u.hostname,
    port,
  };
  if (type === 'vless') proxy.uuid = cred;
  else proxy.password = cred;

  const q = u.searchParams;
  const security = (q.get('security') || q.get('tls') || '').toLowerCase();
  const network = (q.get('type') || '').toLowerCase();
  if (network) proxy.network = network;
  if (security === 'tls' || security === 'reality' || type === 'trojan') proxy.tls = true;
  if (security === 'reality') {
    proxy['reality-opts'] = {};
    if (q.get('pbk') || q.get('public-key')) proxy['reality-opts']['public-key'] = q.get('pbk') || q.get('public-key');
    if (q.get('sid') || q.get('short-id')) proxy['reality-opts']['short-id'] = q.get('sid') || q.get('short-id');
    if (q.get('spx') || q.get('spider-x')) proxy['reality-opts']['spider-x'] = q.get('spx') || q.get('spider-x');
  }
  const sni = q.get('sni') || q.get('servername') || q.get('serverName') || q.get('server_name');
  if (sni) { proxy.sni = sni; proxy.servername = sni; }
  const fp = q.get('fp') || q.get('fingerprint') || q.get('client-fingerprint');
  if (fp) proxy['client-fingerprint'] = fp;
  const insecure = q.get('allowInsecure') || q.get('allow_insecure') || q.get('insecure') || q.get('skip-cert-verify');
  if (insecure === '1' || insecure === 'true') proxy['skip-cert-verify'] = true;
  const alpn = q.get('alpn');
  if (alpn) proxy.alpn = alpn.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  if (q.get('flow')) proxy.flow = q.get('flow');
  if (q.get('host')) proxy.host = q.get('host');
  if (q.get('path')) proxy.path = q.get('path');
  if (network === 'ws') {
    proxy['ws-opts'] = {
      path: proxy.path || '/',
      ...(proxy.host ? { headers: { Host: proxy.host } } : {}),
    };
  }
  if (network === 'grpc' && q.get('serviceName')) {
    proxy['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') };
  }
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

function parseSsUri(uri) {
  // ss://base64(method:password)@host:port#name   OR   ss://base64(method:password@host:port)#name
  let body = uri.slice('ss://'.length);
  let hashName = '';
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    hashName = decodeURIComponent(body.slice(hashIdx + 1));
    body = body.slice(0, hashIdx);
  }
  let query = '';
  const queryIdx = body.indexOf('?');
  if (queryIdx >= 0) {
    query = body.slice(queryIdx + 1);
    body = body.slice(0, queryIdx);
  }
  let method = '', password = '', server = '', port = 0;

  // 形式 1：ss://base64@host:port
  const atIdx = body.lastIndexOf('@');
  if (atIdx >= 0) {
    const userInfo = body.slice(0, atIdx);
    const hostPort = body.slice(atIdx + 1).replace(/\/$/, '');
    // userinfo 可能是 base64(method:password) 或 method:password
    let decoded = userInfo;
    if (!userInfo.includes(':')) {
      const d = tolerantBase64Decode(userInfo);
      if (d && d.includes(':')) decoded = d;
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    method = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
    const m = hostPort.match(/^\[?([^\]]+)\]?:(\d+)$/);
    if (!m) return null;
    server = m[1];
    port = Number(m[2]);
  } else {
    // 形式 2：ss://base64(整段 method:password@host:port)
    const decoded = tolerantBase64Decode(body);
    if (!decoded) return null;
    const at = decoded.lastIndexOf('@');
    if (at < 0) return null;
    const userInfo = decoded.slice(0, at);
    const hostPort = decoded.slice(at + 1).replace(/\/$/, '');
    const colon = userInfo.indexOf(':');
    if (colon < 0) return null;
    method = userInfo.slice(0, colon);
    password = userInfo.slice(colon + 1);
    const m = hostPort.match(/^\[?([^\]]+)\]?:(\d+)$/);
    if (!m) return null;
    server = m[1];
    port = Number(m[2]);
  }

  if (!method || !password || !server || !port) return null;
  const proxy = {
    type: 'ss',
    name: truncate(hashName || server, NODE_NAME_MAX),
    server,
    port,
    cipher: method,
    password,
  };
  if (query) {
    const params = new URLSearchParams(query);
    const plugin = params.get('plugin');
    if (plugin) {
      const parts = decodeURIComponent(plugin).split(';').filter(Boolean);
      if (parts.length > 0) {
        proxy.plugin = parts[0];
        const opts = {};
        for (const part of parts.slice(1)) {
          const [k, ...rest] = part.split('=');
          if (!k) continue;
          opts[k] = rest.join('=') || true;
        }
        if (Object.keys(opts).length > 0) proxy['plugin-opts'] = opts;
      }
    }
  }
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

function parseHysteria2Uri(uri, type) {
  // hysteria2://password@host:port?sni=...&obfs=...#name
  // hy2://...
  const u = new URL(uri);
  const password = decodeURIComponent(u.username);
  if (!password) return null;
  const port = Number(u.port || 443);
  const proxy = {
    type: 'hysteria2',
    name: truncate(decodeURIComponent(u.hash ? u.hash.slice(1) : u.hostname) || u.hostname, NODE_NAME_MAX),
    server: u.hostname,
    port,
    password,
  };
  const q = u.searchParams;
  if (q.get('sni')) proxy.sni = q.get('sni');
  if (q.get('sni')) proxy.servername = q.get('sni');
  if (q.get('obfs')) proxy.obfs = q.get('obfs');
  if (q.get('obfs-password')) proxy['obfs-password'] = q.get('obfs-password');
  if (q.get('insecure') === '1' || q.get('insecure') === 'true') proxy['skip-cert-verify'] = true;
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

function parseTuicUri(uri) {
  // tuic://uuid:password@host:port?sni=...&congestion_control=...#name
  const u = new URL(uri);
  const uuid = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!uuid) return null;
  const port = Number(u.port || 443);
  const proxy = {
    type: 'tuic',
    name: truncate(decodeURIComponent(u.hash ? u.hash.slice(1) : u.hostname) || u.hostname, NODE_NAME_MAX),
    server: u.hostname,
    port,
    uuid,
    password,
  };
  const q = u.searchParams;
  if (q.get('sni')) proxy.sni = q.get('sni');
  if (q.get('sni')) proxy.servername = q.get('sni');
  if (q.get('congestion_control')) proxy['congestion-controller'] = q.get('congestion_control');
  if (q.get('udp_relay_mode')) proxy['udp-relay-mode'] = q.get('udp_relay_mode');
  if (q.get('alpn')) proxy.alpn = [q.get('alpn')];
  if (q.get('allow_insecure') === '1') proxy['skip-cert-verify'] = true;
  return { id: nodeIdFromProxy(proxy), proxy, rawUri: uri };
}

/* ─── 订阅导入主入口 ───────────────────────────────────── */

function parseProxiesFromText(text) {
  const out = [];
  let invalid = 0;
  let total = 0;
  if (!text || typeof text !== 'string') return { items: out, invalid, total };

  // 1) Clash / Mihomo YAML
  if (looksLikeYaml(text)) {
    try {
      const doc = parseYaml(text);
      if (doc && Array.isArray(doc.proxies)) {
        total = doc.proxies.length;
        for (const p of doc.proxies) {
          const cleaned = sanitizeProxyObject(p);
          if (!cleaned) { invalid++; continue; }
          out.push({ proxy: cleaned, rawUri: undefined });
        }
        if (out.length > 0 || total > 0) return { items: out, invalid, total }; // 命中即返回，不再尝试其它解析
      }
    } catch (e) {
      // fallthrough
    }
  }

  // 2) 尝试整体 base64 解码（允许多行 wrap）
  let lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const joined = lines.join('');
  if (joined && !/^[a-z]+:\/\//i.test(lines[0] || '')) {
    const decoded = tolerantBase64Decode(joined);
    if (decoded && /(\n|^)[a-z]+:\/\//i.test(decoded)) {
      lines = decoded.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
  }

  // 3) 逐行 URI
  total = lines.length;
  for (const line of lines) {
    if (!line) continue;
    const parsed = parseSingleUri(line);
    if (parsed) {
      out.push({ proxy: parsed.proxy, rawUri: parsed.rawUri });
    } else {
      invalid++;
    }
  }
  return { items: out, invalid, total };
}

export function importProxyNodes(text, options = {}) {
  bootstrapFromEnv();
  if (typeof text !== 'string') text = '';
  if (text.length > IMPORT_MAX_BYTES) {
    throw new Error(`导入文本过大（>${IMPORT_MAX_BYTES} 字节）`);
  }

  const subscriptionId = options.subscriptionId || null;
  const source = options.source || 'import';

  const parsedResult = parseProxiesFromText(text);
  const parsed = parsedResult.items;
  const total = parsedResult.total;
  let added = 0;
  let skipped = 0;
  let invalid = parsedResult.invalid;

  // 先全部读出来一次，导入完成后一次性写
  const nodes = readNodesRaw();
  const seen = new Set(nodes.map(n => n.id));

  const now = new Date().toISOString();
  for (const item of parsed) {
    if (added >= IMPORT_MAX_NODES) {
      // 超过本次导入上限的有效条目计入 skipped
      skipped++;
      continue;
    }
    const proxy = item.proxy;
    if (!proxy || !proxy.type || !proxy.server || !proxy.port) {
      invalid++;
      continue;
    }
    const id = nodeIdFromProxy(proxy);
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);
    proxy.name = proxy.name || truncate(proxy.server, NODE_NAME_MAX);
    const node = {
      id,
      type: proxy.type,
      name: truncate(proxy.name, NODE_NAME_MAX),
      executor: DIRECT_TYPES.has(proxy.type) ? 'direct' : 'mihomo',
      disabled: false,
      source,
      subscriptionId,
      proxy,
      rawUri: item.rawUri,
      createdAt: now,
      updatedAt: now,
    };
    nodes.push(node);
    added++;
  }

  if (added > 0) writeNodesRaw(nodes);

  return { added, skipped, invalid, total };
}

/* ─── 内部辅助：direct 节点 dispatcher ─────────────────── */

function proxyObjectToUrl(proxy) {
  // 仅用于 http/socks5 direct 节点，生成带凭证的 URL（不输出日志）
  if (!proxy || !proxy.server) return null;
  const type = proxy.type;
  if (type !== 'http' && type !== 'socks5' && type !== 'socks') return null;
  const scheme = type === 'socks5' || type === 'socks' ? 'socks5' : (proxy.tls ? 'https' : 'http');
  const port = proxy.port || defaultPortForType(type);
  let auth = '';
  if (proxy.username || proxy.password) {
    const u = encodeURIComponent(proxy.username || '');
    const p = encodeURIComponent(proxy.password || '');
    auth = `${u}:${p}@`;
  }
  return `${scheme}://${auth}${proxy.server}:${port}`;
}

export function getDispatcherForNode(node) {
  if (!node || !node.proxy) return null;
  const url = proxyObjectToUrl(node.proxy);
  if (!url) return null;
  const cached = dispatcherCache.get(node.id);
  if (cached && cached.url === url) return cached.dispatcher;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new Error('代理 URL 无效');
  }
  const scheme = u.protocol.toLowerCase();
  let dispatcher;
  if (scheme === 'socks5:' || scheme === 'socks:') {
    dispatcher = new Socks5ProxyAgent(url);
  } else {
    dispatcher = new ProxyAgent({ uri: url });
  }
  dispatcherCache.set(node.id, { dispatcher, url });
  return dispatcher;
}

/* ─── 健康度与选择 ──────────────────────────────────────── */

export function recordProxyResult(labelOrUrl, ok, ms = null, err = null) {
  if (!labelOrUrl) return;
  // direct 模式：传入的是 node id 或 proxy url（旧 register.js 仍传 url）
  let id = null;
  if (typeof labelOrUrl === 'string' && /^[a-f0-9]{64}$/.test(labelOrUrl)) {
    id = labelOrUrl;
  } else {
    // 旧 url 形态：用 url → direct node id
    try {
      const u = new URL(labelOrUrl);
      const type = u.protocol.toLowerCase().replace(':', '') === 'socks5' ? 'socks5'
        : u.protocol.toLowerCase().replace(':', '') === 'https' ? 'http' : 'http';
      const proxy = {
        type,
        server: u.hostname,
        port: Number(u.port || defaultPortForType(type)),
        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      };
      id = nodeIdFromProxy(proxy);
    } catch (e) {
      return;
    }
  }
  // mihomo aggregate 模式不在此处冷却（mode guard 由调用方保证）
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

function eligibleDirectNodes() {
  bootstrapFromEnv();
  return readNodesRaw().filter(n => !n.disabled && n.executor === 'direct' && n.proxy);
}

function pickRoundRobin(candidates) {
  if (candidates.length === 0) return null;
  const now = Date.now();
  const ready = candidates.filter(n => (healthMap.get(n.id)?.cooldownUntil || 0) <= now);
  const pool = ready.length > 0 ? ready : candidates;
  if (pool.length === 0) return null;
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
    pool = [...candidates].sort((a, b) => {
      const ca = healthMap.get(a.id)?.cooldownUntil || 0;
      const cb = healthMap.get(b.id)?.cooldownUntil || 0;
      return ca - cb;
    });
  }
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

/**
 * 是否存在启用的高级（mihomo）节点。
 */
export function hasAdvancedNodes() {
  bootstrapFromEnv();
  return readNodesRaw().some(n => !n.disabled && n.executor === 'mihomo' && n.proxy);
}

export function getEnabledAdvancedNodes() {
  bootstrapFromEnv();
  return readNodesRaw()
    .filter(n => !n.disabled && n.executor === 'mihomo' && n.proxy)
    .map(n => n.proxy);
}

export function getEnabledMihomoNodes() {
  bootstrapFromEnv();
  return readNodesRaw()
    .filter(n => !n.disabled && n.proxy)
    .map(n => n.proxy);
}

/**
 * 获取一个可用代理（不标记使用）。
 * 语义：
 *   A. 池禁用：fallback PROXY_URL 或直连（返回 null）。
 *   B. 池启用 + 仅有 direct http/socks 节点：per-node dispatcher，label = masked host。
 *   C. 池启用 + 存在 advanced 节点：ensure mihomo running，返回本地 http://127.0.0.1:<mixed-port> ProxyAgent。
 *   D. advanced 节点存在但 mihomo 不可用：fail closed（throw clear error）。
 *
 * 返回形态：{ url, dispatcher, label?, mode? }
 *   - direct: { url, dispatcher, label: 'host:port', mode: 'direct' }
 *   - mihomo: { url: 'http://127.0.0.1:<port>', dispatcher, label: 'mihomo:REG_AUTO', mode: 'mihomo' }
 *   - none:   null
 */
export async function acquireProxy() {
  bootstrapFromEnv();
  const enabled = isProxyPoolEnabled();

  if (enabled) {
    const advanced = hasAdvancedNodes();
    if (advanced) {
      // C / D
      if (!config.mihomoEnabled) {
        throw new Error('代理池存在高级协议节点但 MIHOMO_ENABLED=false，已拒绝直连（fail closed）');
      }
      const mihomo = await import('./mihomo-manager.js');
      const status = await mihomo.ensureRunning();
      if (!status || !status.running) {
        const reason = status && status.lastError ? status.lastError : 'mihomo 不可用';
        throw new Error(`代理池存在高级协议节点，但 mihomo 不可启动：${reason}（fail closed）`);
      }
      const url = `http://127.0.0.1:${status.port}`;
      if (!mihomoDispatcherCache || mihomoDispatcherCache.url !== url) {
        try { mihomoDispatcherCache?.dispatcher?.close?.(); } catch (e) { /* ignore */ }
        mihomoDispatcherCache = { url, dispatcher: new ProxyAgent({ uri: url }) };
      }
      const dispatcher = mihomoDispatcherCache.dispatcher;
      return { url, dispatcher, label: 'mihomo:REG_AUTO', mode: 'mihomo' };
    }

    // B：direct 节点
    const candidates = eligibleDirectNodes();
    if (candidates.length > 0) {
      const strategy = getProxyPoolStrategy();
      const node = strategy === 'random' ? pickRandom(candidates) : pickRoundRobin(candidates);
      if (node) {
        const url = proxyObjectToUrl(node.proxy);
        const dispatcher = getDispatcherForNode(node);
        if (!url || !dispatcher) {
          throw new Error('代理池 direct 节点无法创建 dispatcher，已拒绝直连（fail closed）');
        }
        const label = maskProxyUrl(url);
        return { url, dispatcher, label, mode: 'direct', nodeId: node.id };
      }
    }
  }

  // A：fallback PROXY_URL
  if (config.proxyUrl) {
    try {
      const u = new URL(config.proxyUrl);
      const type = u.protocol.toLowerCase().replace(':', '') === 'socks5' ? 'socks5' : 'http';
      const proxy = {
        type,
        server: u.hostname,
        port: Number(u.port || defaultPortForType(type)),
        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      };
      const id = nodeIdFromProxy(proxy);
      const url = config.proxyUrl;
      const cached = dispatcherCache.get(id);
      const dispatcher = cached && cached.url === url
        ? cached.dispatcher
        : (u.protocol === 'socks5:' || u.protocol === 'socks:'
          ? new Socks5ProxyAgent(url)
          : new ProxyAgent({ uri: url }));
      if (!cached) dispatcherCache.set(id, { dispatcher, url });
      return { url, dispatcher, label: maskProxyUrl(url), mode: 'fallback' };
    } catch (e) {
      // fallthrough to null
    }
  }
  return null;
}

/* ─── 测试单个节点 ─────────────────────────────────────── */

const TEST_URL = config.mihomoTestUrl || 'https://www.gstatic.com/generate_204';
const TEST_TIMEOUT_MS = 10000;

export async function testProxyNode(id) {
  bootstrapFromEnv();
  const node = findNodeRaw(id);
  if (!node) throw new Error('代理节点不存在');

  if (node.executor === 'mihomo') {
    // advanced 节点：触发 mihomo ensure running，返回聚合测试结果
    const mihomo = await import('./mihomo-manager.js');
    const status = await mihomo.ensureRunning();
    if (!status || !status.running) {
      return { ok: false, elapsedMs: 0, error: status?.lastError || 'mihomo 不可用', aggregate: true };
    }
    const url = `http://127.0.0.1:${status.port}`;
    const dispatcher = new ProxyAgent({ uri: url });
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
      ok = res.ok || res.status === 204;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err.name === 'AbortError' ? `超时 (${TEST_TIMEOUT_MS / 1000}s)` : (err.message || '测试失败');
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - start;
    return { ok, elapsedMs: elapsed, error, aggregate: true };
  }

  // direct 节点
  const url = proxyObjectToUrl(node.proxy);
  if (!url) throw new Error('节点不支持 direct 测试');
  const dispatcher = getDispatcherForNode(node);
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
  recordProxyResult(node.id, ok, elapsed, error);
  return { ok, elapsedMs: elapsed, error };
}

/**
 * 用于脱敏展示降级代理（不返回凭证）。
 */
export function maskedFallbackProxy() {
  if (!config.proxyUrl) return null;
  return maskProxyUrl(config.proxyUrl);
}

/**
 * 给 routes 概览用：返回 mihomo 状态（不含 secret/config）。
 */
export async function getMihomoStatus() {
  try {
    const mihomo = await import('./mihomo-manager.js');
    return mihomo.getStatus();
  } catch (e) {
    return { available: false, running: false, lastError: e.message };
  }
}

/**
 * 供 mihomo-manager 重启触发：节点变更后调用。
 */
export function notifyNodesChanged() {
  // 仅触发 mihomo-manager 在下次 ensureRunning 时重新生成 config；
  // 由 mihomo-manager 自身维护 lastConfigHash。
  return true;
}
