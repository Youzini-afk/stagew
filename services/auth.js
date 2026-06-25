import { config } from '../config.js';

/**
 * Stagewise Auth API 封装
 *
 * Stagewise 使用 Better Auth + Bearer Token
 * Auth flow:
 *   1. POST /v1/auth/email-otp/send-verification-otp → 发送验证码到邮箱
 *   2. POST /v1/auth/email-otp/verify-email → 验证验证码 → 获取 token
 *
 * Token 通过响应头 `set-auth-token` 返回
 */

const AUTH_BASE = `${config.apiUrl}/v1/auth`;

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

function extractErrorMessage(text) {
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    return data?.message || data?.error?.message || data?.error || data?.detail || text;
  } catch (err) {
    return text;
  }
}

/**
 * 发送邮件验证码
 * @param {string} email - 邮箱地址
 * @param {string} type - 验证类型: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendOtp(email, type = 'sign-in') {
  try {
    const response = await fetch(`${AUTH_BASE}/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ email, type }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) {
        const waitHint = retryAfter !== null ? `，请等待 ${retryAfter} 秒后再试` : '，请稍后再试';
        const message = extractErrorMessage(text);
        return {
          success: false,
          status: response.status,
          retryAfter,
          error: `触发频率限制${waitHint}${message ? `: ${message}` : ''}`,
        };
      }
      return {
        success: false,
        status: response.status,
        error: `发送验证码失败 (${response.status}): ${text}`,
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 验证邮件验证码 & 获取 Token
 * 注意：stagewise 使用 sign-in/email-otp 端点做登录验证
 * @param {string} email - 邮箱地址
 * @param {string} code - 6 位验证码
 * @returns {Promise<{success: boolean, token?: string, error?: string}>}
 */
export async function verifyOtp(email, code) {
  try {
    const response = await fetch(`${AUTH_BASE}/sign-in/email-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ email, otp: code }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `验证失败 (${response.status}): ${text}`,
      };
    }

    // Token 可以从 set-auth-token 响应头或响应体中获取
    const token = response.headers.get('set-auth-token');

    if (!token) {
      return { success: false, error: '验证成功但未获取到 token' };
    }

    return { success: true, token };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 检查会话状态
 * @param {string} token - Bearer token
 * @returns {Promise<{authenticated: boolean, user?: object, error?: string}>}
 */
export async function getSession(token) {
  try {
    const response = await fetch(`${AUTH_BASE}/get-session`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    });

    if (!response.ok) {
      return { authenticated: false };
    }

    const data = await response.json();
    return {
      authenticated: !!data,
      user: data?.user || data,
    };
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}

/**
 * 列出账号的所有活跃会话
 * @param {string} token - Bearer token
 * @returns {Promise<{success: boolean, sessions?: Array, error?: string}>}
 */
export async function listSessions(token) {
  try {
    const response = await fetch(`${AUTH_BASE}/list-sessions`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    });

    if (!response.ok) {
      return { success: false, error: `获取会话列表失败 (${response.status})` };
    }

    const data = await response.json();
    return { success: true, sessions: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 获取用量信息
 * @param {string} token - Bearer token
 * @returns {Promise<object>}
 */
export async function getUsage(token) {
  try {
    const response = await fetch(`${config.apiUrl}/v1/usage/current`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://console.stagewise.io',
        'User-Agent': 'stagewise-2api/1.0',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `获取用量失败 (${response.status}): ${text}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
