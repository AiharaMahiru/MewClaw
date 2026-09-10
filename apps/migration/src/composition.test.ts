import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("migration composition", () => {
  it("只装载一次性 credentials/Auth/Provider/Consumer 能力缝", async () => {
    const config = await readFile(join(appRoot, "cordis.yml"), "utf8");

    expect(config).toContain("@deepseek-ai/dsh-credentials-local");
    expect(config).toContain("dsh-lark-auth");
    expect(config).toContain("dsh-dooragent-migration");
    expect(config).toContain("dsh-dooragent-migration-app/consumer");
    expect(config).not.toMatch(/gateway|webserver|dsh-base|tool-/i);
  });

  it("启动代码不加载 layered .env", async () => {
    const files = await Promise.all([
      readFile(join(appRoot, "src", "main.ts"), "utf8"),
      readFile(join(appRoot, "src", "runtime.ts"), "utf8"),
    ]);

    expect(files.join("\n")).not.toContain("loadLayeredEnv");
  });
});
