/** 本机授权的生命周期；路径只来自原生目录选择，不接受浏览器提交的路径。 */
import { randomUUID } from 'node:crypto';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { LocalWorkspaceFiles, LocalWorkspaceShell, NodeSyncDirectory, type FileLimits, type ShellLimits, type SyncLimits } from 'dsh-lark-desktop-host';

export interface WorkspaceBinding {
  sessionId: string;
  accountId: string;
  generation: string;
}
export class LocalWorkspaceBinding {
  private files: LocalWorkspaceFiles | undefined;
  private binding: WorkspaceBinding | undefined;
  private selection = 0;
  private root: string | undefined;
  private shell: LocalWorkspaceShell | undefined;
  constructor(private readonly fs: FileSystem, private readonly limits: FileLimits) {}

  async authorize(identity: { accountId: string; sessionId: string }, pick: () => Promise<string | null>): Promise<WorkspaceBinding | null> {
    const selection = ++this.selection;
    const path = await pick();
    if (selection !== this.selection) throw new Error('LOCAL_AUTHORIZATION_CANCELLED');
    if (path === null) return null;
    const files = await LocalWorkspaceFiles.create(this.fs, path, this.limits);
    if (selection !== this.selection) { files.dispose(); throw new Error('LOCAL_AUTHORIZATION_CANCELLED'); }
    this.files?.dispose();
    this.shell?.revoke(); this.shell = undefined;
    this.files = files;
    this.root = path;
    this.binding = { ...identity, generation: randomUUID() };
    return { ...this.binding };
  }

  async execute(request: WorkspaceBinding & { operation: unknown }, signal: AbortSignal): Promise<unknown> {
    const binding = this.binding;
    if (!binding || !this.files) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    if (request.accountId !== binding.accountId || request.sessionId !== binding.sessionId || request.generation !== binding.generation) {
      throw new Error('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
    }
    if ((request.operation as { action?: unknown } | null)?.action === 'shell') {
      if (!this.shell) throw new Error('LOCAL_SHELL_NOT_AUTHORIZED');
      return this.shell.execute(request.operation, signal);
    }
    return this.files.execute(request.operation, signal);
  }

  /** 仅在原生用户确认后由 Controller 调用，wire 操作不包含授权动作。 */
  grantShell(executor: ShellExecutor, limits: ShellLimits): void {
    if (!this.root || !this.binding) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    this.shell?.revoke(); this.shell = new LocalWorkspaceShell(this.fs, executor, this.root, limits);
  }
  revokeShell(): void { this.shell?.revoke(); this.shell = undefined; }
  get shellEnabled(): boolean { return !!this.shell; }
  async syncDirectory(limits: SyncLimits): Promise<NodeSyncDirectory> {
    if (!this.root || !this.binding) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    return NodeSyncDirectory.create(this.root, limits);
  }

  revoke(): void {
    ++this.selection;
    this.files?.dispose();
    this.revokeShell(); this.root = undefined;
    this.files = undefined;
    this.binding = undefined;
  }
}
