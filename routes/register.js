import express from 'express';
import { autoRegister } from '../services/auto-register.js';
import * as mailProvider from '../services/mail-provider.js';
import * as proxyPool from '../services/proxy-pool.js';

const router = express.Router();

const MAX_LOGS = 1000;
const MAX_RESULTS = 1000;

let currentRegisterJob = null;

function clampInt(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

function createAbortError() {
  const err = new Error('注册已停止');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.message === '注册已停止';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isActiveJob(job = currentRegisterJob) {
  return job && (job.status === 'running' || job.status === 'stopping');
}

function appendJobLog(job, step, message, index = null) {
  if (!job) return;
  const entry = { time: new Date().toISOString(), step, message };
  if (index !== null && index !== undefined) entry.index = index;
  job.logs.push(entry);
  if (job.logs.length > MAX_LOGS * 2) {
    job.logs.splice(0, job.logs.length - MAX_LOGS);
  }
}

function publicJob(job = currentRegisterJob) {
  if (!job) return null;
  const logs = job.logs.length > MAX_LOGS ? job.logs.slice(-MAX_LOGS) : job.logs;
  let results = job.results;
  if (Array.isArray(results) && results.length > MAX_RESULTS) {
    results = results.slice(-MAX_RESULTS);
  }
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    params: job.params || null,
    progress: job.progress ? { ...job.progress } : null,
    logs,
    results: results || [],
    summary: job.summary || null,
  };
}

function startRegisterJob(type) {
  if (isActiveJob()) return null;
  const controller = new AbortController();
  currentRegisterJob = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    controller,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
    params: null,
    progress: null,
    logs: [],
    results: [],
  };
  return currentRegisterJob;
}

function finishRegisterJob(job, status, summary = null) {
  if (!job || currentRegisterJob?.id !== job.id) return;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  job.summary = summary;
}

/**
 * POST /v1/register/auto — 自动注册 Stagewise 账号
 * Body: { prefix?, addToPool?, maxWait? }
 */
router.post('/auto', async (req, res) => {
  const job = startRegisterJob('auto');
  if (!job) {
    return res.status(409).json({
      success: false,
      error: '已有自动注册任务正在运行，请先停止或等待完成',
      job: publicJob(),
    });
  }

  const { prefix, addToPool, maxWait } = req.body || {};
  const normalizedMaxWait = clampInt(maxWait, 60000, 10000, 300000);
  job.params = { prefix: prefix || null, addToPool: addToPool ?? true, maxWait: normalizedMaxWait };
  job.progress = { total: 1, started: 0, completed: 0, success: 0, failed: 0, cancelled: 0, currentIndex: 0 };

  appendJobLog(job, 'start', '🚀 开始注册', 0);
  job.progress.started = 1;

  let proxyStart = Date.now();
  let acquired = null;
  let proxyLabel = '直连';
  try {
    acquired = await proxyPool.acquireProxy();
    proxyLabel = acquired ? (acquired.label || proxyPool.maskProxyUrl(acquired.url)) : '直连';
    appendJobLog(job, 'proxy', `代理: ${proxyLabel}`, 0);
    throwIfAborted(job.controller.signal);
    const result = await autoRegister({
      prefix,
      addToPool: addToPool ?? true,
      maxWait: normalizedMaxWait,
      signal: job.controller.signal,
      dispatcher: acquired?.dispatcher,
      proxyLabel,
      onProgress: (step, message) => appendJobLog(job, step, message, 0),
    });

    if (acquired && acquired.mode !== 'mihomo') {
      proxyPool.recordProxyResult(acquired.mode === 'direct' ? acquired.nodeId : acquired.url, true, Date.now() - proxyStart);
    }
    job.results[0] = { index: 0, success: true, email: result.email, provider: result.provider };
    job.progress.success = 1;
    job.progress.completed = 1;
    appendJobLog(job, 'done', `✅ 注册成功: ${result.email}`, 0);
    const summary = { total: 1, success: 1, failed: 0, cancelled: 0, email: result.email };
    finishRegisterJob(job, 'completed', summary);
    res.json({ success: true, email: result.email, token: result.token, provider: result.provider, jobId: job.id, logs: job.logs });
  } catch (err) {
    if (acquired && acquired.mode !== 'mihomo') {
      proxyPool.recordProxyResult(acquired.mode === 'direct' ? acquired.nodeId : acquired.url, false, Date.now() - proxyStart, err.message);
    }
    if (isAbortError(err) || job.controller.signal.aborted) {
      job.results[0] = { index: 0, success: false, cancelled: true, error: '注册已停止' };
      job.progress.cancelled = 1;
      job.progress.completed = 1;
      appendJobLog(job, 'cancelled', '⏹ 注册已停止', 0);
      const summary = { total: 1, success: 0, failed: 0, cancelled: 1 };
      finishRegisterJob(job, 'cancelled', summary);
      return res.json({ success: false, cancelled: true, error: '注册已停止', jobId: job.id, logs: job.logs });
    }
    job.results[0] = { index: 0, success: false, error: err.message };
    job.progress.failed = 1;
    job.progress.completed = 1;
    appendJobLog(job, 'error', `❌ 注册失败: ${err.message}`, 0);
    finishRegisterJob(job, 'failed', { total: 1, success: 0, failed: 1, cancelled: 0, error: err.message });
    res.status(500).json({ success: false, error: err.message, jobId: job.id, logs: job.logs });
  }
});

