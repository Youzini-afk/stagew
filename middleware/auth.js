import { config } from '../config.js';
import { getNextToken } from '../services/account-pool.js';

/**
 * Token 提取中间件
 * 优先：请求头 → 账号池轮询 → .env 默认 token
 *
 * 只对需要转发到 Stagewise 的端点消费 token。
 * 管理端点（/v1/pool, /v1/models, /v1/auth, /v1/usage/pool）不消耗轮询。
 *
 * 防滥用：
 *  - 如果设置了 PROXY_API_KEY/API_KEY，且请求要使用账号池或 .env 默认 token，
 *    则客户端必须传 Authorization: Bearer <PROXY_API_KEY> 或 X-API-Key: <PROXY_API_KEY>。
 *  - 如果客户端传了 Authorization 但不是 PROXY_API_KEY，视为直接 Stagewise token，不走账号池，不拦截。
 *  - 未设置 PROXY_API_KEY 时保持旧行为（可无 key 使用账号池/.env token）。
 */

// 不需要消费池 token 的路径（使用 req.originalUrl 因为挂载在 /v1）
const SKIP_POOL_PATHS = ['/v1/pool', '/v1/models', '/v1/auth', '/v1/usage/pool', '/v1/settings', '/v1/register', '/v1/proxy-pool'];

/**
 * 从请求头读取 Bearer token（去掉 "Bearer " 前缀），没有则返回 null。
 */
function readBearer(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

export function extractToken(req, res, next) {
  // 管理端点不消费池 token（使用 originalUrl 获取完整路径）
  const fullPath = req.originalUrl || req.baseUrl + req.path;
  const shouldSkipPool = SKIP_POOL_PATHS.some(p => fullPath.startsWith(p));

  // 1. 请求头 Bearer
  const bearer = readBearer(req);

  // 启用了代理 API Key 防护
  const proxyKey = config.proxyApiKey;
  if (proxyKey) {
    if (bearer === proxyKey) {
      // 客户端用 PROXY_API_KEY，走账号池/.env 流程（不要当作 Stagewise token）
    } else if (bearer) {
      // 不是 PROXY_API_KEY，但有 Bearer：当作直传 Stagewise token，透传不拦截
      req.token = bearer;
      req.tokenSource = 'header';
      return next();
    } else {
      // 没有 Bearer。检查 X-API-Key
      const xKey = req.headers['x-api-key'];
      if (xKey === proxyKey) {
        // 走账号池/.env 流程
      } else {
        // 既没有正确 PROXY_API_KEY 也没有直传 token
        // 不允许使用账号池/.env token；管理端点交给后续 requireAdmin 处理
        if (!shouldSkipPool) {
          return res.status(401).json({
            error: {
              message: '需要 API Key 才能使用账号池（设置 PROXY_API_KEY）。请在 Authorization: Bearer 或 X-API-Key 传入。',
              type: 'auth_error',
            },
          });
        }
        req.token = null;
        return next();
      }
    }
  } else if (bearer) {
    // 未启用代理 key 防护：旧行为，请求头 token 优先
    req.token = bearer;
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

/**
 * 管理后台鉴权中间件
 *  - 支持 Authorization: Bearer <ADMIN_TOKEN> 或 X-Admin-Token: <ADMIN_TOKEN>
 *  - 未设置 ADMIN_TOKEN：一律 503，不放行（公网部署必须配置）
 *  - token 不匹配：401
 *  - 不把 token 写入日志或响应
 */
export function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    return res.status(503).json({
      error: {
        message: '管理接口未启用：请在环境变量中设置 ADMIN_TOKEN 后重启服务。',
        type: 'admin_not_configured',
      },
    });
  }

  const bearer = readBearer(req);
  const xAdmin = req.headers['x-admin-token'];
  const provided = bearer === config.adminToken || xAdmin === config.adminToken;

  if (!provided) {
    return res.status(401).json({
      error: {
        message: '管理接口需要 ADMIN_TOKEN 鉴权。',
        type: 'auth_error',
      },
    });
  }

  next();
}
