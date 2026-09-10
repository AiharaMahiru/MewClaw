import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { setTimeout } from 'node:timers/promises';
import { LocalWorkspaceBinding, type WorkspaceBinding } from './workspace-binding.js';

type Transport = (command: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
interface ActiveBinding { files: LocalWorkspaceBinding; binding: WorkspaceBinding; abort: AbortController }
export class WorkspaceController {
  private readonly active = new Map<string, ActiveBinding>();
  private readonly selecting = new Set<string>();
  private lifetime = new AbortController();
  constructor(private readonly options: { fs(): FileSystem; pick(): Promise<string | null>; maxBytes: number; maxEntries: number }) {}

  async select(input: { sessionId: string; mode: 'cloud' | 'desktop' }, transport: Transport): Promise<unknown> {
    if (this.selecting.has(input.sessionId)) throw new Error('WORKSPACE_BUSY');
    this.selecting.add(input.sessionId);
    try { return await this.change(input, transport); }
    finally { this.selecting.delete(input.sessionId); }
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
    if (this.active.size >= 10 && !this.active.has(input.sessionId)) throw new Error('WORKSPACE_CAPACITY');
    const files = new LocalWorkspaceBinding(this.options.fs(), this.options);
    const binding = await files.authorize({ accountId: status.accountId, sessionId: input.sessionId }, this.options.pick);
    if (!binding) return { ...status, cancelled: true };
    try { signal.throwIfAborted(); await transport({ action: 'bind', sessionId: input.sessionId, generation: binding.generation, revision: status.revision }, signal); signal.throwIfAborted(); }
    catch (error) { files.revoke(); throw error; }
    this.revoke(input.sessionId);
    const active = { files, binding, abort: new AbortController() };
    this.active.set(input.sessionId, active);
    void this.poll(active, transport).finally(() => { if (this.active.get(input.sessionId) === active) this.revoke(input.sessionId); });
    return { mode: 'desktop', connected: true };
  }

  private async poll(active: ActiveBinding, transport: Transport): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, active.abort.signal]);
    const identity = { sessionId: active.binding.sessionId, generation: active.binding.generation };
    try {
      while (!signal.aborted) {
        const response = await transport({ ...identity, action: 'poll' }, signal);
        if (response.request !== null) {
          const request = response.request as { id?: unknown; operation?: unknown } | undefined;
          if (!request || typeof request.id !== 'string') throw new Error('INVALID_WORKSPACE_REQUEST');
          let result: { id: string; ok: boolean; value: unknown };
          try { result = { id: request.id, ok: true, value: await active.files.execute({ ...active.binding, operation: request.operation }, signal) }; }
          catch { result = { id: request.id, ok: false, value: 'LOCAL_FILE_OPERATION_REJECTED' }; }
          await transport({ ...identity, action: 'result', result }, signal);
        }
        await setTimeout(1000, undefined, { signal });
      }
    } catch { /* 断线即撤销，绝不重放写操作或切回服务器目录。 */ }
  }

  revoke(sessionId: string): void {
    const current = this.active.get(sessionId);
    current?.abort.abort(); current?.files.revoke(); this.active.delete(sessionId);
  }
  revokeAll(): void {
    this.lifetime.abort(); this.lifetime = new AbortController();
    for (const id of this.active.keys()) this.revoke(id);
  }
  dispose(): void {
    this.lifetime.abort();
    for (const id of this.active.keys()) this.revoke(id);
  }
}
