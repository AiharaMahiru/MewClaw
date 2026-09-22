import { describe, expect, it } from 'vitest';

import { MemoryCredentialStore } from './credential-store.js';
import { RemoteClientError } from './errors.js';
import { DshTuiRemoteClient } from './client.js';
import { RemoteWorkspaceBridge } from './local-workspace.js';
import { RemoteStreamTransport } from './remote-stream.js';
import type { FetchLike, WebSocketLike } from './types.js';

function response(value: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(value === undefined ? '' : JSON.stringify(value), { status, headers });
}

function fakeFetch(options: { quotaDenied?: boolean; badRpcId?: boolean } = {}): { fetch: FetchLike; requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> | undefined }> } {
  let session = '';
  let csrf = 'csrf-0';
  const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> | undefined }> = [];
  let workspaceMode: 'cloud' | 'desktop' = 'cloud';
  let workspaceRevision = 'revision-0';
  let pending: { id: string; operation: unknown } | null = null;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : undefined;
    requests.push({ path: url.pathname, headers, body });
    if (url.pathname === '/') return response('<html>login</html>', 200, [`dsh_csrf=${csrf}; Path=/`]);
    if (url.pathname === '/auth/login') {
      if (headers.get('x-csrf-token') !== csrf) return response({ error: 'CSRF_INVALID' }, 403);
      session = 'session-cookie'; csrf = 'csrf-1';
      return response({ user: { id: 'u1', email: 'u@example.com', displayName: '用户', role: 'user', defaultMode: 'full' } }, 200, [`dsh_session=${session}; Path=/`, `dsh_csrf=${csrf}; Path=/`]);
    }
    if (url.pathname === '/auth/me') {
      if (headers.get('cookie')?.includes(`dsh_session=${session}`) !== true || !session) return response({ error: 'UNAUTHORIZED' }, 401);
      return response({ user: { id: 'u1', email: 'u@example.com', displayName: '用户', role: 'user', defaultMode: 'full' } });
    }
    if (url.pathname === '/auth/logout') { session = ''; return response({ ok: true }, 200, ['dsh_session=; Max-Age=0; Path=/']); }
    if (url.pathname === '/auth/models') return response({ profiles: [], sharedModels: [{ id: 'deepseek-chat' }] });
    if (url.pathname === '/api/billing/usage') {
      if (options.quotaDenied) return response({ error: 'BILLING_PROXY_NOT_CONFIGURED' }, 503);
      return response({ quota: { monthlyLimitUsd: 10, monthlyUsedUsd: 2, remainingUsd: 8, currency: 'USD' } });
    }
    if (url.pathname === '/desktop-workspace') {
      const command = body ?? {};
      if (command.action === 'status') return response({ mode: workspaceMode, connected: workspaceMode === 'desktop', revision: workspaceRevision, accountId: 'u1' });
      if (command.action === 'bind') { workspaceMode = 'desktop'; workspaceRevision = 'revision-1'; return response({ ok: true }); }
      if (command.action === 'unbind') { workspaceMode = 'cloud'; workspaceRevision = 'revision-2'; return response({ ok: true }); }
      if (command.action === 'poll') return response({ request: pending, activeRequestId: pending?.id ?? null });
      if (command.action === 'result') { pending = null; return response({ ok: true }); }
      if (command.action === 'sync') return response({ value: { synced: true } });
    }
    if (url.pathname.startsWith('/api/')) {
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : '';
      const method = typeof body?.method === 'string' ? body.method : '';
      if (method === 'session/list') return response({ type: 'server-response', rpcId: options.badRpcId ? 'wrong' : rpcId, result: { ok: true, value: { items: [{ sessionId: 's1', title: '会话' }] } } });
      if (method === 'workspace/create') return response({ type: 'server-response', rpcId, result: { ok: true, value: { workspace: { workspaceId: 'w1', path: '/work' } } } });
      if (method === 'session/prompt') return response({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'QUOTA_EXCEEDED', message: '内部文本不得泄漏', details: {} } } });
      return response({ type: 'server-response', rpcId, result: { ok: true, value: { ok: true } } });
    }
    return response({ error: 'NOT_FOUND' }, 404);
  };
  return { fetch, requests };
}

