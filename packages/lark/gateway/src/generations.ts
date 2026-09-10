/**
 * 会话代次存储（SPEC lark-gateway.md §10-2 的 M1 解答：/clear = 新代次映射，
 * 旧会话保留）。
 *
 * 持久化到 JSON 文件（原子写：临时文件 + rename）；scopeKey → 代次。
 * 网关重启后代次不丢，worker 恢复同一会话（满足"重启恢复会话"验收）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MAX_SESSION_GENERATION } from "dsh-lark-contracts";

function isSessionGeneration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_SESSION_GENERATION;
}

export class SessionGenerations {
  private readonly path: string;
  private generations = new Map<string, number>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "session-generations.json");
  }

  /** 装载（文件缺失 = 空表）。 */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const record = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (isSessionGeneration(value)) {
          this.generations.set(key, value);
        }
      }
    } catch {
      // 缺失/损坏 = 空表（代次从 0 起；损坏不阻塞启动）。
    }
  }

  /** 读取代次（缺省 0）。 */
  get(scopeKey: string): number {
    return this.generations.get(scopeKey) ?? 0;
  }

  /** 递增并持久化。 */
  async bump(scopeKey: string): Promise<number> {
    const next = this.get(scopeKey) + 1;
    this.generations.set(scopeKey, next);
    await this.persist();
    return next;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = JSON.stringify(Object.fromEntries(this.generations), null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.path);
  }
}
