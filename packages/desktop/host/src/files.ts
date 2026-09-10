/** 本地文件 Consumer：复用 DSH FileSystem 的目标身份、文本校验和条件写入。 */
import { FsVersion, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs';

export type FileOperation = { action: 'list' | 'read'; path: string } | { action: 'write'; path: string; content: string; version?: string };
export interface FileLimits { maxBytes: number; maxEntries: number }

/** 跨设备 JSON 边界校验，不接受隐式绝对路径或额外执行字段。 */
export function parseFileOperation(input: unknown): FileOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_FILE_OPERATION');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['action', 'path', 'content', 'version'].includes(key))) throw new Error('INVALID_FILE_OPERATION');
  if (!['list', 'read', 'write'].includes(String(value.action)) || typeof value.path !== 'string' || !value.path || value.path.length > 2048) throw new Error('INVALID_FILE_OPERATION');
  if (/^[\\/]|[:\x00]/.test(value.path) || value.path.split(/[\\/]/).includes('..')) throw new Error('LOCAL_PATH_NOT_ALLOWED');
  if (value.action === 'write' && typeof value.content !== 'string') throw new Error('INVALID_FILE_OPERATION');
  if (value.content !== undefined && (typeof value.content !== 'string' || value.action !== 'write')) throw new Error('INVALID_FILE_OPERATION');
  if (value.version !== undefined && (typeof value.version !== 'string' || !value.version || value.action !== 'write')) throw new Error('INVALID_FILE_OPERATION');
  return value as unknown as FileOperation;
}

export class LocalWorkspaceFiles {
  private readonly lifetime = new AbortController();
  private constructor(private readonly fs: FileSystem, private readonly root: FsTarget, private readonly limits: FileLimits) {}

  /** 授权时固定规范目标，后续不把替换后的原目录重新认作授权根。 */
  static async create(fs: FileSystem, path: string, limits: FileLimits): Promise<LocalWorkspaceFiles> {
    const root = await fs.resolve(path);
    if ((await fs.stat(root))?.type !== 'directory') throw new Error('LOCAL_NOT_DIRECTORY');
    return new LocalWorkspaceFiles(fs, root, limits);
  }

  /** 当前授权撤销后，尚未开始的操作拒绝；运行请求另由所属连接 AbortSignal 取消。 */
  dispose(): void { this.lifetime.abort(new Error('LOCAL_WORKSPACE_REVOKED')); }

  async execute(input: unknown, callerSignal: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    const operation = parseFileOperation(input);
    const target = await this.fs.resolve(operation.path, { cwd: this.fs.processPath(this.root), signal });
    if (!this.fs.contains(this.root, target)) throw new Error('LOCAL_PATH_NOT_ALLOWED');
    const before = await this.fs.stat(target, signal);
    signal.throwIfAborted();
    switch (operation.action) {
      case 'list': {
        if (before?.type !== 'directory') throw new Error('LOCAL_NOT_DIRECTORY');
        const entries = await this.fs.listDir(target, signal);
        if (entries.length > this.limits.maxEntries) throw new Error('LOCAL_TOO_MANY_ENTRIES');
        return { location: 'desktop', path: operation.path, entries: entries
          .filter(entry => this.fs.contains(this.root, entry.target))
          .map(entry => ({ name: entry.name, type: entry.type, size: entry.size })) };
      }
      case 'read': {
        if (before?.type !== 'file') throw new Error('LOCAL_NOT_FILE');
        if (before.size === undefined || before.size > this.limits.maxBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
        const content = await this.fs.readText(target, signal);
        if (Buffer.byteLength(content) > this.limits.maxBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
        const after = await this.fs.stat(target, signal);
        if (after?.version !== before.version) throw new Error('LOCAL_FILE_CHANGED');
        return { location: 'desktop', path: operation.path, content, version: before.version };
      }
      case 'write': {
        if (Buffer.byteLength(operation.content) > this.limits.maxBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
        if (before && (before.type !== 'file' || before.size === undefined || before.size > this.limits.maxBytes)) throw new Error('LOCAL_FILE_TOO_LARGE');
        const result = await this.fs.writeText(target, operation.content, operation.version
          ? { kind: 'replaceIfVersion', version: FsVersion(operation.version) }
          : { kind: 'createIfAbsent' }, signal);
        return { location: 'desktop', path: operation.path, operation: result.operation, version: result.version };
      }
    }
  }
}
