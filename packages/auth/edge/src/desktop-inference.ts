/** 账号认证后的模型流代理：密钥只在服务器请求作用域内使用。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from 'dsh-lark-auth';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpError, readJson, sendError } from './http-utils.js';

const REQUEST_FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'parallel_tool_calls', 'reasoning_effort']);

/**
 * `model` 字段是服务端路由选择器，不是供应商模型名。三种形态见 SPEC §6：
 * `cloud-default` / `account/<profileId>[/<model>]` / `shared/<provider>/<model>`。
 * profileId 与 provider 段不含 `/`；model 段允许 `/`。
 */
export type DesktopModelSelector =
  | { kind: 'default' }
  | { kind: 'account'; profileId: string; model: string | undefined }
  | { kind: 'shared'; provider: string; model: string };

export function parseModelSelector(value: unknown): DesktopModelSelector {
  if (value === 'cloud-default') return { kind: 'default' };
  if (typeof value === 'string') {
    const account = /^account\/([^/]+)(?:\/(.+))?$/.exec(value);
    if (account) return { kind: 'account', profileId: account[1]!, model: account[2] };
    const shared = /^shared\/([^/]+)\/(.+)$/.exec(value);
    if (shared) return { kind: 'shared', provider: shared[1]!, model: shared[2]! };
  }
  throw httpError(400, 'INVALID_INFERENCE_REQUEST');
}

export function parseDesktopInference(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(body).some(key => !REQUEST_FIELDS.has(key)) || body.stream !== true
    || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  parseModelSelector(body.model);
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 256)) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) <= 0)) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  }
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'number') throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  }
  if (body.stop !== undefined && typeof body.stop !== 'string'
    && !(Array.isArray(body.stop) && (body.stop as unknown[]).every(item => typeof item === 'string'))) throw httpError(400, 'INVALID_INFERENCE_REQUEST');
  return body;
}

/** 审计输入 = 最后一条 user 消息的文本（输入框语义）：历史消息只在其成为最新输入时审计过一次。 */
function lastUserMessageText(messages: Array<{ role: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]!.content;
    if (messages[index]!.role !== 'user') continue;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.map(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '').join('');
      if (text.trim()) return text;
    }
  }
  return '';
}

/** 共享路径请求内容不被支持（非文本部件等）；映射为 400 而非上游 502。 */
export class InvalidSharedRequestError extends Error {
  readonly code = 'INVALID_INFERENCE_REQUEST';
}

/**
 * 部署侧共享模型目录的窄接口：由 apps/auth 以独立 Cordis 上下文 + LlmRuntime
 * 实现，Edge 只做边界校验与 SSE 透传，不接触 dsh-llm 类型与凭证。
 * `stream` 产出完整的 OpenAI SSE `data:` 行（含结尾 [DONE]）。
 */
export interface DesktopSharedRuntime {
  listModels(): Promise<readonly DesktopSharedModel[]>;
  stream(input: {
    provider: string;
    model: string;
    modelEcho: string;
    messages: Array<Record<string, unknown>>;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    stop?: string[] | undefined;
    reasoningEffort?: string | undefined;
    tools?: Array<Record<string, unknown>> | undefined;
    includeUsage?: boolean | undefined;
    signal: AbortSignal;
  }): AsyncIterable<string>;
}

/** 目录条目：reasoningEfforts/defaultReasoningEffort 由实现侧 resolved 元数据透传，缺省表示该模型不暴露强度选择。 */
export interface DesktopSharedModel {
  provider: string;
  model: string;
  name: string;
  reasoningEfforts?: { id: string; name: string; description?: string }[] | undefined;
  defaultReasoningEffort?: string | undefined;
}

export async function desktopInference(req: IncomingMessage, res: ServerResponse, options: {
  userId: string;
  service: Pick<AuthService, 'resolveMyDefaultModelRoute' | 'resolveMyProfileModelRoute'>;
  shared?: DesktopSharedRuntime | undefined;
  maxBytes: number;
  timeoutMs: number;
  audit(text: string): Promise<'allow' | 'block' | 'unavailable'>;
  assertPublicUrl(url: string): Promise<void>;
  fetch?: typeof fetch;
}): Promise<void> {
  const input = parseDesktopInference(await readJson(req, options.maxBytes));
  const selector = parseModelSelector(input.model);
  const messages = input.messages as Array<{ role: string; content?: unknown }>;
  const text = lastUserMessageText(messages);
  if (await options.audit(text).catch(() => 'unavailable') !== 'allow') { sendError(res, 403, 'PROMPT_AUDIT_REJECTED'); return; }

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs)]);
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  try {
    if (selector.kind === 'shared') {
      if (!options.shared || !(await options.shared.listModels()).some(m => m.provider === selector.provider && m.model === selector.model)) {
        sendError(res, 404, 'MODEL_UNAVAILABLE'); return;
      }
      const streamOptions = input.stream_options as Record<string, unknown> | undefined;
      // stream() 急切执行内容校验（InvalidSharedRequestError → 400），必须先于响应头。
      const lines = options.shared.stream({
        provider: selector.provider, model: selector.model, modelEcho: String(input.model),
        messages: messages as Array<Record<string, unknown>>,
        maxTokens: (input.max_completion_tokens ?? input.max_tokens) as number | undefined,
        temperature: input.temperature as number | undefined,
        stop: typeof input.stop === 'string' ? [input.stop] : input.stop as string[] | undefined,
        reasoningEffort: input.reasoning_effort as string | undefined,
        tools: input.tools as Array<Record<string, unknown>> | undefined,
        includeUsage: streamOptions?.include_usage === true,
        signal,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      for await (const line of lines) res.write(line);
      res.end();
      return;
    }
    let route = selector.kind === 'default'
      ? await options.service.resolveMyDefaultModelRoute(options.userId)
      : await options.service.resolveMyProfileModelRoute(options.userId, selector.profileId, selector.model);
    if (!route) { sendError(res, selector.kind === 'default' ? 409 : 404, selector.kind === 'default' ? 'CLOUD_DEFAULT_MODEL_REQUIRED' : 'MODEL_UNAVAILABLE'); return; }
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
    } finally { route = undefined; }
  } catch (error) {
    if (!res.headersSent) sendError(res, error instanceof InvalidSharedRequestError ? 400 : 502,
      error instanceof InvalidSharedRequestError ? 'INVALID_INFERENCE_REQUEST' : 'CLOUD_INFERENCE_FAILED');
    else res.destroy();
  } finally { res.off('close', disconnect); }
}
