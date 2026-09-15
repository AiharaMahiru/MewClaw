import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopInference, InvalidSharedRequestError, parseDesktopInference, parseModelSelector } from './desktop-inference.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const input = { model: 'cloud-default', stream: true, messages: [{ role: 'user', content: '读取已授权目录' }] };

type Options = Parameters<typeof desktopInference>[2];

async function fixture(overrides: Partial<Options> = {}) {
  const upstream = vi.fn<typeof fetch>(async () => new Response('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const options: Options = { userId: 'account-a', maxBytes: 4096, timeoutMs: 1000,
    service: {
      resolveMyDefaultModelRoute: async userId => {
        expect(userId).toBe('account-a');
        return { profileId: 'profile-a', revision: 1, baseUrl: 'https://models.example/v1', model: 'private-model', apiKey: 'test-server-only-key' };
      },
      resolveMyProfileModelRoute: async (userId, profileId, model) => {
        expect(userId).toBe('account-a');
        return profileId === 'profile-b' ? { profileId, revision: 3, baseUrl: 'https://models.example/v1', model: model ?? 'fallback-model', apiKey: 'test-server-only-key' } : undefined;
      },
    },
    assertPublicUrl: async () => {}, audit: async () => 'allow', fetch: upstream, ...overrides };
  const server = createServer((req, res) => { void desktopInference(req, res, options).catch(() => { res.writeHead(400); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  return { url: `http://127.0.0.1:${address.port}`, upstream };
}

it('model 选择器三种形态解析', () => {
  expect(parseModelSelector('cloud-default')).toEqual({ kind: 'default' });
  expect(parseModelSelector('account/p-1')).toEqual({ kind: 'account', profileId: 'p-1', model: undefined });
  expect(parseModelSelector('account/p-1/vendor/x')).toEqual({ kind: 'account', profileId: 'p-1', model: 'vendor/x' });
  expect(parseModelSelector('shared/openai/gpt-5.6-luna')).toEqual({ kind: 'shared', provider: 'openai', model: 'gpt-5.6-luna' });
  for (const bad of ['private-model', 'account/', 'shared/openai', 'shared//x', '', 42, null]) {
    expect(() => parseModelSelector(bad)).toThrow('INVALID_INFERENCE_REQUEST');
  }
});

it('仅服务端解析账号默认模型，客户端收到流且不收到密钥', async () => {
  const { url, upstream } = await fixture();
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(input) });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('完成'); expect(body).not.toContain('test-server-only-key');
  const call = upstream.mock.calls[0]!;
  expect(String(call[0])).toBe('https://models.example/v1/chat/completions');
  expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer test-server-only-key');
  expect(JSON.parse(String(call[1]?.body)).model).toBe('private-model');
  expect(call[1]?.redirect).toBe('error');
});

it('account 选择器解析本人 profile 的任意已声明模型', async () => {
  const { url, upstream } = await fixture();
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, model: 'account/profile-b/chat-x' }) });
  expect(response.status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body)).model).toBe('chat-x');
  // 裸 account/<pid> 回落该 profile 的默认模型（由服务端解析）。
  const again = await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, model: 'account/profile-b' }) });
  expect(again.status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body)).model).toBe('fallback-model');
  // 未知 profile → 404，不发上游请求。
  const missing = await fixture();
  const denied = await fetch(missing.url, { method: 'POST', body: JSON.stringify({ ...input, model: 'account/foreign/m' }) });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: 'MODEL_UNAVAILABLE' });
  expect(missing.upstream).not.toHaveBeenCalled();
});

it('shared 选择器走部署目录运行时，透传 SSE 行', async () => {
  const calls: Array<{ provider: string; model: string; modelEcho: string }> = [];
  const shared = {
    listModels: async () => [{ provider: 'openai', model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
    stream: async function* (request: { provider: string; model: string; modelEcho: string }) {
      calls.push(request);
      yield 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":"共享输出"}}]}\n\n';
      yield 'data: [DONE]\n\n';
    },
  };
  const { url, upstream } = await fixture({ shared });
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, model: 'shared/openai/gpt-5.6-luna' }) });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('共享输出');
  expect(body).toContain('[DONE]');
  expect(calls[0]).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', modelEcho: 'shared/openai/gpt-5.6-luna' });
  expect(upstream).not.toHaveBeenCalled();
});

