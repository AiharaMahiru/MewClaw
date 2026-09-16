import { afterEach, expect, it, vi } from 'vitest';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { CloudAccountModel, CLOUD_MODEL_PROVIDER, PRIVATE_MODEL_PROVIDER } from './cloud-model.js';

afterEach(() => vi.unstubAllGlobals());
const options: GenerateOptions = { provider: PRIVATE_MODEL_PROVIDER, model: 'private-model', messages: [] };
async function collect(stream: AsyncIterable<unknown>) { const result = []; for await (const value of stream) result.push(value); return result; }
const cookie = 'dsh_session=fake-session; dsh_csrf=fake-csrf';
const catalog = {
  defaultProfileId: '00000000-0000-4000-8000-000000000001',
  profiles: [{ id: '00000000-0000-4000-8000-000000000001', displayName: '我的云端模型', baseUrl: 'https://models.example/v1', modelIds: ['private-model'], defaultModel: 'private-model', keyConfigured: true }],
  sharedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat', name: 'DeepSeek V4' }],
};
function catalogResponse(value: unknown = catalog): Response { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function sseResponse(): Response {
  return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"desktop_workspace","arguments":"{\\"action\\":\\"list\\",\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
/** 模拟 LlmRuntime 注册句柄：记录 replace 路由集，本地无其他 provider 占用。 */
function fakeRoutes() {
  const calls: string[][] = [];
  const handle = Object.assign(() => {}, { replace: (ids: string[]) => { calls.push(ids); } });
  return { calls, handle };
}
function boundAdapter(origin = 'https://cloud.example') {
  const routes = fakeRoutes();
  const adapter = new CloudAccountModel({ origin, cookie: () => cookie });
  adapter.bindRoutes(routes.handle, () => []);
  return { adapter, routes };
}

it('无登录态时拒绝推理', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => '' });
  await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'CLOUD_LOGIN_REQUIRED' });
  expect(request).not.toHaveBeenCalled();
});

it('切回云端后动态隐藏本地账号模型', async () => {
  let enabled = true;
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse()));
  const routes = fakeRoutes();
  const adapter = new CloudAccountModel({ origin: 'https://cloud.example', cookie: () => cookie, enabled: () => enabled });
  adapter.bindRoutes(routes.handle, () => []);
  await adapter.catalogSnapshot();
  expect((await adapter.listModels('deepseek-official')).length).toBeGreaterThanOrEqual(1);
  enabled = false;
  expect(await adapter.listModels('deepseek-official')).toEqual([]);
  await expect(adapter.resolveModel('deepseek-official', 'deepseek-chat')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  expect(await collect(adapter.stream(options))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'CLOUD_MODEL_DISABLED' } } }]);
});

it('目录展开为云端同构 provider：web-private + 共享 provider，路由原子替换', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse()));
  const { adapter, routes } = boundAdapter();
  await adapter.catalogSnapshot();
  expect(routes.calls.at(-1)).toEqual(['web-private', 'deepseek-official', 'mewclaw-cloud']);
  expect(await adapter.listModels(PRIVATE_MODEL_PROVIDER)).toMatchObject([{ id: 'private-model', name: 'private-model' }]);
  expect(await adapter.listModels('deepseek-official')).toMatchObject([{ id: 'deepseek-chat', name: 'DeepSeek V4', description: '部署共享模型' }]);
  expect(await adapter.listModels(CLOUD_MODEL_PROVIDER)).toEqual([]);
});

it('resolveModel 按云端同形 id 校验，旧 mewclaw-cloud 选择器兼容', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse()));
  const { adapter } = boundAdapter();
  await adapter.catalogSnapshot();
  await expect(adapter.resolveModel(PRIVATE_MODEL_PROVIDER, 'private-model')).resolves.toMatchObject({ provider: PRIVATE_MODEL_PROVIDER, id: 'private-model' });
  await expect(adapter.resolveModel('deepseek-official', 'deepseek-chat')).resolves.toMatchObject({ provider: 'deepseek-official', id: 'deepseek-chat' });
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'cloud-default')).resolves.toMatchObject({ id: 'cloud-default' });
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'account/00000000-0000-4000-8000-000000000001/private-model')).resolves.toMatchObject({ id: 'account/00000000-0000-4000-8000-000000000001/private-model' });
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'account/00000000-0000-4000-8000-000000000001')).resolves.toMatchObject({ id: 'account/00000000-0000-4000-8000-000000000001' });
  await expect(adapter.resolveModel(PRIVATE_MODEL_PROVIDER, 'not-default-model')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  await expect(adapter.resolveModel('deepseek-official', 'not-listed')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  await expect(adapter.resolveModel('unknown-provider', 'x')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'account/unknown-profile/x')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
});

