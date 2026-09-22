import { randomUUID } from 'node:crypto';

import { RemoteClientError, errorFromWire } from './errors.js';
import { assertRelativeWorkspacePath } from './path-boundary.js';
import type { LocalWorkspaceServeOptions, WorkspaceCommandResult, WorkspaceOperationExecutor, WorkspacePollResult, WorkspaceStatus } from './types.js';

export type WorkspaceCommandTransport = (command: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<WorkspaceCommandResult>;

/** dsh Web `/desktop-workspace` 的 TUI 侧薄客户端。 */
export class RemoteWorkspaceBridge {
  private generationBySession = new Map<string, string>();
  private pendingBySession = new Map<string, string>();

  constructor(private readonly transport: WorkspaceCommandTransport) {}

  async status(sessionId: string, signal?: AbortSignal): Promise<WorkspaceStatus> {
    const value = await this.call({ action: 'status', sessionId: validSessionId(sessionId) }, signal);
    if (!isObject(value) || (value.mode !== 'cloud' && value.mode !== 'desktop') || typeof value.connected !== 'boolean'
      || typeof value.revision !== 'string' || typeof value.accountId !== 'string') throw new RemoteClientError('INVALID_RESPONSE');
    return value as WorkspaceStatus;
  }

  async bind(sessionId: string, options: { generation?: string; signal?: AbortSignal } = {}): Promise<WorkspaceStatus> {
    const id = validSessionId(sessionId);
    const before = await this.status(id, options.signal);
    const generation = validGeneration(options.generation ?? randomUUID());
    await this.call({ action: 'bind', sessionId: id, generation, revision: before.revision }, options.signal);
    this.generationBySession.set(id, generation);
    this.pendingBySession.delete(id);
    return this.status(id, options.signal);
  }

  async unbind(sessionId: string, signal?: AbortSignal): Promise<WorkspaceStatus> {
    const id = validSessionId(sessionId);
    const before = await this.status(id, signal);
    const generation = this.generationBySession.get(id) ?? randomUUID();
    await this.call({ action: 'unbind', sessionId: id, generation: validGeneration(generation), revision: before.revision }, signal);
    this.generationBySession.delete(id);
    this.pendingBySession.delete(id);
    return this.status(id, signal);
  }

  async poll(sessionId: string, signal?: AbortSignal): Promise<WorkspacePollResult> {
    const id = validSessionId(sessionId);
    const generation = this.generationBySession.get(id);
    if (!generation) throw new RemoteClientError('LOCAL_WORKSPACE_DISCONNECTED');
    const value = await this.call({ action: 'poll', sessionId: id, generation }, signal);
    if (!isObject(value)) throw new RemoteClientError('INVALID_RESPONSE');
    const requestValue = value.request;
    let request: WorkspacePollResult['request'] = null;
    if (requestValue !== null && requestValue !== undefined) {
      if (!isObject(requestValue) || typeof requestValue.id !== 'string' || !Object.hasOwn(requestValue, 'operation')) throw new RemoteClientError('INVALID_RESPONSE');
      request = { id: requestValue.id, operation: requestValue.operation };
      const previous = this.pendingBySession.get(id);
      if (previous && previous !== request.id) throw new RemoteClientError('WORKSPACE_REQUEST_MISMATCH');
      this.pendingBySession.set(id, request.id);
    }
    const activeRequestId = value.activeRequestId === null || value.activeRequestId === undefined ? null : String(value.activeRequestId);
    return { request, activeRequestId };
  }

  async result(sessionId: string, result: { id: string; ok: boolean; value: unknown }, signal?: AbortSignal): Promise<void> {
    const id = validSessionId(sessionId);
    if (!result || typeof result.id !== 'string' || !result.id || typeof result.ok !== 'boolean') throw new RemoteClientError('WORKSPACE_REQUEST_MISMATCH');
    if (this.pendingBySession.get(id) !== result.id) throw new RemoteClientError('WORKSPACE_REQUEST_MISMATCH');
    const generation = this.generationBySession.get(id);
    if (!generation) throw new RemoteClientError('LOCAL_WORKSPACE_DISCONNECTED');
    // 成功或失败都只允许提交一次；网络错误时保留未知状态并让 serve 停止。
    await this.call({ action: 'result', sessionId: id, generation, result }, signal);
    this.pendingBySession.delete(id);
  }

  async sync(sessionId: string, operation: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = validSessionId(sessionId);
    const generation = this.generationBySession.get(id);
    if (!generation) throw new RemoteClientError('LOCAL_WORKSPACE_DISCONNECTED');
    if (isObject(operation) && typeof operation.path === 'string') assertRelativeWorkspacePath(operation.path);
    const value = await this.call({ action: 'sync', sessionId: id, generation, operation }, signal);
    if (!isObject(value) || !Object.hasOwn(value, 'value')) throw new RemoteClientError('INVALID_RESPONSE');
    return value.value;
  }

  /** 轮询并执行本机文件操作；断线重绑只发生在没有未确认副作用时。 */
  async serve(sessionId: string, execute: WorkspaceOperationExecutor, options: LocalWorkspaceServeOptions = {}): Promise<void> {
    const id = validSessionId(sessionId);
    const signal = options.signal ?? new AbortController().signal;
    const pollIntervalMs = positive(options.pollIntervalMs, 1000);
    const maxBackoffMs = positive(options.maxBackoffMs, 10_000);
    const autoRebind = options.autoRebind !== false;
    if (!this.generationBySession.has(id)) await this.bind(id, { signal });
    let backoff = pollIntervalMs;
    while (!signal.aborted) {
      try {
        const poll = await this.poll(id, signal);
        backoff = pollIntervalMs;
        if (poll.request) {
          let value: unknown;
          try { value = await execute(poll.request.operation, signal); }
          catch (error) {
            if (signal.aborted) return;
            const code = error instanceof RemoteClientError ? error.code : 'LOCAL_OPERATION_REJECTED';
            await this.result(id, { id: poll.request.id, ok: false, value: code }, signal);
            await delay(pollIntervalMs, signal);
            continue;
          }
          // result 的提交若失败，绝不自动重放 execute；直接交给宿主显示断线。
          await this.result(id, { id: poll.request.id, ok: true, value }, signal);
        }
        await delay(pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        // result 阶段失败时 pending 仍在 map 中，自动重绑会造成副作用不确定，必须停机。
        if (this.pendingBySession.has(id)) throw new RemoteClientError('LOCAL_WORKSPACE_DISCONNECTED');
        if (!autoRebind || !isRecoverable(error)) throw normalizeWorkspaceError(error);
        await delay(backoff, signal);
        backoff = Math.min(maxBackoffMs, Math.max(pollIntervalMs, backoff * 2));
        await this.bind(id, { signal });
      }
    }
  }

  revoke(sessionId: string): void { this.generationBySession.delete(sessionId); this.pendingBySession.delete(sessionId); }

  private async call(command: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<WorkspaceCommandResult> {
    const requestSignal = signal ?? new AbortController().signal;
    const response = await this.transport(command, requestSignal);
    if (!isObject(response)) throw new RemoteClientError('INVALID_RESPONSE');
    if (typeof response.error === 'string') throw new RemoteClientError(response.error);
    return response;
  }
}

function validSessionId(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new RemoteClientError('INVALID_RESPONSE');
  return value;
}
function validGeneration(value: string): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128) throw new RemoteClientError('INVALID_RESPONSE');
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function positive(value: number | undefined, fallback: number): number { return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function isRecoverable(value: unknown): boolean { return value instanceof RemoteClientError && (value.retryable || value.code === 'LOCAL_WORKSPACE_DISCONNECTED' || value.code === 'WORKSPACE_BRIDGE_UNAVAILABLE'); }
function normalizeWorkspaceError(value: unknown): RemoteClientError { return value instanceof RemoteClientError ? value : errorFromWire(undefined); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
