import { randomUUID } from 'node:crypto';

import { MemoryCredentialStore, FileCredentialStore } from './credential-store.js';
import { RemoteClientError, errorFromWire, normalizeErrorCode } from './errors.js';
import { RemoteWorkspaceBridge } from './local-workspace.js';
import { parseModels, parseQuota, parseSession, parseSessions, parseUser, parseWorkspaces, unwrapValue } from './parsers.js';
import { assertWorkspacePath } from './path-boundary.js';
import { RemoteStreamTransport } from './remote-stream.js';
import { RemoteHttpTransport } from './transport.js';
import type {
  CredentialStore,
  ModelCatalog,
  QuotaSnapshot,
  RemoteCapabilities,
  RemoteClientOptions,
  RemoteUser,
  SessionCreateOptions,
  SessionListOptions,
  SessionSummary,
  StreamOptions,
  WorkspaceCreateOptions,
  WorkspaceEntry,
} from './types.js';

/** dsh Web 远程客户端；TUI 只依赖此类，不接触 dsh Web 的服务端凭证。 */
export class DshTuiRemoteClient {
  readonly http: RemoteHttpTransport;
  readonly workspace: RemoteWorkspaceBridge;
  readonly credentialStore: CredentialStore;
  private readonly readyPromise: Promise<void>;
  private user: RemoteUser | undefined;

  constructor(options: RemoteClientOptions) {
    this.credentialStore = options.credentialStore ?? new FileCredentialStore();
    this.http = new RemoteHttpTransport(options);
    this.workspace = new RemoteWorkspaceBridge((command, signal) => this.workspaceCommand(command, signal));
    this.readyPromise = this.restoreStoredSession();
  }

  /** 载入本地 Cookie 并验证会话；没有会话时返回 undefined。 */
  async restore(): Promise<RemoteUser | undefined> {
    await this.readyPromise;
    if (!this.http.cookies.header(this.http.endpoint.http)) return undefined;
    try {
      this.user = await this.me();
      return this.user;
    } catch (error) {
      if (error instanceof RemoteClientError && error.code === 'AUTH_REQUIRED') {
        await this.clearStoredSession();
        return undefined;
      }
      throw error;
    }
  }

  /** `restore()` 的语义别名，便于 TUI 启动器使用 connect 命名。 */
  async connect(): Promise<RemoteUser | undefined> { return this.restore(); }

  get currentUser(): RemoteUser | undefined { return this.user; }

