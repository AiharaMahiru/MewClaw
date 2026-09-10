import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 从候选发布入口解析依赖，验证实际网络载荷，防止仅有字符串匹配的假阳性。
const require = createRequire(`${process.cwd()}/apps/auth/dist/main.js`);
const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')));
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const options = resolveAdapterOptions({
    baseURL: `http://127.0.0.1:${server.address().port}`,
    modelAliases: { 'deepseek-v4-flash': 'deepseek-v4.1-flash-expires-on-0910' },
    disabledModels: ['deepseek-v4-flash-vision-exp'],
  });
  const adapter = new DeepSeekAdapter({ options: () => options, resolveApiKey: async () => 'synthetic-key', resolveUserId: () => 'probe', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
  const input = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], maxTokens: 128 };
  for await (const chunk of adapter.stream(input)) assert.notEqual(chunk.reason?.kind, 'error');
  assert.equal(requests[0].model, 'deepseek-v4.1-flash-expires-on-0910');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(input.model, 'deepseek-v4-flash');
  for await (const chunk of adapter.stream({ ...input, model: 'deepseek-v4-pro', reasoningEffort: 'high' })) assert.notEqual(chunk.reason?.kind, 'error');
  assert.equal(requests[1].model, 'deepseek-v4-pro');
  assert.deepEqual(requests[1].thinking, { type: 'enabled' });
  const catalog = await adapter.listModels('deepseek-official');
  assert.equal(catalog.find(x => x.id === 'deepseek-v4-flash').name, 'DeepSeek-V4-Flash');
  assert.equal(catalog.some(x => x.id === 'deepseek-v4-flash-vision-exp'), false);
  await assert.rejects(async () => { for await (const chunk of adapter.stream({ ...input, model: 'deepseek-v4-flash-vision-exp' })) void chunk; }, { code: 'MODEL_DISABLED' });
  await assert.rejects(async () => adapter.resolveModel('deepseek-official', 'deepseek-v4-flash-vision-exp'), { code: 'MODEL_DISABLED' });
  assert.equal(requests.length, 2);
  console.log('[deepseek-route] PASS: alias, thinking off/on, catalog label, disabled model with zero forwarding');
} finally {
  await new Promise(resolve => server.close(resolve));
}
