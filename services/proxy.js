import { config } from '../config.js';
import { toGatewayModelId, STAGEWISE_MODELS } from './models.js';
import { STAGEWISE_SYSTEM_PROMPT } from './stagewise-system-prompt.js';
import { markSuccess, markError } from './account-pool.js';

/**
 * 确保 messages 包含有效的 Stagewise system prompt
 * Stagewise 后端要求 system 消息至少包含 5515 字符的特定内容才能通过验证
 */
function ensureSystemPrompt(messages) {
  if (!messages || messages.length === 0) {
    return [{ role: 'system', content: STAGEWISE_SYSTEM_PROMPT }];
  }

  const firstMsg = messages[0];

  // 如果第一条是 system 且长度够（>= 5500 字符），认为已包含验证内容
  if (firstMsg.role === 'system' && firstMsg.content && firstMsg.content.length >= 5500) {
    return messages;
  }

  // 如果第一条是 system 但太短，合并到标准 prompt 后面
  if (firstMsg.role === 'system') {
    const userContent = firstMsg.content || '';
    const mergedContent = `${STAGEWISE_SYSTEM_PROMPT}\n\n## Additional Instructions\n\n${userContent}`;
    return [
      { role: 'system', content: mergedContent },
      ...messages.slice(1),
    ];
  }

  // 第一条不是 system，在前面插入
  return [
    { role: 'system', content: STAGEWISE_SYSTEM_PROMPT },
    ...messages,
  ];
}

/**
 * 流式转发 SSE
 */
async function forwardStream(res, response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error('Stream error:', e.message);
  }
  res.end();
}

/**
 * GET /v1/models — 列出可用模型
 */
export function handleListModels(req, res) {
  res.json({ object: 'list', data: STAGEWISE_MODELS });
}

/**
 * POST /v1/chat/completions — 转发到 Stagewise 网关
 */
export async function handleChatCompletions(req, res) {
  const body = req.body || {};
  const { messages, model, stream, ...restParams } = body;

  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: 'messages 是必需的', type: 'invalid_request' } });
  }

  const modelId = model || 'claude-sonnet-4.6';
  const stagewiseToken = req.token;  // 从中间件获取

  if (!stagewiseToken) {
    return res.status(401).json({
      error: {
        message: '需要 Stagewise Bearer Token（请求头、账号池或 .env）',
        type: 'auth_error',
      },
    });
  }

  // 注入 Stagewise system prompt
  const processedMessages = ensureSystemPrompt(messages);

  // 转发到 Stagewise 网关
  const gatewayModelId = toGatewayModelId(modelId);
  const gatewayUrl = `${config.llmGateway}/chat/completions`;
  const forwardBody = {
    model: gatewayModelId,
    messages: processedMessages,
    stream: !!stream,
    ...restParams,
  };
  // 清理 undefined 字段
  for (const [k, v] of Object.entries(forwardBody)) { if (v === undefined) delete forwardBody[k]; }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${stagewiseToken}`,
    Origin: 'https://console.stagewise.io',
    ...config.extraHeaders,
  };
  // Anthropic 特殊头
  if (gatewayModelId.startsWith('anthropic/')) {
    headers['anthropic-beta'] = 'fine-grained-tool-streaming-2025-05-14, interleaved-thinking-2025-05-14';
  }

  try {
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardBody),
    });

    // 成功
    if (response.ok) {
      if (req.accountId) markSuccess(req.accountId);
      if (stream) { await forwardStream(res, response); return; }
      const data = await response.json();
      res.json(data);
      return;
    }

    // 失败
    const errorText = await response.text().catch(() => 'unknown error');
    if (req.accountId) {
      markError(req.accountId, `HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }
    return res.status(response.status).json({
      error: { message: `Stagewise 错误 (${response.status}): ${errorText}`, type: 'upstream_error' },
    });
  } catch (err) {
    console.error(`[proxy] Stagewise error: ${err.message}`);
    if (req.accountId) markError(req.accountId, err.message);
    return res.status(502).json({
      error: { message: `Stagewise 网关错误: ${err.message}`, type: 'gateway_error' },
    });
  }
}
