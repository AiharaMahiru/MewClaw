/** 双向同步能力定义与三方比较 Consumer；不重放写入，不替用户选择冲突胜者。 */
export interface SyncEntry { hash: string; size: number }
export type SyncManifest = Record<string, SyncEntry>;
export interface SyncEndpoint {
  snapshot(signal: AbortSignal): Promise<SyncManifest>;
  read(path: string, hash: string, signal: AbortSignal): Promise<string>;
  write(path: string, data: string, expected: string | null, signal: AbortSignal): Promise<void>;
  remove(path: string, expected: string, signal: AbortSignal): Promise<void>;
}
export interface SyncReport { transferred: number; removed: number; conflicts: string[] }

/** 基线只记录两端已一致的版本，断线后保留文件而不恢复旧删除计划。 */
export class SyncEngine {
  private baseline = new Map<string, string>();
  private running = false;
  constructor(private readonly local: SyncEndpoint, private readonly remote: SyncEndpoint) {}
  async run(signal: AbortSignal): Promise<SyncReport> {
    if (this.running) throw new Error('SYNC_BUSY');
    this.running = true;
    try {
      const left = await this.local.snapshot(signal), right = await this.remote.snapshot(signal);
      const report: SyncReport = { transferred: 0, removed: 0, conflicts: [] };
      const paths = [...new Set([...Object.keys(left), ...Object.keys(right), ...this.baseline.keys()])].sort();
      const folded = new Set<string>();
      for (const path of paths) {
        const key = path.normalize('NFC').toLowerCase();
        if (folded.has(key)) throw new Error('SYNC_CASE_COLLISION'); folded.add(key);
      }
      for (const path of paths) {
        signal.throwIfAborted();
        const a = left[path]?.hash, b = right[path]?.hash, base = this.baseline.get(path);
        if (a === b) { if (a) this.baseline.set(path, a); else this.baseline.delete(path); continue; }
        if ((!base && a && b) || (base && a !== base && b !== base)) { report.conflicts.push(path); continue; }
        const fromLeft = base ? b === base : !!a;
        const source = fromLeft ? this.local : this.remote, target = fromLeft ? this.remote : this.local;
        const sourceHash = fromLeft ? a : b, targetHash = fromLeft ? b : a;
        try {
          if (sourceHash) {
            const data = await source.read(path, sourceHash, signal);
            await target.write(path, data, targetHash ?? null, signal);
            this.baseline.set(path, sourceHash); report.transferred++;
          } else if (targetHash) {
            await target.remove(path, targetHash, signal);
            this.baseline.delete(path); report.removed++;
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'SYNC_CONFLICT') report.conflicts.push(path);
          else throw error;
        }
      }
      return report;
    } finally { this.running = false; }
  }
}