it('无默认私有模型时 web-private 为空、共享条目仍可用；显式解析报 CLOUD_DEFAULT_MODEL_REQUIRED', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse({ profiles: [], sharedModels: catalog.sharedModels })));
  const { adapter } = boundAdapter();
  await adapter.catalogSnapshot();
  expect(await adapter.listModels(PRIVATE_MODEL_PROVIDER)).toEqual([]);
  expect(await adapter.listModels('deepseek-official')).toMatchObject([{ id: 'deepseek-chat' }]);
  await expect(adapter.resolveModel(PRIVATE_MODEL_PROVIDER, 'anything')).rejects.toMatchObject({ code: 'CLOUD_DEFAULT_MODEL_REQUIRED' });
  await expect(adapter.resolveModel(CLOUD_MODEL_PROVIDER, 'cloud-default')).rejects.toMatchObject({ code: 'CLOUD_DEFAULT_MODEL_REQUIRED' });
  await expect(adapter.resolveModel('deepseek-official', 'deepseek-chat')).resolves.toMatchObject({ id: 'deepseek-chat' });
  await expect(collect(adapter.stream({ provider: PRIVATE_MODEL_PROVIDER, model: 'anything', messages: [] }))).rejects.toMatchObject({ code: 'CLOUD_DEFAULT_MODEL_REQUIRED' });
});

it('进入本地模式的默认选择：默认私有模型优先，否则首个共享模型', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => catalogResponse()));
  const { adapter } = boundAdapter();
  const full = await adapter.catalogSnapshot();
  expect(adapter.defaultSelection(full!)).toEqual({ provider: PRIVATE_MODEL_PROVIDER, model: 'private-model' });
  expect(adapter.defaultSelection({ profiles: [], sharedModels: catalog.sharedModels, defaultProfileId: null }))
    .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' });
  expect(adapter.defaultSelection({ profiles: [], sharedModels: [], defaultProfileId: null }))
    .toEqual({ provider: CLOUD_MODEL_PROVIDER, model: 'cloud-default' });
});

it('使用账号Cookie和CSRF请求云端推理，保留工具流', async () => {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    if (String(url).endsWith('/auth/models')) return catalogResponse();
    return sseResponse();
  });
  const { adapter } = boundAdapter();
  const chunks = await collect(adapter.stream(options)) as Array<{ type: string }>;
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe('https://cloud.example/auth/models');
  expect(requests[1]?.url).toBe('https://cloud.example/auth/desktop-inference/chat/completions');
  expect(requests[1]?.headers.get('cookie')).toContain('fake-session');
  expect(requests[1]?.headers.get('x-csrf-token')).toBe('fake-csrf');
  expect(JSON.parse(requests[1]?.body ?? '{}').model).toBe('cloud-default');
  expect(chunks.map(value => value.type)).toContain('tool-call-delta');
});

it('推理请求把选择器原样透传为 model 字段', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) });
    if (String(url).endsWith('/auth/models')) return catalogResponse();
    return sseResponse();
  });
  const { adapter } = boundAdapter();
  await collect(adapter.stream({ provider: 'deepseek-official', model: 'deepseek-chat', messages: [] }));
  await collect(adapter.stream({ provider: CLOUD_MODEL_PROVIDER, model: 'account/00000000-0000-4000-8000-000000000001/private-model', messages: [] }));
  const bodies = requests.filter(item => item.url.endsWith('/chat/completions')).map(item => JSON.parse(item.body).model);
  expect(bodies).toEqual(['shared/deepseek-official/deepseek-chat', 'account/00000000-0000-4000-8000-000000000001/private-model']);
});

it('未知选择器不发出推理请求', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    requests.push(String(url));
    if (String(url).endsWith('/auth/models')) return catalogResponse();
    return sseResponse();
  });
  const { adapter } = boundAdapter();
  await expect(collect(adapter.stream({ provider: 'deepseek-official', model: 'delisted', messages: [] }))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  expect(requests.filter(url => url.endsWith('/chat/completions'))).toEqual([]);
});

it('同步云端模型配置和密钥状态，但拒绝接收原始 API key', async () => {
  const request = vi.fn(async () => catalogResponse());
  vi.stubGlobal('fetch', request);
  const { adapter } = boundAdapter();
  await adapter.catalogSnapshot();
  await expect(adapter.listModels(PRIVATE_MODEL_PROVIDER)).resolves.toMatchObject([{ name: 'private-model', description: '账号默认模型：我的云端模型' }]);
  const [url, init] = request.mock.calls[0] ?? [];
  expect(String(url)).toBe('https://cloud.example/auth/models');
  expect(new Headers(init?.headers).get('cookie')).toBe(cookie);
});

it('云端模型目录意外包含 API key 时 fail closed', async () => {
  const request = vi.fn(async () => catalogResponse({
    ...catalog, profiles: [{ ...catalog.profiles[0], apiKey: 'should-never-arrive' }],
  }));
  vi.stubGlobal('fetch', request);
  const { adapter } = boundAdapter();
  await expect(adapter.catalogSnapshot()).resolves.toBeUndefined();
  expect(request).toHaveBeenCalled();
});

it('共享目录意外包含 API key 时 fail closed', async () => {
  const request = vi.fn(async () => catalogResponse({
    ...catalog, sharedModels: [{ ...catalog.sharedModels[0], apiKey: 'should-never-arrive' }],
  }));
  vi.stubGlobal('fetch', request);
  const { adapter } = boundAdapter();
  await expect(adapter.catalogSnapshot()).resolves.toBeUndefined();
  expect(request).toHaveBeenCalled();
});
