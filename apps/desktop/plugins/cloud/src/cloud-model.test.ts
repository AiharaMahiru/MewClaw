import { afterEach, expect, it, vi } from 'vitest';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { CloudAccountModel, CLOUD_MODEL_PROVIDER } from './cloud-model.js';

afterEach(() => vi.unstubAllGlobals());
const options: GenerateOptions = { provider: CLOUD_MODEL_PROVIDER, model: 'cloud-default', messages: [] };
async function collect(stream: AsyncIterable<unknown>) { const result = []; for await (const value of stream) result.push(value); return result; }
const cookie = 'dsh_session=fake-session; dsh_csrf=fake-csrf';
const catalog = {
  defaultProfileId: '00000000-0000-4000-8000-000000000001',
  profiles: [{ id: '00000000-0000-4000-8000-000000000001', displayName: '我的云端模型', baseUrl: 'https://models.example/v1', modelIds: ['private-model'], defaultModel: 'private-model', keyConfigured: true }],
};
function catalogResponse(): Response { return new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }); }

it('无登录态时拒绝推理', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => '' });
  await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'CLOUD_LOGIN_REQUIRED' });
  expect(request).not.toHaveBeenCalled();
});

it('切回云端后动态隐藏本地账号模型', async () => {
  let enabled = true;
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse()));
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => cookie, enabled: () => enabled });
  expect(await adapter.listModels()).toHaveLength(1);
  enabled = false;
  expect(await adapter.listModels()).toEqual([]);
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'cloud-default')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  expect(await collect(adapter.stream(options))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'CLOUD_MODEL_DISABLED' } } }]);
});

it('使用账号Cookie和CSRF请求云端推理，保留工具流', async () => {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    if (String(url).endsWith('/auth/models')) return catalogResponse();
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"desktop_workspace","arguments":"{\\"action\\":\\"list\\",\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => cookie });
  const chunks = await collect(adapter.stream(options)) as Array<{ type: string }>;
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe('https://cloud.example/auth/models');
  expect(requests[1]?.url).toBe('https://cloud.example/auth/desktop-inference/chat/completions');
  expect(requests[1]?.headers.get('cookie')).toContain('fake-session');
  expect(requests[1]?.headers.get('x-csrf-token')).toBe('fake-csrf');
  expect(chunks.map(value => value.type)).toContain('tool-call-delta');
});

it('同步云端模型配置和密钥状态，但拒绝接收原始 API key', async () => {
  const request = vi.fn(async () => catalogResponse());
  vi.stubGlobal('fetch', request);
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => cookie });
  await expect(adapter.listModels()).resolves.toMatchObject([{ name: '我的云端模型', description: '云端默认模型：private-model' }]);
  const [url, init] = request.mock.calls[0] ?? [];
  expect(String(url)).toBe('https://cloud.example/auth/models');
  expect(new Headers(init?.headers).get('cookie')).toBe(cookie);
});

it('云端模型目录意外包含 API key 时 fail closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ...catalog, profiles: [{ ...catalog.profiles[0], apiKey: 'should-never-arrive' }],
  }), { headers: { 'content-type': 'application/json' } })));
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => cookie });
  await expect(adapter.listModels()).resolves.toEqual([]);
});
