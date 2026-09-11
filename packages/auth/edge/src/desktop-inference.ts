/** 账号认证后的模型流代理：密钥只在服务器请求作用域内使用。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from 'dsh-lark-auth';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpError, readJson, sendError } from './http-utils.js';

const REQUEST_FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'parallel_tool_calls', 'reasoning_effort']);

export function parseDesktopInference(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(body).some(key => !REQUEST_FIELDS.has(key)) || body.model !== 'cloud-default' || body.stream !== true
    || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 256)) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  return body;
}

export async function desktopInference(req: IncomingMessage, res: ServerResponse, options: {
  userId: string;
  service: Pick<AuthService, 'resolveMyDefaultModelRoute'>;
  maxBytes: number;
  timeoutMs: number;
  audit(text: string): Promise<'allow' | 'block' | 'unavailable'>;
  assertPublicUrl(url: string): Promise<void>;
  fetch?: typeof fetch;
}): Promise<void> {
  const input = parseDesktopInference(await readJson(req, options.maxBytes));
  const messages = input.messages as Array<{ role: string; content?: unknown }>;
  const text = messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  if (await options.audit(text).catch(() => 'unavailable') !== 'allow') { sendError(res, 403, 'PROMPT_AUDIT_REJECTED'); return; }
  let route = await options.service.resolveMyDefaultModelRoute(options.userId);
  if (!route) { sendError(res, 409, 'CLOUD_DEFAULT_MODEL_REQUIRED'); return; }
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs)]);
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  try {
    await options.assertPublicUrl(route.baseUrl);
    const endpoint = new URL(route.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
      body: JSON.stringify({ ...input, model: route.model }),
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel(); sendError(res, 502, 'CLOUD_INFERENCE_FAILED'); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res, { signal });
  } catch {
    if (!res.headersSent) sendError(res, 502, 'CLOUD_INFERENCE_FAILED');
    else res.destroy();
  } finally { route = undefined; res.off('close', disconnect); }
}
