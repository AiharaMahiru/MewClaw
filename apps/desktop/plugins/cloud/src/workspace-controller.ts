/** 本机授权与单会话轮询；模型不能更改权限，断线不重放副作用。 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { setTimeout } from 'node:timers/promises';
import { SyncEngine, type SyncEndpoint, type SyncManifest, type SyncReport } from 'dsh-lark-desktop-host';
import { LocalWorkspaceBinding, type WorkspaceBinding } from './workspace-binding.js';

type Transport = (command: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
interface ToolResult { id: string; ok: boolean; value: unknown }
interface ToolJob { id: string; abort: AbortController; done?: ToolResult; promise?: Promise<void> }
interface ActiveBinding {
  files: LocalWorkspaceBinding; binding: WorkspaceBinding; abort: AbortController;
  sync?: SyncEngine | undefined; syncAbort?: AbortController | undefined; syncReport?: SyncReport | undefined;
  syncError?: string | undefined; nextSync: number;
}
export interface ControllerOptions {
  fs(): FileSystem; pick(): Promise<string | null>; shell?(): ShellExecutor;
  confirm?(kind: 'shell' | 'sync'): Promise<boolean>;
  maxBytes: number; maxEntries: number; maxBindings?: number; pollIntervalMs?: number;
  shellTimeoutMs?: number; shellMaxOutputBytes?: number;
  syncIntervalMs?: number; syncMaxBytes?: number; syncMaxEntries?: number; syncMaxTotalBytes?: number;
}
export class WorkspaceController {
  private readonly active = new Map<string, ActiveBinding>();
  private readonly selecting = new Set<string>();
  private lifetime = new AbortController();
  constructor(private readonly options: ControllerOptions) {}

  async select(input: { sessionId: string; mode: 'cloud' | 'desktop' }, transport: Transport): Promise<unknown> {
    return this.lock(input.sessionId, () => this.change(input, transport));
  }
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.selecting.has(id)) throw new Error('WORKSPACE_BUSY');
    this.selecting.add(id); try { return await operation(); } finally { this.selecting.delete(id); }
  }
  async status(sessionId: string, transport: Transport): Promise<Record<string, unknown>> {
    const cloud = await transport({ action: 'status', sessionId }, this.lifetime.signal);
    const active = this.active.get(sessionId);
    if (active && cloud.accountId !== active.binding.accountId) { this.revoke(sessionId); throw new Error('WORKSPACE_LOGIN_REQUIRED'); }
    return { ...cloud, connected: cloud.connected === true && !!active, shellEnabled: active?.files.shellEnabled ?? false,
      syncEnabled: !!active?.sync, syncReport: active?.syncReport, syncError: active?.syncError };
  }
  async permission(sessionId: string, kind: 'shell' | 'sync', enabled: boolean, transport: Transport): Promise<unknown> {
    return this.lock(sessionId, async () => {
      await this.status(sessionId, transport);
      const active = this.active.get(sessionId);
      if (!active) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
      if (enabled) {
        if (!this.options.confirm || !await this.options.confirm(kind)) return this.status(sessionId, transport);
        active.abort.signal.throwIfAborted();
        if (this.active.get(sessionId) !== active) throw new Error('LOCAL_WORKSPACE_REVOKED');
        await this.status(sessionId, transport); active.abort.signal.throwIfAborted();
        if (kind === 'shell') {
          if (!this.options.shell) throw new Error('LOCAL_SHELL_UNAVAILABLE');
          active.files.grantShell(this.options.shell(), { timeoutMs: this.options.shellTimeoutMs ?? 30000, maxOutputBytes: this.options.shellMaxOutputBytes ?? 65536 });
        } else {
          const local = await active.files.syncDirectory({ maxBytes: this.options.syncMaxBytes ?? 1048576,
            maxEntries: this.options.syncMaxEntries ?? 2000, maxTotalBytes: this.options.syncMaxTotalBytes ?? 33554432 });
          active.abort.signal.throwIfAborted();
          active.syncAbort?.abort(); active.syncAbort = new AbortController();
          active.sync = new SyncEngine(local, this.remote(active, transport)); active.nextSync = 0; active.syncError = undefined;
        }
      } else if (kind === 'shell') active.files.revokeShell();
      else { active.syncAbort?.abort(); active.sync = undefined; }
      return this.status(sessionId, transport);
    });
  }
  private remote(active: ActiveBinding, transport: Transport): SyncEndpoint {
    const call = async (operation: unknown, signal: AbortSignal) => (await transport({ action: 'sync',
      sessionId: active.binding.sessionId, generation: active.binding.generation, operation }, signal)).value;
    return {
      snapshot: async signal => {
        const value = await call({ action: 'snapshot' }, signal);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SYNC_INVALID_RESPONSE');
        for (const item of Object.values(value)) if (!item || typeof item !== 'object' || typeof item.hash !== 'string' || !/^[0-9a-f]{64}$/.test(item.hash) || !Number.isSafeInteger(item.size)) throw new Error('SYNC_INVALID_RESPONSE');
        return value as SyncManifest;
      },
      read: async (path, expected, signal) => { const value = await call({ action: 'read', path, expected }, signal); if (typeof value !== 'string') throw new Error('SYNC_INVALID_RESPONSE'); return value; },
      write: async (path, data, expected, signal) => { await call({ action: 'write', path, data, expected }, signal); },
      remove: async (path, expected, signal) => { await call({ action: 'remove', path, expected }, signal); },
    };
  }
  private async change(input: { sessionId: string; mode: 'cloud' | 'desktop' }, transport: Transport): Promise<unknown> {
    const signal = this.lifetime.signal;
    const status = await transport({ action: 'status', sessionId: input.sessionId }, signal);
    signal.throwIfAborted();
    if (typeof status.accountId !== 'string') throw new Error('INVALID_WORKSPACE_IDENTITY');
    if (input.mode === 'cloud') {
      const generation = this.active.get(input.sessionId)?.binding.generation ?? 'explicit-user-unbind';
      await transport({ action: 'unbind', sessionId: input.sessionId, generation, revision: status.revision }, signal);
      this.revoke(input.sessionId); return { mode: 'cloud', connected: false };
    }
    if (this.active.size >= (this.options.maxBindings ?? 10) && !this.active.has(input.sessionId)) throw new Error('WORKSPACE_CAPACITY');
    const files = new LocalWorkspaceBinding(this.options.fs(), this.options);
    const binding = await files.authorize({ accountId: status.accountId, sessionId: input.sessionId }, this.options.pick);
    if (!binding) return { ...status, cancelled: true };
    try { signal.throwIfAborted(); await transport({ action: 'bind', sessionId: input.sessionId, generation: binding.generation, revision: status.revision }, signal); signal.throwIfAborted(); }
    catch (error) { files.revoke(); throw error; }
    this.revoke(input.sessionId);
    const active: ActiveBinding = { files, binding, abort: new AbortController(), nextSync: 0 };
    this.active.set(input.sessionId, active);
    void this.poll(active, transport).finally(() => { if (this.active.get(input.sessionId) === active) this.revoke(input.sessionId); });
    return { mode: 'desktop', connected: true, shellEnabled: false, syncEnabled: false };
  }
  private async poll(active: ActiveBinding, transport: Transport): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, active.abort.signal]);
    const identity = { sessionId: active.binding.sessionId, generation: active.binding.generation };
    let job: ToolJob | undefined;
    try {
      while (!signal.aborted) {
        if (job?.done) { await transport({ ...identity, action: 'result', result: job.done }, signal); job = undefined; }
        const response = await transport({ ...identity, action: 'poll' }, signal);
        if (job && response.activeRequestId !== job.id) { job.abort.abort(); await job.promise; job = undefined; }
        if (response.request !== null) {
          const request = response.request as { id?: unknown; operation?: unknown } | undefined;
          if (job || !request || typeof request.id !== 'string') throw new Error('INVALID_WORKSPACE_REQUEST');
          const running: ToolJob = { id: request.id, abort: new AbortController() }; job = running;
          running.promise = active.files.execute({ ...active.binding, operation: request.operation }, AbortSignal.any([signal, running.abort.signal]))
            .then(value => { running.done = { id: running.id, ok: true, value }; }, error => {
              const code = error instanceof Error && /^LOCAL_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_OPERATION_REJECTED';
              running.done = { id: running.id, ok: false, value: code };
            });
        }
        if (!job && active.sync && Date.now() >= active.nextSync) {
          const engine = active.sync;
          try { active.syncReport = await engine.run(AbortSignal.any([signal, active.syncAbort!.signal])); }
          catch (error) {
            if (signal.aborted || error instanceof Error && error.message === 'WORKSPACE_LOGIN_REQUIRED') throw error;
            if (active.sync === engine) { active.sync = undefined; active.syncError = error instanceof Error && /^(SYNC|WORKSPACE)_[A-Z_]+$/.test(error.message) ? error.message : 'SYNC_STOPPED'; }
          }
          active.nextSync = Date.now() + (this.options.syncIntervalMs ?? 5000);
        }
        await setTimeout(this.options.pollIntervalMs ?? 1000, undefined, { signal });
      }
    } catch { /* 断线/过期撤销授权，不重放 Shell 或文件副作用。 */ }
    finally { job?.abort.abort(); await job?.promise; }
  }
  revoke(sessionId: string): void {
    const current = this.active.get(sessionId);
    current?.abort.abort(); current?.syncAbort?.abort(); current?.files.revoke(); this.active.delete(sessionId);
  }
  revokeAll(): void {
    this.lifetime.abort(); this.lifetime = new AbortController();
    for (const id of this.active.keys()) this.revoke(id);
  }
  dispose(): void { this.lifetime.abort(); for (const id of this.active.keys()) this.revoke(id); }
}