it('shared 目录未命中或未装配返回 404，不触碰上游与运行时流', async () => {
  const streamCalled = vi.fn();
  const shared = { listModels: async () => [{ provider: 'openai', model: 'gpt-5.6-luna', name: 'x' }], stream: streamCalled };
  const { url, upstream } = await fixture({ shared });
  expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, model: 'shared/openai/removed-model' }) })).status).toBe(404);
  expect(streamCalled).not.toHaveBeenCalled();
  const bare = await fixture();
  expect((await fetch(bare.url, { method: 'POST', body: JSON.stringify({ ...input, model: 'shared/openai/gpt-5.6-luna' }) })).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
  expect(bare.upstream).not.toHaveBeenCalled();
});

it('共享路径不支持的内容部件映射 400', async () => {
  const shared = {
    listModels: async () => [{ provider: 'openai', model: 'm', name: 'm' }],
    stream: () => { throw new InvalidSharedRequestError('image parts unsupported'); },
  };
  const { url } = await fixture({ shared });
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, model: 'shared/openai/m', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'INVALID_INFERENCE_REQUEST' });
});

it('审计仅覆盖最后一条 user 消息文本，不重审历史', async () => {
  const audited: string[] = [];
  const { url } = await fixture({ audit: async text => { audited.push(text); return 'allow'; } });
  const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, messages: [
    { role: 'user', content: '历史输入不再重审' },
    { role: 'assistant', content: '历史回复' },
    { role: 'user', content: [{ type: 'text', text: '最新' }, { type: 'text', text: '输入' }] },
  ] }) });
  expect(response.status).toBe(200);
  expect(audited).toEqual(['最新输入']);
});

it('stop/max_tokens/温度等字段类型非法时 400，不触碰上游', async () => {
  const { url, upstream } = await fixture();
  for (const patch of [{ stop: 42 }, { stop: ['ok', 1] }, { max_tokens: 'x' }, { max_tokens: 0 }, { max_completion_tokens: -1 }, { temperature: 'hot' }]) {
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, ...patch }) })).status).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
});

it.each(['block', 'unavailable'] as const)('审计%s时不解析或请求上游', async result => {
  const { url, upstream } = await fixture({ audit: async () => result });
  expect((await fetch(url, { method: 'POST', body: JSON.stringify(input) })).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

it('非公网地址拒绝，供应商错误不透传', async () => {
  const denied = await fixture({ assertPublicUrl: async () => { throw new Error('private'); } });
  expect((await fetch(denied.url, { method: 'POST', body: JSON.stringify(input) })).status).toBe(502);
  expect(denied.upstream).not.toHaveBeenCalled();
  const failed = await fixture({ fetch: async () => new Response('test-server-only-key', { status: 401 }) });
  const response = await fetch(failed.url, { method: 'POST', body: JSON.stringify(input) });
  expect(await response.json()).toEqual({ error: 'CLOUD_INFERENCE_FAILED' });
});

it('不接受客户端指定账号、端点或选择器之外的模型', () => {
  for (const extra of [{ userId: 'b' }, { baseUrl: 'http://localhost' }, { model: 'private-model' }, { stream: false }]) {
    expect(() => parseDesktopInference({ ...input, ...extra })).toThrow('INVALID_INFERENCE_REQUEST');
  }
});

it.each(['timeout', 'disconnect'] as const)('%s 会取消上游推理请求', async kind => {
  let started = false;
  let aborted = false;
  const { url } = await fixture({ timeoutMs: kind === 'timeout' ? 100 : 5000, fetch: async (_url, init) => {
    started = true;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    });
  } });
  const controller = new AbortController();
  const response = fetch(url, { method: 'POST', body: JSON.stringify(input), signal: controller.signal }).catch(() => undefined);
  await vi.waitFor(() => expect(started).toBe(true));
  if (kind === 'disconnect') controller.abort();
  else expect((await response)?.status).toBe(502);
  await vi.waitFor(() => expect(aborted).toBe(true));
  await response;
});