  async login(email: string, password: string): Promise<RemoteUser> {
    await this.readyPromise;
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) throw new RemoteClientError('INVALID_CREDENTIALS');
    await this.http.bootstrap();
    const body = await this.http.json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    this.user = parseUser(body);
    await this.persistSession();
    return this.user;
  }

  async me(): Promise<RemoteUser> {
    await this.readyPromise;
    try {
      const body = await this.http.json('/auth/me');
      this.user = parseUser(body);
      await this.persistSession();
      return this.user;
    } catch (error) {
      if (error instanceof RemoteClientError && error.status === 401) {
        this.user = undefined;
        await this.clearStoredSession();
        throw new RemoteClientError('AUTH_REQUIRED', { status: 401 });
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.readyPromise;
    try {
      if (this.http.cookies.header(this.http.endpoint.http)) await this.http.json('/auth/logout', { method: 'POST', body: '{}' });
    } finally {
      this.user = undefined;
      this.http.cookies.clear();
      await this.credentialStore.clear();
    }
  }

  async models(): Promise<ModelCatalog> {
    await this.readyPromise;
    try { return parseModels(await this.http.json('/auth/models')); }
    catch (error) { throw await this.authBoundary(error); }
  }

  async quota(): Promise<QuotaSnapshot> {
    await this.readyPromise;
    try { return parseQuota(await this.http.json('/api/billing/usage')); }
    catch (error) { throw await this.authBoundary(error); }
  }

  async capabilities(): Promise<RemoteCapabilities> {
    const user = this.user ?? await this.me();
    const [quota, models] = await Promise.all([this.quota(), this.models()]);
    return {
      protocol: 'dsh-tui-remote/1',
      location: 'remote',
      features: ['auth', 'quota', 'models', 'sessions', 'workspaces', 'workspace-localization'],
      user,
      quota,
      models,
    };
  }

  /** 调用官方 `/api/<method>`；args 会保留在 payload.args 内。 */
  async rpc<T = unknown>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    await this.readyPromise;
    const canonical = validMethod(method);
    let body: unknown;
    try {
      body = await this.http.json(`/api/${canonical.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rpcId: randomUUID(), method: canonical, payload: { args } }),
      }, signal);
    } catch (error) {
      throw await this.authBoundary(error);
    }
    return unwrapRpc<T>(body);
  }

  async listSessions(options: SessionListOptions = {}, signal?: AbortSignal): Promise<{ items: SessionSummary[]; nextCursor?: string }> {
    const args = compact(options as unknown as Record<string, unknown>);
    return parseSessions(await this.rpc('session/list', args, signal));
  }

  async createSession(options: SessionCreateOptions, signal?: AbortSignal): Promise<SessionSummary | Record<string, unknown>> {
    const request = { ...options.request };
    if (request.workspaceId && request.cwd) throw new RemoteClientError('WORKSPACE_PATH_NOT_ALLOWED');
    if (request.cwd && options.workspaceRoot) assertWorkspacePath(request.cwd, options.workspaceRoot);
    const value = await this.rpc('session/create', { request }, signal);
    const parsed = parseSession(unwrapValue(value));
    return parsed ?? objectResult(value);
  }

  async forkSession(sessionId: string, request: Record<string, unknown> = {}, signal?: AbortSignal): Promise<SessionSummary | Record<string, unknown>> {
    const value = await this.rpc('session/fork', { request: { ...request, sessionId: validId(sessionId) } }, signal);
    const parsed = parseSession(unwrapValue(value));
    return parsed ?? objectResult(value);
  }

  async renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<unknown> {
    return this.rpc('session/rename', { sessionId: validId(sessionId), title: validTitle(title) }, signal);
  }

  async selectModel(sessionId: string, model: string, signal?: AbortSignal): Promise<unknown> {
    return this.rpc('session/selectModel', { sessionId: validId(sessionId), model: validTitle(model) }, signal);
  }

  async prompt(sessionId: string, text: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!text.trim()) throw new RemoteClientError('INVALID_RESPONSE');
    try { return await this.rpc('session/prompt', { request: { ...extra, sessionId: validId(sessionId), text } }, signal); }
    catch (error) {
      if (error instanceof RemoteClientError && /QUOTA|BALANCE|CREDIT/u.test(error.code)) throw new RemoteClientError('QUOTA_EXCEEDED', error.status === undefined ? {} : { status: error.status });
      if (error instanceof RemoteClientError && /MODEL|PROVIDER/u.test(error.code)) throw new RemoteClientError('MODEL_UNAVAILABLE', error.status === undefined ? {} : { status: error.status });
      throw error;
    }
  }

  async cancelSession(sessionId: string, signal?: AbortSignal): Promise<unknown> { return this.rpc('session/cancel', { sessionId: validId(sessionId) }, signal); }

  async listWorkspaces(signal?: AbortSignal): Promise<{ items: WorkspaceEntry[]; raw: unknown }> { return parseWorkspaces(await this.rpc('workspace/list', {}, signal)); }

  async createWorkspace(options: WorkspaceCreateOptions, signal?: AbortSignal): Promise<WorkspaceEntry | Record<string, unknown>> {
    if (options.workspaceRoot) assertWorkspacePath(options.request.path, options.workspaceRoot);
    // Auth Edge 的 workspace/create 契约只读取嵌套 request.path。
    const value = await this.rpc('workspace/create', { request: { ...options.request } }, signal);
    const parsed = parseWorkspaces(value).items[0];
    return parsed ?? objectResult(value);
  }

  async renameWorkspace(workspaceId: string, title: string, signal?: AbortSignal): Promise<unknown> { return this.rpc('workspace/rename', { workspaceId: validId(workspaceId), title: validTitle(title) }, signal); }
  async deleteWorkspace(workspaceId: string, signal?: AbortSignal): Promise<unknown> { return this.rpc('workspace/delete', { workspaceId: validId(workspaceId) }, signal); }

  openStream(endpoint: string, payload: unknown, options: StreamOptions = {}): AsyncIterable<unknown> {
    return this.openStreamAfterReady(endpoint, payload, options);
  }

  private async *openStreamAfterReady(endpoint: string, payload: unknown, options: StreamOptions): AsyncGenerator<unknown> {
    await this.readyPromise;
    const socketUrl = this.http.endpoint.websocket.toString();
    const cookie = this.http.cookies.header(this.http.endpoint.websocket);
    const headers: Record<string, string> = { origin: this.http.endpoint.origin };
    if (cookie) headers.cookie = cookie;
    const transport = new RemoteStreamTransport(this.http.websocketFactory, socketUrl, headers);
    yield* transport.open(endpoint, payload, options);
  }

  /** 供 dsh-TUI 的 Workspace Host Port 使用的远程适配面。 */
  createTuiAdapter(): {
    readonly location: 'remote';
    readonly auth: { readonly connect: () => Promise<RemoteUser | undefined>; readonly login: (email: string, password: string) => Promise<RemoteUser>; readonly logout: () => Promise<void>; readonly me: () => Promise<RemoteUser> };
    readonly capabilities: () => Promise<RemoteCapabilities>;
    readonly sessions: Pick<DshTuiRemoteClient, 'listSessions' | 'createSession' | 'forkSession' | 'renameSession' | 'selectModel' | 'prompt' | 'cancelSession'>;
    readonly workspaces: Pick<DshTuiRemoteClient, 'listWorkspaces' | 'createWorkspace' | 'renameWorkspace' | 'deleteWorkspace'>;
    readonly workspace: RemoteWorkspaceBridge;
    readonly openStream: (endpoint: string, payload: unknown, options?: StreamOptions) => AsyncIterable<unknown>;
  } {
    return {
      location: 'remote',
      auth: { connect: this.connect.bind(this), login: this.login.bind(this), logout: this.logout.bind(this), me: this.me.bind(this) },
      capabilities: this.capabilities.bind(this),
      sessions: {
        listSessions: this.listSessions.bind(this),
        createSession: this.createSession.bind(this),
        forkSession: this.forkSession.bind(this),
        renameSession: this.renameSession.bind(this),
        selectModel: this.selectModel.bind(this),
        prompt: this.prompt.bind(this),
        cancelSession: this.cancelSession.bind(this),
      },
      workspaces: {
        listWorkspaces: this.listWorkspaces.bind(this),
        createWorkspace: this.createWorkspace.bind(this),
        renameWorkspace: this.renameWorkspace.bind(this),
        deleteWorkspace: this.deleteWorkspace.bind(this),
      },
      workspace: this.workspace,
      openStream: this.openStream.bind(this),
    };
  }

  private async workspaceCommand(command: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.readyPromise;
    try {
      const value = await this.http.json('/desktop-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, signal);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteClientError('INVALID_RESPONSE');
      return value as Record<string, unknown>;
    } catch (error) { throw await this.authBoundary(error); }
  }

  private async restoreStoredSession(): Promise<void> {
    const stored = await this.credentialStore.load();
    const endpoint = `${this.http.endpoint.origin}${this.http.endpoint.basePath}` || this.http.endpoint.origin;
    if (stored && stored.endpoint === endpoint) this.http.cookies.replace(stored.cookies);
  }

  private async persistSession(): Promise<void> {
    const endpoint = `${this.http.endpoint.origin}${this.http.endpoint.basePath}` || this.http.endpoint.origin;
    await this.credentialStore.save({ endpoint, cookies: this.http.cookies.export() });
  }

  private async clearStoredSession(): Promise<void> {
    this.http.cookies.clear();
    await this.credentialStore.clear();
  }

  private async authBoundary(error: unknown): Promise<RemoteClientError> {
    if (error instanceof RemoteClientError && error.status === 401) {
      this.user = undefined;
      await this.clearStoredSession();
      return new RemoteClientError('AUTH_REQUIRED', { status: 401 });
    }
    return error instanceof RemoteClientError ? error : errorFromWire(undefined);
  }
}

/** 仅供需要临时、无文件落盘会话的调用方使用。 */
export function createMemoryRemoteClient(options: Omit<RemoteClientOptions, 'credentialStore'>): DshTuiRemoteClient {
  return new DshTuiRemoteClient({ ...options, credentialStore: new MemoryCredentialStore() });
}

function validMethod(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('..') || !/^[A-Za-z0-9_$./-]+$/u.test(value)) throw new RemoteClientError('INVALID_RESPONSE');
  return value.replace(/^\/+|\/+$/gu, '');
}
function validId(value: string): string { if (typeof value !== 'string' || !value || value.length > 512) throw new RemoteClientError('INVALID_RESPONSE'); return value; }
function validTitle(value: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new RemoteClientError('INVALID_RESPONSE'); return value; }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function objectResult(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }; }

function unwrapRpc<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value as T;
  const record = value as Record<string, unknown>;
  if (record.type === 'server-response') {
    const rpcId = record.rpcId;
    const result = record.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new RemoteClientError('INVALID_RESPONSE');
    const resultRecord = result as Record<string, unknown>;
    if (resultRecord.ok === false) {
      const error = resultRecord.error;
      const code = error && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>).code : undefined;
      throw new RemoteClientError(normalizeErrorCode(code, 'REMOTE_UNAVAILABLE'), { details: typeof rpcId === 'string' ? { rpcId } : {} });
    }
    if (resultRecord.ok === true && Object.hasOwn(resultRecord, 'value')) return resultRecord.value as T;
    throw new RemoteClientError('INVALID_RESPONSE');
  }
  if (record.ok === false) {
    const error = record.error;
    const code = error && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>).code : record.error;
    throw new RemoteClientError(normalizeErrorCode(code, 'REMOTE_UNAVAILABLE'));
  }
  if (record.result && typeof record.result === 'object' && !Array.isArray(record.result) && (record.result as Record<string, unknown>).ok === false) {
    const error = (record.result as Record<string, unknown>).error;
    const code = error && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>).code : undefined;
    throw new RemoteClientError(normalizeErrorCode(code, 'REMOTE_UNAVAILABLE'));
  }
  return unwrapValue(value) as T;
}
