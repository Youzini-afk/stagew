// Stagewise 可用模型列表（从 app.asar 提取，2026-06-25 更新）
// 模型 ID 格式：{provider}/{modelId}

function m(id, owned_by, created = 1700000000) {
  return { id, object: 'model', created, owned_by, permission: [], root: id, parent: null };
}

export const STAGEWISE_MODELS = [
  // ─── Anthropic ──────────────────────────────────────────────────────
  m('claude-fable-5',          'anthropic', 1750000000),
  m('claude-mythos-5',         'anthropic', 1750000000),
  m('claude-mythos-preview',   'anthropic', 1749000000),
  m('claude-opus-4.8',         'anthropic', 1748000000),
  m('claude-opus-4.7',         'anthropic', 1747000000),
  m('claude-opus-4.6',         'anthropic', 1746000000),
  m('claude-opus-4.5',         'anthropic', 1745000000),
  m('claude-sonnet-4.6',       'anthropic', 1744000000),
  m('claude-sonnet-4.5',       'anthropic', 1743000000),
  m('claude-haiku-4.5',        'anthropic', 1742000000),

  // ─── OpenAI ─────────────────────────────────────────────────────────
  m('gpt-5.5',                 'openai',    1750000000),
  m('gpt-5.4',                 'openai',    1749000000),
  m('gpt-5.4-mini',            'openai',    1748500000),
  m('gpt-5.4-nano',            'openai',    1748000000),
  m('gpt-5.3-codex',           'openai',    1747000000),
  m('gpt-5.3-chat',            'openai',    1746500000),
  m('gpt-5.2',                 'openai',    1745000000),
  m('gpt-5.1',                 'openai',    1744000000),
  m('gpt-5',                   'openai',    1743000000),
  m('gpt-5-chat',              'openai',    1742500000),
  m('gpt-5-nano',              'openai',    1742000000),

  // ─── Google ─────────────────────────────────────────────────────────
  m('gemini-3.1-pro-preview',  'google',    1750000000),
  m('gemini-3.5-flash',        'google',    1749000000),
  m('gemini-3-pro',            'google',    1748000000),
  m('gemini-3-flash-preview',  'google',    1747000000),
  m('gemini-3.1-flash-lite',   'google',    1746000000),
  m('gemini-2.5',              'google',    1745000000),

  // ─── DeepSeek ───────────────────────────────────────────────────────
  m('deepseek-v4-pro',         'deepseek',  1744000000),
  m('deepseek-v4-flash',       'deepseek',  1743000000),

  // ─── Moonshot / Kimi ────────────────────────────────────────────────
  m('kimi-k2.7-code',          'moonshotai', 1748000000),
  m('kimi-k2.6',               'moonshotai', 1747000000),
  m('kimi-k2.5',               'moonshotai', 1746000000),
  m('kimi-plan',               'moonshotai', 1745000000),

  // ─── Alibaba / Qwen ─────────────────────────────────────────────────
  m('qwen3-coder-30b-a3b-instruct', 'alibaba', 1744000000),
  m('qwen-plan',               'alibaba',   1743000000),
  m('qwen-turbo',              'alibaba',   1742000000),

  // ─── Z.ai / GLM ─────────────────────────────────────────────────────
  m('glm-5.2',                 'z-ai',      1746000000),
  m('glm-5.1',                 'z-ai',      1745000000),
  m('glm-5v-turbo',            'z-ai',      1744000000),
  m('glm-4.5-flash',           'z-ai',      1743000000),
  m('glm-coding-plan',         'z-ai',      1742000000),

  // ─── MiniMax ────────────────────────────────────────────────────────
  m('minimax-m3',              'minimax',   1744000000),
  m('minimax-m2.7',            'minimax',   1743000000),
  m('minimax-plan',            'minimax',   1742000000),
];

// 按提供商归类
export const MODELS_BY_PROVIDER = {};
for (const m of STAGEWISE_MODELS) {
  const p = m.owned_by;
  if (!MODELS_BY_PROVIDER[p]) MODELS_BY_PROVIDER[p] = [];
  MODELS_BY_PROVIDER[p].push(m.id);
}

// 需要路由前缀的提供商
export const PROVIDER_PREFIX = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  moonshotai: 'kimi',
  alibaba: 'qwen',
  deepseek: 'deepseek',
  'z-ai': 'z-ai',
  minimax: 'minimax',
};

/**
 * 将模型 ID 转换为 stagewise 网关能识别的格式
 * stagewise 网关使用 {provider}/{modelId} 格式
 */
export function toGatewayModelId(modelId) {
  if (modelId.includes('/')) return modelId;
  for (const m of STAGEWISE_MODELS) {
    if (m.id === modelId) {
      const prefix = PROVIDER_PREFIX[m.owned_by] || m.owned_by;
      return `${prefix}/${modelId}`;
    }
  }
  return modelId;
}
