import express from 'express';
import {
  SUPPORTED_MAIL_PROVIDERS,
  formatDomains,
  getCfMailConfig,
  getMailConfig,
  getMailProviderName,
  saveMailConfig,
  saveMailProviderName,
  getAllSettings,
  setSetting,
  deleteSetting,
} from '../services/settings.js';

const SENSITIVE_SETTING_KEYS = new Set(['mail_token', 'cfmail_api_key']);

const router = express.Router();

function maskSecret(value) {
  if (!value) return '';
  value = String(value);
  if (value.length <= 8) return value.substring(0, 2) + '****';
  return value.substring(0, 4) + '****' + value.slice(-4);
}

function containsMaskedValue(value) {
  return typeof value === 'string' && value.includes('****');
}

function normalizeDomains(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeEndpoint(value, fallback) {
  const endpoint = String(value || '').trim();
  return endpoint || fallback;
}

/**
 * GET /v1/settings - 获取所有设置
 */
router.get('/', (req, res) => {
  try {
    const settings = getAllSettings();
    if (settings.mail_token) {
      settings.mail_token.value = maskSecret(settings.mail_token.value);
    }
    if (settings.cfmail_api_key) {
      settings.cfmail_api_key.value = maskSecret(settings.cfmail_api_key.value);
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
    const provider = getMailProviderName();
    const gptmail = getMailConfig();
    const cfmail = getCfMailConfig();
    res.json({
      provider,
      gptmail: {
        url: gptmail.url,
        token: maskSecret(gptmail.token),
        tokenLength: gptmail.token ? gptmail.token.length : 0,
      },
      cfmail: {
        apiBase: cfmail.apiBase,
        apiKey: maskSecret(cfmail.apiKey),
        apiKeyLength: cfmail.apiKey ? cfmail.apiKey.length : 0,
        domains: cfmail.domains,
        adminAuthHeader: cfmail.adminAuthHeader,
        adminAuthScheme: cfmail.adminAuthScheme,
        mailboxAuthHeader: cfmail.mailboxAuthHeader,
        mailboxAuthScheme: cfmail.mailboxAuthScheme,
        createEndpoint: cfmail.createEndpoint,
        listEndpoint: cfmail.listEndpoint,
        healthEndpoint: cfmail.healthEndpoint,
      },
      // 兼容旧前端
      url: gptmail.url,
      token: maskSecret(gptmail.token),
      tokenLength: gptmail.token ? gptmail.token.length : 0,
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
    const body = req.body || {};
    const provider = body.provider ? String(body.provider).trim().toLowerCase() : undefined;
    if (provider !== undefined && !SUPPORTED_MAIL_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'provider 只能是 gptmail 或 cfmail' });
    }

    const gptmail = body.gptmail || {};
    const legacyUrl = body.url;
    const legacyToken = body.token;
    const gptmailUrl = gptmail.url ?? legacyUrl;
    const gptmailToken = gptmail.token ?? legacyToken;
    const cfmail = body.cfmail || {};
    const hasCfmailConfig = Object.keys(cfmail).length > 0;

    if (containsMaskedValue(gptmailToken)) {
      return res.status(400).json({ error: '请填写完整 GPTMail token，或留空保持原配置' });
    }
    if (hasCfmailConfig && containsMaskedValue(cfmail.apiKey)) {
      return res.status(400).json({ error: '请填写完整 CFMail API Key，或留空保持原配置' });
    }

    if (provider === 'cfmail') {
      const currentCfmail = getCfMailConfig();
      const finalApiBase = cfmail.apiBase !== undefined
        ? String(cfmail.apiBase || '').trim()
        : String(currentCfmail.apiBase || '').trim();
      const finalApiKey = cfmail.apiKey
        ? String(cfmail.apiKey).trim()
        : String(currentCfmail.apiKey || '').trim();
      if (!finalApiBase) {
        return res.status(400).json({ error: '选择 CFMail 时必须配置 API Base' });
      }
      if (!finalApiKey) {
        return res.status(400).json({ error: '选择 CFMail 时必须配置 API Key' });
      }
    }

    if (gptmailUrl !== undefined || gptmailToken !== undefined) {
      if (gptmailUrl) saveMailConfig(String(gptmailUrl).trim(), gptmailToken ? String(gptmailToken).trim() : '');
      else if (gptmailToken) saveMailConfig('', String(gptmailToken).trim());
    }

    if (hasCfmailConfig) {
      if (cfmail.apiBase !== undefined) setSetting('cfmail_api_base', String(cfmail.apiBase || '').trim());
      if (cfmail.apiKey) setSetting('cfmail_api_key', String(cfmail.apiKey).trim());
      if (cfmail.domains !== undefined) setSetting('cfmail_domains', formatDomains(normalizeDomains(cfmail.domains)));
      if (cfmail.adminAuthHeader !== undefined) setSetting('cfmail_admin_auth_header', String(cfmail.adminAuthHeader || '').trim() || 'x-admin-auth');
      if (cfmail.adminAuthScheme !== undefined) setSetting('cfmail_admin_auth_scheme', String(cfmail.adminAuthScheme || '').trim() || 'raw');
      if (cfmail.mailboxAuthHeader !== undefined) setSetting('cfmail_mailbox_auth_header', String(cfmail.mailboxAuthHeader || '').trim() || 'Authorization');
      if (cfmail.mailboxAuthScheme !== undefined) setSetting('cfmail_mailbox_auth_scheme', String(cfmail.mailboxAuthScheme || '').trim() || 'bearer');
      if (cfmail.createEndpoint !== undefined) setSetting('cfmail_create_endpoint', normalizeEndpoint(cfmail.createEndpoint, '/admin/new_address'));
      if (cfmail.listEndpoint !== undefined) setSetting('cfmail_list_endpoint', normalizeEndpoint(cfmail.listEndpoint, '/api/mails'));
      if (cfmail.healthEndpoint !== undefined) setSetting('cfmail_health_endpoint', normalizeEndpoint(cfmail.healthEndpoint, '/healthz'));
    }

    if (provider !== undefined) saveMailProviderName(provider);

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
    if (SENSITIVE_SETTING_KEYS.has(String(key)) && containsMaskedValue(value)) {
      return res.status(400).json({ error: '敏感配置不能保存脱敏值，请填写完整值或使用 /v1/settings/mail 留空保持不变' });
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
