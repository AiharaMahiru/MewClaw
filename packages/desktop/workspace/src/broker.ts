/** 云端工作区传输状态；文件执行始终留在获得授权的桌面Host。 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

export interface WorkspaceState { owner: string; mode: 'cloud' | 'desktop'; generation: string }
export interface WorkspaceJournal {
  read(sessionId: string): WorkspaceState | undefined;
  write(sessionId: string, state: WorkspaceState): Promise<void>;
}
export interface BridgeIdentity { sessionId: string; owner: string; generation: string; revision?: string }
interface Pending {
  id: string;
  operation: unknown;
  delivered: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
interface Connection { identity: BridgeIdentity; lastPoll: number; pending?: Pending | undefined }
export interface BrokerLimits { requestTimeoutMs: number; heartbeatTimeoutMs: number; maxBindings: number }

function sameGeneration(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WorkspaceBroker {
  private readonly connections = new Map<string, Connection>();
  private readonly changing = new Set<string>();
  private disposed = false;
  constructor(private readonly journal: WorkspaceJournal, private readonly limits: BrokerLimits) {}

  status(sessionId: string, owner: string): { mode: 'cloud' | 'desktop'; connected: boolean; revision: string } {
    const state = this.state(sessionId, owner);
    const connection = this.connections.get(sessionId);
    return { mode: state?.mode ?? 'cloud', revision: state?.generation ?? '', connected: !!connection && Date.now() - connection.lastPoll < this.limits.heartbeatTimeoutMs };
  }

  private state(sessionId: string, owner: string): WorkspaceState | undefined {
    if (this.disposed) throw new Error('WORKSPACE_BRIDGE_DISPOSED');
    const state = this.journal.read(sessionId);
    if (state && state.owner !== owner) throw new Error('WORKSPACE_OWNER_MISMATCH');
    return state;
  }

  async select(identity: BridgeIdentity, mode: 'cloud' | 'desktop'): Promise<void> {
    const state = this.state(identity.sessionId, identity.owner);
    this.prune();
    if (this.changing.has(identity.sessionId) || this.connections.get(identity.sessionId)?.pending) throw new Error('WORKSPACE_BUSY');
    if (identity.revision !== (state?.generation ?? '')) throw new Error('WORKSPACE_REVISION_CONFLICT');
    if (mode === 'desktop' && !this.connections.has(identity.sessionId) && this.connections.size >= this.limits.maxBindings) throw new Error('WORKSPACE_CAPACITY');
    this.changing.add(identity.sessionId);
    this.disconnect(identity.sessionId);
    try {
      await this.journal.write(identity.sessionId, { owner: identity.owner, mode, generation: randomUUID() });
      if (this.disposed) throw new Error('WORKSPACE_BRIDGE_DISPOSED');
      if (mode === 'desktop') this.connections.set(identity.sessionId, { identity: { ...identity }, lastPoll: Date.now() });
    } finally { this.changing.delete(identity.sessionId); }
  }

  private authenticated(identity: BridgeIdentity): Connection {
    this.state(identity.sessionId, identity.owner);
    const connection = this.connections.get(identity.sessionId);
    if (!connection || connection.identity.owner !== identity.owner || !sameGeneration(connection.identity.generation, identity.generation)) {
      throw new Error('WORKSPACE_BINDING_MISMATCH');
    }
    return connection;
  }

  /** 同步请求必须持有活跃桌面绑定，不能借普通 Web 登录直接执行同步。 */
  authorizeSync(identity: BridgeIdentity): void {
    const connection = this.authenticated(identity);
    if (this.changing.has(identity.sessionId) || connection.pending) throw new Error('WORKSPACE_BUSY');
    if (Date.now() - connection.lastPoll >= this.limits.heartbeatTimeoutMs) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    connection.lastPoll = Date.now();
  }

  activeRequest(identity: BridgeIdentity): string | null { return this.authenticated(identity).pending?.id ?? null; }

  poll(identity: BridgeIdentity): { id: string; operation: unknown } | null {
    const connection = this.authenticated(identity);
    connection.lastPoll = Date.now();
    const pending = connection.pending;
    if (!pending || pending.delivered) return null;
    pending.delivered = true;
    return { id: pending.id, operation: pending.operation };
  }

  result(identity: BridgeIdentity, result: { id: string; ok: boolean; value: unknown }): void {
    const connection = this.authenticated(identity);
    const pending = connection.pending;
    if (!pending || !pending.delivered || pending.id !== result.id) throw new Error('WORKSPACE_REQUEST_MISMATCH');
    connection.pending = undefined;
    if (result.ok) pending.resolve(result.value);
    else pending.reject(new Error(typeof result.value === 'string' && /^LOCAL_[A-Z_]+$/.test(result.value) ? result.value : 'DESKTOP_FILE_OPERATION_FAILED'));
  }

  execute(input: { sessionId: string; owner: string; operation: unknown }, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const state = this.state(input.sessionId, input.owner);
    const connection = this.connections.get(input.sessionId);
    if (state?.mode !== 'desktop' || !connection || this.changing.has(input.sessionId)
      || Date.now() - connection.lastPoll >= this.limits.heartbeatTimeoutMs) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    if (connection.pending) throw new Error('WORKSPACE_BUSY');
    return new Promise((resolve, reject) => {
      const finish = (action: () => void): void => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (connection.pending?.id === id) connection.pending = undefined;
        action();
      };
      const id = randomUUID();
      const abort = (): void => finish(() => reject(new Error('WORKSPACE_REQUEST_CANCELLED')));
      const timer = setTimeout(() => finish(() => reject(new Error('WORKSPACE_REQUEST_TIMEOUT'))), this.limits.requestTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      connection.pending = { id, operation: input.operation, delivered: false,
        resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) };
      if (signal.aborted) abort();
    });
  }

  private prune(): void {
    for (const [id, connection] of this.connections) {
      if (Date.now() - connection.lastPoll >= this.limits.heartbeatTimeoutMs) this.disconnect(id);
    }
  }

  isChanging(sessionId: string): boolean { return this.changing.has(sessionId); }

  /** 单调工具守卫：断线与重启不把本机工作区降级为服务器执行。 */
  denyTool(input: { sessionId: string; owner: string; tool: string }): string | undefined {
    if (this.changing.has(input.sessionId)) return 'WORKSPACE_SWITCH_IN_PROGRESS';
    if (this.state(input.sessionId, input.owner)?.mode !== 'desktop') return undefined;
    if (input.tool === 'desktop_workspace' || input.tool === 'desktop_shell' || input.tool === 'run_code') return undefined;
    return 'LOCAL_WORKSPACE_REQUIRES_DESKTOP_FILE_TOOL';
  }

  disconnect(sessionId: string): void {
    this.connections.get(sessionId)?.pending?.reject(new Error('LOCAL_WORKSPACE_DISCONNECTED'));
    this.connections.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.connections.keys()) this.disconnect(sessionId);
  }
}