describe('dsh TUI 远程客户端', () => {
  it('建立登录态、读取额度/模型并保留 Cookie 而不保存密码', async () => {
    const stub = fakeFetch();
    const store = new MemoryCredentialStore();
    const client = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch: stub.fetch, credentialStore: store });
    const user = await client.login('u@example.com', 'not-persisted');
    expect(user.id).toBe('u1');
    const capabilities = await client.capabilities();
    expect(capabilities.features).toContain('workspace-localization');
    expect(capabilities.quota.remainingUsd).toBe(8);
    const saved = await store.load();
    expect(saved?.cookies.some(cookie => cookie.name === 'dsh_session')).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('not-persisted');
  });

  it('使用嵌套 request 调用会话/工作区，并拒绝越界路径', async () => {
    const stub = fakeFetch();
    const client = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch: stub.fetch, credentialStore: new MemoryCredentialStore() });
    await client.login('u@example.com', 'password');
    const sessions = await client.listSessions({ limit: 10 });
    expect(sessions.items[0]?.id).toBe('s1');
    await client.createSession({ request: { cwd: '/work/project' }, workspaceRoot: '/work' });
    const create = stub.requests.find(request => request.path === '/api/session/create');
    expect(create?.body?.payload).toEqual({ args: { request: { cwd: '/work/project' } } });
    await expect(client.createWorkspace({ request: { path: '/tmp/outside' }, workspaceRoot: '/work' })).rejects.toMatchObject({ code: 'WORKSPACE_PATH_NOT_ALLOWED' });
  });

  it('把额度错误归一化且不泄漏上游文本', async () => {
    const stub = fakeFetch();
    const client = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch: stub.fetch, credentialStore: new MemoryCredentialStore() });
    await client.login('u@example.com', 'password');
    await expect(client.prompt('s1', 'hello')).rejects.toSatisfy((error: unknown) => error instanceof RemoteClientError && error.code === 'QUOTA_EXCEEDED' && !error.message.includes('内部文本'));
  });

  it('拒绝 correlation id 不匹配的 RPC 响应', async () => {
    const stub = fakeFetch({ badRpcId: true });
    const client = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch: stub.fetch, credentialStore: new MemoryCredentialStore() });
    await client.login('u@example.com', 'password');
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('CSRF 失败只刷新首页 Cookie 后重试，401 会清除持久会话', async () => {
    let csrf = 'csrf-a';
    let loginCalls = 0;
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input.toString()).pathname;
      const headers = new Headers(init?.headers);
      if (path === '/') return response('<html>', 200, [`dsh_csrf=${csrf}; Path=/`]);
      if (path === '/auth/login') {
        loginCalls += 1;
        if (loginCalls === 1) { csrf = 'csrf-b'; return response({ error: 'CSRF_INVALID' }, 403); }
        expect(headers.get('x-csrf-token')).toBe('csrf-b');
        return response({ user: { id: 'u1', email: 'u@example.com', displayName: '用户', role: 'user', defaultMode: 'full' } }, 200, ['dsh_session=s; Path=/']);
      }
      return response({ error: 'UNAUTHORIZED' }, 401);
    };
    const store = new MemoryCredentialStore();
    const client = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch, credentialStore: store });
    await client.login('u@example.com', 'password');
    expect(loginCalls).toBe(2);
    const stale = new DshTuiRemoteClient({ endpoint: 'http://127.0.0.1:3080', allowInsecureHttp: true, fetch, credentialStore: store });
    await expect(stale.me()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await store.load()).toBeUndefined();
  });

  it('工作区 generation/revision 冲突时不接受错误 result', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = new RemoteWorkspaceBridge(async command => {
      calls.push({ ...command });
      if (command.action === 'status') return { mode: 'cloud', connected: false, revision: 'r0', accountId: 'u1' };
      if (command.action === 'bind') return { ok: true };
      if (command.action === 'poll') return { request: { id: 'job-1', operation: { action: 'read', path: 'src/a.ts' } }, activeRequestId: 'job-1' };
      return { ok: true };
    });
    await bridge.bind('s1');
    const poll = await bridge.poll('s1');
    expect(poll.request?.id).toBe('job-1');
    await expect(bridge.result('s1', { id: 'other', ok: true, value: null })).rejects.toMatchObject({ code: 'WORKSPACE_REQUEST_MISMATCH' });
    await bridge.result('s1', { id: 'job-1', ok: true, value: 'ok' });
    expect(calls.find(call => call.action === 'bind')?.revision).toBe('r0');
  });

  it('轮询断线时重新绑定，但不会重放未确认的本地操作', async () => {
    const controller = new AbortController();
    let bindCount = 0;
    let pollCount = 0;
    const bridge = new RemoteWorkspaceBridge(async command => {
      if (command.action === 'status') return { mode: 'cloud', connected: false, revision: `r${bindCount}`, accountId: 'u1' };
      if (command.action === 'bind') { bindCount += 1; return { ok: true }; }
      if (command.action === 'poll') {
        pollCount += 1;
        if (pollCount === 1) throw new RemoteClientError('NETWORK_UNAVAILABLE');
        controller.abort();
        return { request: null, activeRequestId: null };
      }
      return { ok: true };
    });
    await bridge.serve('s1', async () => { throw new Error('不应执行'); }, { signal: controller.signal, pollIntervalMs: 1, maxBackoffMs: 1 });
    expect(bindCount).toBeGreaterThanOrEqual(2);
    expect(pollCount).toBe(2);
  });

  it('按 remote.mux open/item/end 协议读取流，并在结束时发送 cancel', async () => {
    let socket: FakeSocket | undefined;
    const transport = new RemoteStreamTransport((url, options) => {
      expect(url).toBe('wss://chat.example.com/api/remote.mux');
      expect(options.headers.cookie).toBe('dsh_session=opaque');
      socket = new FakeSocket();
      queueMicrotask(() => socket?.emit('open', {}));
      return socket;
    }, 'wss://chat.example.com/api/remote.mux', { origin: 'https://chat.example.com', cookie: 'dsh_session=opaque' });
    const valuesPromise = (async () => {
      const values: unknown[] = [];
      for await (const value of transport.open('session/follow', { args: {} })) values.push(value);
      return values;
    })();
    await new Promise(resolve => setTimeout(resolve, 10));
    const open = JSON.parse(socket!.sent[0]!) as { streamId: string };
    socket!.emit('message', { data: JSON.stringify({ type: 'item', streamId: open.streamId, value: { text: 'ok' } }) });
    socket!.emit('message', { data: JSON.stringify({ type: 'end', streamId: open.streamId }) });
    await expect(valuesPromise).resolves.toEqual([{ text: 'ok' }]);
    expect(JSON.parse(socket!.sent[0]!).type).toBe('open');
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close', {}); }
  emit(type: string, event: unknown): void { if (type === 'open') this.readyState = 1; for (const listener of this.listeners.get(type) ?? []) listener(event); }
}