/**
 * POST /v1/register/batch — 批量自动注册
 * Body: { count: 100, concurrency?: 1, delayMs?: 3000, maxWait?: 60000 }
 * count 最大 1000；concurrency 1-5；delayMs 0-60000；maxWait 10000-300000
 */
router.post('/batch', async (req, res) => {
  const job = startRegisterJob('batch');
  if (!job) {
    return res.status(409).json({
      success: false,
      error: '已有自动注册任务正在运行，请先停止或等待完成',
      job: publicJob(),
    });
  }

  const body = req.body || {};
  const total = clampInt(body.count, 100, 1, 1000);
  const concurrency = clampInt(body.concurrency, 1, 1, 5);
  const delayMs = clampInt(body.delayMs, 3000, 0, 60000);
  const maxWait = clampInt(body.maxWait, 60000, 10000, 300000);
  job.params = { count: total, concurrency, delayMs, maxWait };
  job.progress = { total, started: 0, completed: 0, success: 0, failed: 0, cancelled: 0, currentIndex: null };
  job.results = new Array(total);
  let nextIndex = 0;
  let nextStartAt = Date.now();

  appendJobLog(job, 'start', `🚀 批量注册 ${total} 个账号，并发 ${concurrency}，间隔 ${delayMs}ms`);

  async function waitForStartSlot() {
    if (delayMs <= 0) return;
    throwIfAborted(job.controller.signal);
    const now = Date.now();
    const scheduledAt = nextStartAt;
    nextStartAt = Math.max(nextStartAt, now) + delayMs;
    const waitMs = Math.max(0, scheduledAt - now);
    if (waitMs > 0) await sleep(waitMs, job.controller.signal);
    throwIfAborted(job.controller.signal);
  }

  async function runOne(index) {
    const proxyStart = Date.now();
    let acquired = null;
    let proxyLabel = '直连';
    try {
      acquired = await proxyPool.acquireProxy();
      proxyLabel = acquired ? (acquired.label || proxyPool.maskProxyUrl(acquired.url)) : '直连';
      throwIfAborted(job.controller.signal);
      appendJobLog(job, 'account-queued', `账号 #${index + 1} 等待启动`, index);
      await waitForStartSlot();
      throwIfAborted(job.controller.signal);
      job.progress.started++;
      job.progress.currentIndex = index;
      appendJobLog(job, 'account-start', `账号 #${index + 1} 开始 · 代理 ${proxyLabel}`, index);
      const result = await autoRegister({
        addToPool: true,
        maxWait,
        signal: job.controller.signal,
        dispatcher: acquired?.dispatcher,
        proxyLabel,
        onProgress: (step, message) => appendJobLog(job, step, message, index),
      });
      if (acquired && acquired.mode !== 'mihomo') {
        proxyPool.recordProxyResult(acquired.mode === 'direct' ? acquired.nodeId : acquired.url, true, Date.now() - proxyStart);
      }
      job.results[index] = { index, success: true, email: result.email, provider: result.provider };
      job.progress.success++;
      job.progress.completed++;
      appendJobLog(job, 'account-done', `✅ #${index + 1} 成功: ${result.email}`, index);
    } catch (err) {
      if (acquired && acquired.mode !== 'mihomo') {
        proxyPool.recordProxyResult(acquired.mode === 'direct' ? acquired.nodeId : acquired.url, false, Date.now() - proxyStart, err.message);
      }
      const cancelled = isAbortError(err) || job.controller.signal.aborted;
      job.results[index] = {
        index,
        success: false,
        cancelled,
        error: cancelled ? '注册已停止' : err.message,
      };
      if (cancelled) job.progress.cancelled++;
      else job.progress.failed++;
      job.progress.completed++;
      appendJobLog(
        job,
        cancelled ? 'account-cancelled' : 'account-failed',
        cancelled ? `⏹ #${index + 1} 已停止` : `❌ #${index + 1} 失败: ${err.message}`,
        index,
      );
    }
  }

  async function worker() {
    while (nextIndex < total && !job.controller.signal.aborted) {
      const index = nextIndex++;
      await runOne(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  if (job.controller.signal.aborted) {
    for (let i = 0; i < total; i++) {
      if (!job.results[i]) {
        job.results[i] = { index: i, success: false, cancelled: true, error: '注册已停止' };
        job.progress.cancelled++;
        job.progress.completed++;
      }
    }
    appendJobLog(job, 'cancelled', '⏹ 批量注册已停止');
  } else {
    appendJobLog(job, 'done', '📊 批量注册完成');
  }

  const summary = {
    total,
    concurrency,
    delayMs,
    maxWait,
    success: job.progress.success,
    failed: job.progress.failed,
    cancelled: job.progress.cancelled,
  };

  finishRegisterJob(job, job.controller.signal.aborted ? 'cancelled' : 'completed', summary);

  res.json({
    success: !job.controller.signal.aborted,
    jobId: job.id,
    cancelled: job.controller.signal.aborted,
    results: job.results,
    summary,
  });
});

/**
 * POST /v1/register/stop — 停止当前自动注册任务
 */
router.post('/stop', (req, res) => {
  const job = currentRegisterJob;
  if (!isActiveJob(job)) {
    return res.json({ success: true, stopped: false, job: publicJob(job) });
  }

  job.status = 'stopping';
  if (!job.controller.signal.aborted) job.controller.abort();
  res.json({ success: true, stopped: true, jobId: job.id, job: publicJob(job) });
});

/**
 * GET /v1/register/status — 当前/最近自动注册任务状态
 */
router.get('/status', (req, res) => {
  res.json({ success: true, job: publicJob() });
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
