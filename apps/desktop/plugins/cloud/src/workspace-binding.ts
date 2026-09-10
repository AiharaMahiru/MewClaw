/** 本机授权的生命周期；路径只来自原生目录选择，不接受浏览器提交的路径。 */
import { randomUUID } from 'node:crypto';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { LocalWorkspaceFiles, type FileLimits } from './files.js';

export interface WorkspaceBinding {
  sessionId: string;
  accountId: string;
  generation: string;
}
export class LocalWorkspaceBinding {
  private files: LocalWorkspaceFiles | undefined;
  private binding: WorkspaceBinding | undefined;
  private selection = 0;
  constructor(private readonly fs: FileSystem, private readonly limits: FileLimits) {}

  async authorize(identity: { accountId: string; sessionId: string }, pick: () => Promise<string | null>): Promise<WorkspaceBinding | null> {
    const selection = ++this.selection;
    const path = await pick();
    if (selection !== this.selection) throw new Error('LOCAL_AUTHORIZATION_CANCELLED');
    if (path === null) return null;
    const files = await LocalWorkspaceFiles.create(this.fs, path, this.limits);
    if (selection !== this.selection) { files.dispose(); throw new Error('LOCAL_AUTHORIZATION_CANCELLED'); }
    this.files?.dispose();
    this.files = files;
    this.binding = { ...identity, generation: randomUUID() };
    return { ...this.binding };
  }

  async execute(request: WorkspaceBinding & { operation: unknown }, signal: AbortSignal): Promise<unknown> {
    const binding = this.binding;
    if (!binding || !this.files) throw new Error('LOCAL_WORKSPACE_DISCONNECTED');
    if (request.accountId !== binding.accountId || request.sessionId !== binding.sessionId || request.generation !== binding.generation) {
      throw new Error('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
    }
    return this.files.execute(request.operation, signal);
  }

  revoke(): void {
    ++this.selection;
    this.files?.dispose();
    this.files = undefined;
    this.binding = undefined;
  }
}
