/**
 * M5b 干净环境演练代理（1/2）：凭证缺失时各 bin 必须 fail loud——
 * 明确的退出码与可行动的报错，绝不静默降级或挂起。
 *
 * 方式：给 worker 组合加一个覆盖层，把知识凭证引用改成不存在的 env
 * 变量（等价于干净环境缺 .env），断言 boot 以非零退出且报错可行动。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 覆盖层落在仓库内（app 的 --patch 按 cwd 相对解析）。
const OVERLAY_DIR = "var/test-overlays";

beforeAll(async () => {
  await mkdir(OVERLAY_DIR, { recursive: true });
  await writeFile(join(OVERLAY_DIR, "missing-credential.yml"), [
    "- id: knowledge-postgres",
    "  config:",
    "    siliconflowApiKeyEnv: DSH_LARK_MISSING_KEY_ROUND18",
  ].join("\n"), "utf8");
});

afterAll(async () => {
  await rm(OVERLAY_DIR, { recursive: true, force: true });
});

function runBin(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

describe("干净环境 fail loud（M5b 演练代理）", () => {
  it("worker：配置/凭证缺失 → 非零退出 + 可行动报错（不挂起不静默）", async () => {
    const result = await runBin([
      "apps/lark-worker/src/main.ts",
      "--boot-check",
      "--patch",
      join(OVERLAY_DIR, "missing-credential.yml"),
    ]);
    expect(result.code).not.toBe(0);
    // 覆盖层替换 knowledge-postgres 配置后缺 databaseUrlEnv → 装载期拒绝
    // （干净环境缺配置的 fail loud 行为：报错点名缺失字段，绝不静默降级）。
    expect(result.output).toContain("databaseUrlEnv");
  }, 120_000);

  it("admin：组合依赖或身份配置非法 → 非零退出 + 可行动报错", async () => {
    // admin bundle 的 Provider 是并行装载的；干净环境可能先报告凭证缺失，
    // identity 的确定性 fail-closed 路径由 dsh-lark-admin 单测单独锁定。
    // 测试子进程不能占用生产 admin 的 8791；host-webserver 的 port: 0
    // 由 OS 分配隔离端口，避免端口冲突掩盖本断言的 identity 配置错误。
    const adminOverlay = join(OVERLAY_DIR, "admin-bad-identity.yml");
    await writeFile(adminOverlay, [
      "- id: host-webserver",
      "  config:",
      "    host: 127.0.0.1",
      "    port: 0",
      "- id: lark-admin",
      "  config:",
      "    identity:",
      "      adminUserId: '!!!invalid!!!'",
    ].join("\n"), "utf8");
    const result = await runBin([
      "apps/admin/src/main.ts",
      "--boot-check",
      "--patch",
      adminOverlay,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/identity|凭证引用未配置/);
  }, 120_000);
});
