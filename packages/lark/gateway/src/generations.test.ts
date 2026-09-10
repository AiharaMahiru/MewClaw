/** 持久化会话代次属于跨重启输入，必须和 Worker wire 契约一致。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionGenerations } from "./generations.js";

const stateDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-lark-generations-"));
  stateDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionGenerations", () => {
  it("仅恢复 Worker 支持的安全会话代次", async () => {
    const stateDir = await createStateDir();
    await writeFile(join(stateDir, "session-generations.json"), JSON.stringify({
      valid: 12,
      upperBound: 1_000_000,
      tooLarge: 1_000_001,
      unsafe: Number.MAX_SAFE_INTEGER,
      fractional: 1.5,
      negative: -1,
    }));
    const generations = new SessionGenerations(stateDir);

    await generations.load();

    expect(generations.get("valid")).toBe(12);
    expect(generations.get("upperBound")).toBe(1_000_000);
    expect(generations.get("tooLarge")).toBe(0);
    expect(generations.get("unsafe")).toBe(0);
    expect(generations.get("fractional")).toBe(0);
    expect(generations.get("negative")).toBe(0);
  });
});
