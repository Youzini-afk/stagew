/**
 * mihomo 子进程管理
 *
 * 职责：
 *   - 根据 proxy-pool 中启用的高级节点生成受控 mihomo config（仅 127.0.0.1）。
 *   - start/stop/restart mihomo 子进程；spawn shell:false。
 *   - config 文件写入私有目录（DATA_DIR/mihomo 或 /data/mihomo），尽量 chmod 0600/0700。
 *   - 不返回/不日志 secret 与 config 内容。
 *
 * 安全：
 *   - 状态接口（getStatus）返回 { available, running, pid, port, controllerPort, group, nodeCount, lastError, startedAt }。
 *   - 绝不返回 secret / config 路径 / config 内容。
 *
 * 失败：
 *   - mihomo binary 缺失或启动失败：返回 running:false 并记录 lastError（不含 config 内容）。
 */

import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { config } from '../config.js';
import { getEnabledAdvancedNodes, getEnabledMihomoNodes, getMihomoGroupStrategy } from './proxy-pool.js';

const MIHOMO_GROUP = 'REG_AUTO';
const REG_AUTO = MIHOMO_GROUP;

let state = {
  available: false,
  running: false,
  pid: null,
  port: 0,
  controllerPort: 0,
  group: MIHOMO_GROUP,
  nodeCount: 0,
  lastError: null,
  startedAt: null,
};

let child = null;
let configPath = null;
let secret = null;
let configHash = '';
let ensurePromise = null;

function resolveDataDir() {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  if (process.env.DB_PATH) return dirname(resolve(process.env.DB_PATH));
  return resolve('data');
}

function resolveMihomoDir() {
  const dir = join(resolveDataDir(), 'mihomo');
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch (e) { /* ignore */ }
  return dir;
}

function resolveBinaryPath() {
  return (config.mihomoPath && String(config.mihomoPath).trim()) || 'mihomo';
}

function generateSecret() {
  return randomBytes(24).toString('hex');
}

function sanitizeProxyForConfig(proxy) {
  // mihomo 需要每个 proxy 有唯一 name；用 server+port+随机后缀保证
  if (!proxy || !proxy.type) return null;
  const name = proxy.name || `${proxy.type}-${proxy.server || 'unknown'}-${proxy.port || 0}`;
  return { ...proxy, name };
}

function uniqueNames(proxies) {
  const used = new Set();
  return proxies.map((p, i) => {
    let base = (p && p.name) ? String(p.name) : `node-${i}`;
    let name = base;
    let n = 1;
    while (used.has(name)) {
      name = `${base}-${n++}`;
    }
    used.add(name);
    return { ...p, name };
  });
}

function buildConfig(proxies, opts = {}) {
  const strategy = opts.strategy || 'fallback';
  const mixedPort = opts.mixedPort || config.mihomoMixedPort || 7890;
  const controllerPort = opts.controllerPort || config.mihomoControllerPort || 9090;
  const testUrl = opts.testUrl || config.mihomoTestUrl || 'https://www.gstatic.com/generate_204';
  const ctrlSecret = opts.secret || generateSecret();

  const clean = uniqueNames(proxies.map(sanitizeProxyForConfig).filter(Boolean));

  const cfg = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret: ctrlSecret,
    proxies: clean,
    'proxy-groups': [
      {
        name: MIHOMO_GROUP,
        type: strategy,
        proxies: clean.map(p => p.name),
        ...(strategy === 'url-test' ? { url: testUrl, interval: 300 } : {}),
        ...(strategy === 'fallback' ? { url: testUrl, interval: 300 } : {}),
        ...(strategy === 'load-balance' ? { strategy: 'consistent-hashing', url: testUrl, interval: 300 } : {}),
      },
    ],
    rules: ['MATCH,REG_AUTO'],
  };
  return { config: cfg, secret: ctrlSecret, nodeCount: clean.length, mixedPort, controllerPort };
}

function configToString(cfg) {
  // 序列化为 YAML（mihomo 接受 .yaml config）
  return stringifyYaml(cfg);
}

function computeConfigHash(text) {
  return createHash('sha256').update(text || '').digest('hex');
}

function killChild() {
  if (child) {
    try {
      child.kill('SIGTERM');
      const c = child;
      setTimeout(() => {
        try { c.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }, 1500);
    } catch (e) { /* ignore */ }
    child = null;
  }
}

function startChild(cfgPath) {
  const bin = resolveBinaryPath();
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, ['-f', cfgPath, '-d', dirname(cfgPath)], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (e) {
      resolve({ ok: false, error: `启动 mihomo 失败：${e.message}` });
      return;
    }

    let stderrBuffer = '';
    const stderrTimeout = setTimeout(() => {
      // 5s 内未崩溃即认为启动成功（mihomo 通常会持续运行）
      // 仅当 proc 仍存活时认为成功
      if (proc.exitCode === null && proc.signalCode === null) {
        clearTimeout(stderrTimeout);
        resolve({ ok: true, pid: proc.pid, process: proc });
      }
    }, 3000);

    proc.on('error', (err) => {
      clearTimeout(stderrTimeout);
      // ENOENT 表示 binary 不存在
      let msg = err.message || 'mihomo 启动失败';
      if (err.code === 'ENOENT') msg = 'mihomo 二进制不存在（ENOENT）';
      resolve({ ok: false, error: msg });
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(stderrTimeout);
      if (code === 0 || code === null) {
        // 启动期间退出：可能 config 错误
        // 取 stderr 末尾一行作错误（不含 secret/config 全文）
        const lastLine = stderrBuffer.trim().split(/\r?\n/).pop() || '';
        const safeError = lastLine ? `mihomo 启动后立即退出: ${scrubMihomoError(lastLine)}` : 'mihomo 启动后立即退出';
        resolve({ ok: false, error: safeError });
      } else {
        const lastLine = stderrBuffer.trim().split(/\r?\n/).pop() || '';
        resolve({ ok: false, error: `mihomo 退出（code=${code}）${lastLine ? ': ' + scrubMihomoError(lastLine) : ''}` });
      }
    });
  });
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}

