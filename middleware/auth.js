import { config } from '../config.js';
import { getNextToken } from '../services/account-pool.js';

/**
 * Token 提取中间件
 * 优先：请求头 → 账号池轮询 → .env 默认 token
 *
 * 只对需要转发到 Stagewise 的端点消费 token。
 * 管理端点（/v1/pool, /v1/models, /v1/auth, /v1/usage/pool）不消耗轮询。
 */

// 不需要消费池 token 的路径（使用 req.originalUrl 因为挂载在 /v1）
const SKIP_POOL_PATHS = ['/v1/pool', '/v1/models', '/v1/auth', '/v1/usage/pool', '/v1/settings', '/v1/register'];

export function extractToken(req, res, next) {
  // 管理端点不消费池 token（使用 originalUrl 获取完整路径）
  const fullPath = req.originalUrl || req.baseUrl + req.path;
  const shouldSkipPool = SKIP_POOL_PATHS.some(p => fullPath.startsWith(p));

  // 1. 请求头
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    req.token = auth.slice(7);
    req.tokenSource = 'header';
    return next();
  }

  // 2. 账号池轮询（仅对 API 转发端点）
  if (!shouldSkipPool) {
    const poolToken = getNextToken();
    if (poolToken) {
      req.token = poolToken.token;
      req.tokenSource = 'pool';
      req.accountEmail = poolToken.email;
      req.accountId = poolToken.accountId;
      return next();
    }
  }

  // 3. .env 默认 token
  if (config.defaultToken) {
    req.token = config.defaultToken;
    req.tokenSource = 'env';
    return next();
  }

  // 无可用 token
  req.token = null;
  next();
}
