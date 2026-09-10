/** Node 二进制同步 Provider：规范路径、条件发布、恢复副本；不是 OS 沙箱。 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, mkdir, open, link, rename, unlink } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import type { SyncEndpoint, SyncManifest } from './sync.js';

export interface SyncLimits { maxBytes: number; maxEntries: number; maxTotalBytes: number }
const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const excluded = (name: string): boolean => ['.git', 'node_modules', '.mewclaw-sync'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** wire 文件名必须在 Windows/macOS/Linux 上均无歧义。 */
export function syncPath(path: string): string[] {
  const parts = path.split('/');
  if (!path || path.length > 2048 || parts.some(p => !p || p === '.' || p === '..' || excluded(p)
    || /[\\:\x00-\x1f<>"|?*]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('SYNC_PATH_REJECTED');
  return parts;
}
export class NodeSyncDirectory implements SyncEndpoint {
  private static readonly tails = new Map<string, Promise<unknown>>();
  private constructor(private readonly root: string, private readonly limits: SyncLimits) {}
  static async create(path: string, limits: SyncLimits): Promise<NodeSyncDirectory> {
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new Error('SYNC_NOT_DIRECTORY');
    return new NodeSyncDirectory(root, limits);
  }
  private async target(path: string, createParents = false): Promise<string> {
    const parts = syncPath(path);
    if (await realpath(this.root) !== this.root) throw new Error('SYNC_ROOT_CHANGED');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      let info;
      try { info = await lstat(current); } catch (error) { if (!missing(error)) throw error; }
      if (!info && i < parts.length - 1 && createParents) {
        try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        info = await lstat(current);
      }
      if (info && (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))) throw new Error('SYNC_PATH_REJECTED');
    }
    return current;
  }
  private async bytes(path: string, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > this.limits.maxBytes) throw new Error('SYNC_LIMIT');
      const buffer = Buffer.alloc(this.limits.maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const chunk = await handle.read(buffer, size, buffer.length - size, size);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size > this.limits.maxBytes) throw new Error('SYNC_LIMIT');
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('SYNC_CONFLICT');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
  async snapshot(signal: AbortSignal): Promise<SyncManifest> {
    const result: SyncManifest = Object.create(null) as SyncManifest;
    const names = new Set<string>(); let count = 0, total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      signal.throwIfAborted();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (excluded(entry.name)) continue;
        const path = prefix + entry.name; syncPath(path);
        const folded = path.normalize('NFC').toLowerCase();
        if (names.has(folded)) throw new Error('SYNC_CASE_COLLISION'); names.add(folded);
        if (++count > this.limits.maxEntries) throw new Error('SYNC_LIMIT');
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('SYNC_PATH_REJECTED');
        if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/');
        else {
          const data = await this.bytes(await this.target(path), signal);
          total += data.length; if (total > this.limits.maxTotalBytes) throw new Error('SYNC_LIMIT');
          result[path] = { hash: hash(data), size: data.length };
        }
      }
    };
    if (await realpath(this.root) !== this.root) throw new Error('SYNC_ROOT_CHANGED');
    await walk(this.root, ''); return result;
  }
  async read(path: string, expected: string, signal: AbortSignal): Promise<string> {
    const data = await this.bytes(await this.target(path), signal);
    if (hash(data) !== expected) throw new Error('SYNC_CONFLICT');
    return data.toString('base64');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = (NodeSyncDirectory.tails.get(this.root) ?? Promise.resolve()).then(operation, operation);
    const tail = next.catch(() => undefined); NodeSyncDirectory.tails.set(this.root, tail);
    void tail.finally(() => { if (NodeSyncDirectory.tails.get(this.root) === tail) NodeSyncDirectory.tails.delete(this.root); });
    return next;
  }
  private async recovery(): Promise<string> {
    const dir = join(this.root, '.mewclaw-sync');
    try { await mkdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== resolve(dir)) throw new Error('SYNC_PATH_REJECTED');
    const recovery = join(dir, 'recovery');
    try { await mkdir(recovery); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await lstat(recovery)).isSymbolicLink() || await realpath(recovery) !== resolve(recovery)) throw new Error('SYNC_PATH_REJECTED');
    return recovery;
  }
  private async retain(target: string, expected: string, signal: AbortSignal): Promise<string> {
    if (hash(await this.bytes(target, signal)) !== expected) throw new Error('SYNC_CONFLICT');
    const backup = join(await this.recovery(), randomUUID() + '.data');
    const metadata = await open(backup + '.json', 'wx', 0o600);
    try {
      await metadata.writeFile(JSON.stringify({ path: relative(this.root, target).split(sep).join('/'), hash: expected, createdAt: new Date().toISOString() }));
      await metadata.sync();
    } finally { await metadata.close(); }
    signal.throwIfAborted(); await rename(target, backup);
    if (hash(await this.bytes(backup, signal)) !== expected) {
      // 排他恢复：外部已经创建新目标时不能覆盖它，恢复副本始终保留。
      try { await link(backup, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      throw new Error('SYNC_CONFLICT');
    }
    return backup;
  }
  write(path: string, data: string, expected: string | null, signal: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal.throwIfAborted();
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > this.limits.maxBytes || bytes.toString('base64') !== data) throw new Error('SYNC_LIMIT');
      const target = await this.target(path, true);
      const temporary = join(await this.recovery(), randomUUID() + '.new');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try {
        signal.throwIfAborted();
        if (expected !== null) await this.retain(target, expected, signal);
        await this.target(path); signal.throwIfAborted();
        try { await link(temporary, target); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('SYNC_CONFLICT'); throw error;
        }
      } finally { await unlink(temporary); }
    });
  }
  remove(path: string, expected: string, signal: AbortSignal): Promise<void> {
    return this.serial(async () => { await this.retain(await this.target(path), expected, signal); });
  }
}
