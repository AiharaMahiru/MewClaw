import { afterEach, expect, it, vi } from 'vitest';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { CloudAccountModel, CLOUD_MODEL_PROVIDER } from './cloud-model.js';

afterEach(() => vi.unstubAllGlobals());
const options: GenerateOptions = { provider: CLOUD_MODEL_PROVIDER, model: 'cloud-default', messages: [] };
async function collect(stream: AsyncIterable<unknown>) { const result = []; for await (const value of stream) result.push(value); return result; }

it('无登录态时拒绝推理', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => '' });
  await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'CLOUD_LOGIN_REQUIRED' });
  expect(request).not.toHaveBeenCalled();
});

it('使用账号Cookie和CSRF请求云端推理，保留工具流', async () => {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"desktop_workspace","arguments":"{\\"action\\":\\"list\\",\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => 'dsh_session=fake-session; dsh_csrf=fake-csrf' });
  const chunks = await collect(adapter.stream(options)) as Array<{ type: string }>;
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://cloud.example/auth/desktop-inference/chat/completions');
  expect(requests[0]?.headers.get('cookie')).toContain('fake-session');
  expect(requests[0]?.headers.get('x-csrf-token')).toBe('fake-csrf');
  expect(chunks.map(value => value.type)).toContain('tool-call-delta');
});
