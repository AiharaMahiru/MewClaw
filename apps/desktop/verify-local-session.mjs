/** 真实 Cordis 本地会话组合；默认无密钥回放，--live <0600账号文件> 启用真实推理。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const runtime = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const live = process.argv[4] === '--live';
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const [{ Context }, { default: Llm, createUserMessage }, { default: Sessions, SessionId }, { default: Agents }, { default: Loop },
  { default: Prompt }, { default: Tools }, { default: FileSystem }, { default: Persistence }, { default: Projection },
  storage, storageJson, storageDomain, { default: Workspaces }] = await Promise.all(
  ['cordis', 'dsh-llm', 'dsh-session', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt', 'dsh-tools', 'dsh-fs-local',
    'dsh-session-persistence-jsonl', 'dsh-session-projection', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace'].map(load));
const cloudRoot = dirname(require.resolve('dsh-lark-desktop-cloud'));
const { CloudAccountModel, CLOUD_MODEL_PROVIDER } = await import(pathToFileURL(join(cloudRoot, 'cloud-model.js')).href);
const { LocalHarnessWorkspaces } = await import(pathToFileURL(join(cloudRoot, 'local-workspaces.js')).href);
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(evidence, live ? '真实 中文工作区-' : '回放 中文工作区-'));
const expected = '本机文件验收\n';
await writeFile(join(root, '输入.txt'), expected);
const requests = [];
let stage = 0;
const server = live ? undefined : createServer(async (req, res) => {
  requests.push(req.url);
  if (req.url === '/auth/models') { res.end(JSON.stringify({ profiles: [], sharedModels: [{ provider: 'replay', model: 'local', name: '回放' }] })); return; }
  assert.equal(req.url, '/auth/desktop-inference/chat/completions');
  assert.equal(req.headers['x-csrf-token'], 'keyless-csrf');
  let body = ''; for await (const chunk of req) body += chunk;
  const wire = JSON.parse(body);
  assert.equal(wire.model, 'shared/replay/local');
  assert.deepEqual(wire.tools.map(t => t.function.name).sort(), ['edit', 'read', 'write']);
  const operation = stage === 0 ? { file_path: join(root, '输入.txt') } : { file_path: join(root, '输出.txt'), content: expected };
  const delta = stage < 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'local-' + stage, type: 'function', function: { name: stage === 0 ? 'read' : 'write', arguments: JSON.stringify(operation) } }] }
    : { role: 'assistant', content: '本机验收完成' };
  const finish = stage++ < 2 ? 'tool_calls' : 'stop';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [value, reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id: 'replay', object: 'chat.completion.chunk', model: wire.model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
if (server) await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = live ? 'https://chat.rwr.ink' : `http://127.0.0.1:${server.address().port}`;
const cookies = new Map(live ? [] : [['dsh_session', 'keyless-session'], ['dsh_csrf', 'keyless-csrf']]);
const cookie = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
async function auth(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { origin, cookie: cookie(), 'content-type': 'application/json', ...body ? { 'x-csrf-token': decodeURIComponent(cookies.get('dsh_csrf') ?? '') } : {} },
    ...body ? { body: JSON.stringify(body) } : {} });
  for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
  assert.ok(response.ok, `认证请求失败：${response.status}`);
  await response.arrayBuffer();
}
const ctx = new Context();
let handle, resumed, workspaces, timeout, loggedIn = false;
try {
  if (live) {
    const path = resolve(process.argv[5]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const { email, password } = JSON.parse(await readFile(path, 'utf8'));
    await auth('/'); await auth('/auth/login', { email, password }); loggedIn = true;
  }
  for (const plugin of [Llm, Sessions, Agents, Prompt, Projection, Tools, storage]) await ctx.plugin(plugin.default ?? plugin);
  await ctx.plugin(storageJson.default ?? storageJson, { root: join(root, 'storage') });
  await ctx.plugin(storageDomain.default ?? storageDomain, { backend: 'json' });
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(Workspaces);
  await ctx.plugin(FileSystem, { cwd: root });
  await ctx.plugin(await load('dsh-tool-fs'));
  // 原生目录选择是此组合唯一替身；登记、授权、文件、会话和推理均使用真实插件。
  ctx.provide('desktopRuntime', { pickDirectory: async () => root });
  workspaces = new LocalHarnessWorkspaces(ctx, { maxBytes: 262144, maxEntries: 500 });
  workspaces.install(ctx);
  const workspace = await workspaces.pick();
  assert.equal(workspace.path, root);
  const adapter = new CloudAccountModel({ origin, cookie });
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([CLOUD_MODEL_PROVIDER], adapter);
    adapter.bindRoutes(registration, () => ctx.llm.listProviders().map(p => p.id));
    return registration;
  });
  const catalog = await adapter.catalogSnapshot();
  assert.ok(catalog, '账号必须有可用模型目录');
  const shared = catalog.sharedModels.find(m => /flash/u.test(m.model)) ?? catalog.sharedModels[0];
  const selection = shared ? { provider: CLOUD_MODEL_PROVIDER, model: `shared/${shared.provider}/${shared.model}` } : adapter.defaultSelection(catalog);
  await ctx.plugin(Loop);
  const sessionId = SessionId(`desktop-local-${Date.now()}`);
  handle = await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: selection });
  timeout = setTimeout(() => handle?.agent.cancel({ kind: 'interrupted' }), 180000);
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '先使用 read 读取输入.txt，再用 write 将完整内容原样写入新文件输出.txt。仅处理这两个相对路径，完成后回复“本机验收完成”。' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle(); clearTimeout(timeout);
  assert.equal(await readFile(join(root, '输出.txt'), 'utf8'), expected);
  const events = [...handle.agent.session.snapshotEvents()];
  const serialized = JSON.stringify(events);
  assert.ok(serialized.includes('read') && serialized.includes('write') && serialized.includes(JSON.stringify(expected).slice(1, -1)));
  assert.ok(!serialized.includes('keyless-session'));
  assert.ok(!requests.some(p => /workspace|\/api\/session/u.test(p)));
  await ctx.sessions.flush(handle.agent.session);
  await handle.dispose(); handle = undefined;
  resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: selection });
  assert.equal(resumed.agent.session.header.cwd, root);
  assert.deepEqual(resumed.agent.session.snapshotEvents().slice(0, events.length), events);
  workspaces.dispose();
  await assert.rejects(workspaces.execute(sessionId, { action: 'read', path: '输入.txt' }, new AbortController().signal), /LOCAL_WORKSPACE_NOT_AUTHORIZED/u);
  await workspaces.pick();
  assert.equal((await workspaces.execute(sessionId, { action: 'read', path: '输入.txt' }, new AbortController().signal)).content, expected);
  const result = { mode: live ? 'live' : 'keyless', selection, fileReadWrite: true, persistedAndResumed: true, revokedAndReauthorized: true, events: events.length };
  await writeFile(join(evidence, live ? 'desktop-live.json' : 'desktop-replay.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timeout); await resumed?.dispose(); await handle?.dispose(); workspaces?.dispose(); await ctx.fiber.dispose();
  if (loggedIn) await auth('/auth/logout', {});
  cookies.clear(); if (server) await new Promise(r => server.close(r));
}
