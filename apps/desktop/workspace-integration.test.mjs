import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import Bash from '@deepseek-ai/dsh-bash-local';
import Pwsh from '@deepseek-ai/dsh-pwsh-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import { NodeSyncDirectory, executeSync } from 'dsh-lark-desktop-host';
import { expect, it } from 'vitest';

// 从候选根执行，所有运行模块均使用当前编译产物。
const load = path => import(pathToFileURL(join(process.cwd(), path)).href);
const { WorkspaceBroker } = await load('mewclaw-workspace/lib/broker.js');
const { workspaceRoute } = await load('mewclaw-workspace/lib/route.js');
const { WorkspaceController } = await load('mewclaw-cloud/lib/workspace-controller.js');
const { workspaceTransport } = await load('mewclaw-cloud/lib/workspace-transport.js');
const { proxyDesktopWorkspace } = await load('edge-workspace/desktop-workspace.js');
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
it('Edge所有权校验→Worker桥接→本机授权目录写入→结果→切回云端', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mewclaw-workspace-e2e-'));
  const root = join(parent, 'authorized'); await mkdir(root);
  const remoteRoot = join(parent, 'cloud'); await mkdir(remoteRoot);
  const ctx = new Context(); await ctx.plugin(LocalFileSystem, { cwd: root });
  await ctx.plugin(Subprocess); await ctx.plugin(process.platform === 'win32' ? Pwsh : Bash, { cwd: root });
  const remote = await NodeSyncDirectory.create(remoteRoot, { maxBytes: 1024, maxEntries: 20, maxTotalBytes: 8192 });
  const states = new Map();
  const broker = new WorkspaceBroker({ read: id => states.get(id), write: async (id, state) => { states.set(id, state); } },
    { requestTimeoutMs: 5000, heartbeatTimeoutMs: 10000, maxBindings: 10 });
  const worker = createServer(workspaceRoute({ broker, token: 'test-worker-token', isBusy: () => false,
    sync: (_id, path, operation, signal) => { expect(path).toBe(remoteRoot); return executeSync(remote, operation, signal); } }));
  const workerBaseUrl = await listen(worker);
  const edge = createServer((req, res) => proxyDesktopWorkspace(req, res, {
    userId: 'account-a', workerBaseUrl, workerToken: 'test-worker-token', requestBodyLimit: 1048576,
    findResource: async (_type, id) => ({ userId: id === 'session-a' ? 'account-a' : 'account-b', resourcePath: remoteRoot }),
  }));
  const origin = await listen(edge);
  const transport = workspaceTransport({ headers: { cookie: 'dsh_csrf=fake; dsh_session=fake; dsh-auth-local=local-only' } }, origin);
  let confirmed = false;
  const controller = new WorkspaceController({ fs: () => ctx.fs, shell: () => ctx.shell, confirm: async () => confirmed,
    pick: async () => root, maxBytes: 1024, maxEntries: 10, pollIntervalMs: 30, syncIntervalMs: 100 });
  const owner = JSON.stringify(['dsh-web', 'dsh-web', 'auth-edge', 'account-a', 'session-a']);
  try {
    await expect(transport({ action: 'status', sessionId: 'session-b' }, new AbortController().signal)).rejects.toThrow('WORKSPACE_LOGIN_REQUIRED');
    expect(await controller.select({ sessionId: 'session-a', mode: 'desktop' }, transport)).toMatchObject({ mode: 'desktop', connected: true });
    const result = await broker.execute({ sessionId: 'session-a', owner, operation: { action: 'write', path: 'result.txt', content: '本机文件' } }, new AbortController().signal);
    expect(result.location).toBe('desktop');
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('本机文件');
    const shell = () => broker.execute({ sessionId: 'session-a', owner, operation: { action: 'shell', command: 'echo desktop-shell' } }, new AbortController().signal);
    await expect(shell()).rejects.toThrow('LOCAL_SHELL_NOT_AUTHORIZED');
    await controller.permission('session-a', 'shell', true, transport);
    await expect(shell()).rejects.toThrow('LOCAL_SHELL_NOT_AUTHORIZED');
    confirmed = true; await controller.permission('session-a', 'shell', true, transport);
    expect(await shell()).toMatchObject({ exitCode: 0, stdout: { text: expect.stringContaining('desktop-shell') } });
    await controller.permission('session-a', 'shell', false, transport); await expect(shell()).rejects.toThrow('LOCAL_SHELL_NOT_AUTHORIZED');
    await writeFile(join(remoteRoot, 'cloud.txt'), '云端文件');
    await controller.permission('session-a', 'sync', true, transport);
    await expect.poll(async () => readFile(join(root, 'cloud.txt'), 'utf8').catch(() => '')).toBe('云端文件');
    await expect.poll(async () => readFile(join(remoteRoot, 'result.txt'), 'utf8').catch(() => '')).toBe('本机文件');
    await controller.permission('session-a', 'sync', false, transport);
    expect(broker.denyTool({ sessionId: 'session-a', owner, tool: 'bash' })).toBe('LOCAL_WORKSPACE_REQUIRES_DESKTOP_FILE_TOOL');
    expect(await controller.select({ sessionId: 'session-a', mode: 'cloud' }, transport)).toEqual({ mode: 'cloud', connected: false });
    expect(broker.status('session-a', owner).mode).toBe('cloud');
    expect(JSON.stringify([...states.values()])).not.toContain(root);
  } finally {
    await controller.dispose(); broker.dispose();
    edge.closeAllConnections(); worker.closeAllConnections();
    await Promise.all([new Promise(resolve => edge.close(resolve)), new Promise(resolve => worker.close(resolve))]);
    await ctx.fiber.dispose(); await rm(parent, { recursive: true, force: true });
  }
}, 15000);
