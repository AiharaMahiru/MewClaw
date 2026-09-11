import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopInference, parseDesktopInference } from './desktop-inference.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const input = { model: 'cloud-default', stream: true, messages: [{ role: 'user', content: '读取已授权目录' }] };

async function fixture(overrides: Partial<Parameters<typeof desktopInference>[2]> = {}) {
  const upstream = vi.fn<typeof fetch>(async () => new Response('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const options: Parameters<typeof desktopInference>[2] = { userId: 'account-a', maxBytes: 4096, timeoutMs: 1000,
    service: { resolveMyDefaultModelRoute: async userId => {
      expect(userId).toBe('account-a');
      return { profileId: 'profile-a', revision: 1, baseUrl: 'https://models.example/v1', model: 'private-model', apiKey: 'test-server-only-key' };
    } }, assertPublicUrl: async () => {}, audit: async () => 'allow', fetch: upstream, ...overrides };
  const server = createServer((req, res) => { void desktopInference(req, res, options).catch(() => { res.writeHead(400); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  return { url: `http://127.0.0.1:${address.port}`, upstream };
}

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

it('不接受客户端指定账号、端点或其他模型', () => {
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
