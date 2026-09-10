/**
 * M0 冒烟测试：空组合经 dsh boot() 装载后必须能干净关停。
 *
 * 覆盖 M0 验收点「空组合启动/关闭干净」的自动化形态；
 * 带 dsh-base bundle 层的组合冒烟走 `pnpm smoke:base`（真实进程，含 HMR 行）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("空组合冒烟", () => {
  it("boot 后干净 dispose", async () => {
    const ctx = await boot("smoke-test", join(here, "smoke", "empty.cordis.yml"));
    expect(ctx).toBeDefined();
    await ctx.fiber.dispose();
  });
});