function scrubMihomoError(message) {
  if (!message) return '';
  let s = String(message);
  s = s.replace(/\b(?:ss|vmess|vless|trojan|hysteria2|hy2|tuic):\/\/[^\s'"`]+/gi, '[proxy-uri]');
  s = s.replace(/(password|passwd|pwd|uuid|secret|token|key|authorization)\s*[:=]\s*[^\s,}]+/gi, '$1=[secret]');
  s = s.replace(/(\b[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}\b)/g, '[uuid]');
  s = s.replace(/([A-Za-z0-9+/_-]{24,}={0,2})/g, '[secret]');
  if (/address already in use|bind:.*in use|端口.*占用/i.test(s)) return '端口已被占用';
  if (/no such file|ENOENT|not found|不存在/i.test(s)) return 'mihomo 二进制不存在';
  if (/parse|yaml|config|unmarshal|invalid/i.test(s)) return '配置解析失败';
  return truncate(s, 160);
}

/**
 * 确保 mihomo 在运行（若 advanced 节点变化则重启）。
 * 返回 getStatus() 同构对象。
 */
export async function ensureRunning() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = doEnsureRunning().finally(() => { ensurePromise = null; });
  return ensurePromise;
}

async function doEnsureRunning() {
  const advancedCount = getEnabledAdvancedNodes().length;
  const proxies = advancedCount > 0 ? getEnabledMihomoNodes() : [];
  const nodeCount = proxies.length;

  if (advancedCount === 0) {
    // 无高级节点：停止 mihomo（若有运行）
    stop();
    return { ...state, available: true, running: false, nodeCount: 0 };
  }

  const strategy = getMihomoGroupStrategy();
  const built = buildConfig(proxies, { strategy, secret: secret || undefined });
  const configText = configToString(built.config);
  const hash = computeConfigHash(configText);

  // 检查 binary 是否可用（避免每次 ensure 都 spawn）
  if (!state.available && !existsSync(resolveBinaryPath()) && resolveBinaryPath() === 'mihomo') {
    // 'mihomo' 在 PATH 中查找；这里仅作标记，实际由 spawn 决定
  }

  if (state.running && child && hash === configHash) {
    // 配置未变，无需重启
    return { ...state, available: true, running: true, nodeCount: built.nodeCount, port: built.mixedPort, controllerPort: built.controllerPort };
  }

  // 配置变化或未启动：写 config + 启动
  const dir = resolveMihomoDir();
  configPath = join(dir, 'config.yaml');
  try {
    writeFileSync(configPath, configText, { mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch (e) { /* ignore */ }
  } catch (e) {
    state = { ...state, available: true, running: false, lastError: `写 config 失败: ${e.message}`, nodeCount: built.nodeCount };
    return state;
  }
  secret = built.secret;
  configHash = hash;

  // 先停旧
  killChild();
  state = { ...state, running: false, lastError: null, nodeCount: built.nodeCount, port: built.mixedPort, controllerPort: built.controllerPort };

  const result = await startChild(configPath);
  if (result.ok) {
    child = result.process;
    state = {
      ...state,
      available: true,
      running: true,
      pid: result.pid,
      port: built.mixedPort,
      controllerPort: built.controllerPort,
      nodeCount: built.nodeCount,
      startedAt: new Date().toISOString(),
      lastError: null,
    };
    const proc = result.process;
    proc?.on?.('exit', () => {
      if (child !== proc) return;
      child = null;
      state = { ...state, running: false, pid: null, lastError: state.lastError || 'mihomo 进程退出' };
    });
  } else {
    state = {
      ...state,
      available: true,
      running: false,
      pid: null,
      lastError: result.error || 'mihomo 启动失败',
    };
  }
  return state;
}

/**
 * 停止 mihomo 子进程（保留 config 文件，但清空内存 secret）。
 */
export function stop() {
  killChild();
  secret = null;
  state = { ...state, running: false, pid: null };
  return state;
}

/**
 * 强制重启（删除旧 config 后重建）。
 */
export async function restart() {
  configHash = '';
  secret = null;
  return ensureRunning();
}

/**
 * 获取状态（不返回 secret/config）。
 */
export function getStatus() {
  return {
    available: !!state.available,
    running: !!state.running,
    pid: state.pid || null,
    port: state.port || 0,
    controllerPort: state.controllerPort || 0,
    group: MIHOMO_GROUP,
    nodeCount: state.nodeCount || 0,
    lastError: state.lastError || null,
    startedAt: state.startedAt || null,
  };
}

/**
 * 进程退出时清理。
 */
export function cleanup() {
  killChild();
}
