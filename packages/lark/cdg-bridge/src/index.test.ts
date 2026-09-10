/**
 * dsh-cdg-bridge 测试（SPEC cdg-bridge.md §8）：
 * 未配置 fail closed、绝对路径校验、inspect JSON 解析失败拒绝、decrypt 参数。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply, type CdgBridge } from "./index.js";

// execFile 与 process 无关：mock node:child_process 的 execFile。
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const COMMAND = process.execPath;

type ExecCallback = (error: Error | null, stdout: string) => void;

function mockExecFile(run: (callback: ExecCallback) => void): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    run(args.at(-1) as ExecCallback);
  });
}

function makeBridge(config: Parameters<typeof apply>[1]): { bridge: CdgBridge; ctx: { logger: { warn: ReturnType<typeof vi.fn> }; provide: ReturnType<typeof vi.fn> } } {
  let provided: CdgBridge | undefined;
  const ctx = {
    logger: { warn: vi.fn() },
    provide: vi.fn((_name: string, value: CdgBridge) => { provided = value; }),
  };
  apply(ctx as never, config);
  return { bridge: provided!, ctx };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("dsh-cdg-bridge", () => {
  it("未配置：inspect 与 decrypt 都 fail closed", async () => {
    const { bridge } = makeBridge({});
    await expect(bridge.inspect("any")).rejects.toThrow(/未配置/);
    await expect(bridge.decrypt("src", "dst")).rejects.toThrow(/未配置/);
  });

  it("相对路径命令装载失败（防搜索路径注入）", () => {
    expect(() => apply({ logger: { warn: vi.fn() }, provide: vi.fn() } as never, { command: "cdgbridge.exe" }))
      .toThrow(/绝对路径/);
  });

  it("非法子进程超时在服务注册前 fail loud", () => {
    expect(() => makeBridge({ timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("inspect：JSON 解析 + 加密判定", async () => {
    mockExecFile((callback) => callback(null, JSON.stringify({ isEncrypted: true })));
    const { bridge } = makeBridge({ command: COMMAND });
    expect(await bridge.inspect("file.dat")).toBe(true);
    expect(execFileMock.mock.calls[0]![1]).toEqual(["inspect", "file.dat"]);
  });

  it("inspect 输出不可解析：fail closed + 告警", async () => {
    mockExecFile((callback) => callback(null, "not-json"));
    const { bridge, ctx } = makeBridge({ command: COMMAND });
    await expect(bridge.inspect("file.dat")).rejects.toThrow(/无法解析/);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("inspect 调用失败：fail closed", async () => {
    mockExecFile((callback) => callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), ""));
    const { bridge } = makeBridge({ command: COMMAND });
    await expect(bridge.inspect("file.dat")).rejects.toThrow(/调用失败/);
  });

  it("decrypt：read 子命令 + 参数数组化；调用失败脱敏报错", async () => {
    mockExecFile((callback) => callback(null, ""));
    const { bridge } = makeBridge({ command: COMMAND });
    await bridge.decrypt("src.dat", "dst.dat");
    expect(execFileMock.mock.calls[0]![1]).toEqual(["read", "src.dat", "--out", "dst.dat", "--strict-output"]);

    mockExecFile((callback) => callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), ""));
    await expect(bridge.decrypt("src.dat", "dst.dat")).rejects.toThrow(/调用失败/);
  });

  it("不存在的绝对路径在服务注册前 fail loud", () => {
    expect(() => makeBridge({ command: `${COMMAND}.missing` })).toThrow(/不存在/);
  });
});
