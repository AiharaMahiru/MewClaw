/**
 * dsh-lark-run 插件接线测试：HTTP server 生命周期与 teardown 竞态
 * （dispose 早于 listen 完成时迟到 server 立即关闭，不留孤儿）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

// mock server-bootstrap：捕获 close 面与启动时机。
const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  start: vi.fn(async () => ({ close: mocks.close })),
}));

vi.mock("./server-bootstrap.js", () => ({
  startRunServer: mocks.start,
}));

/** 最小假 ctx：只实现 apply 路径用到的面。 */
function makeCtx() {
  const self = {
    disposers: [] as Array<() => void>,
    sessionPersistence: {
      list: vi.fn(async () => []),
    },
    workspaceRegistry: {
      create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })),
    },
    larkPresets: {
      resolve: () => ({ name: "standard", version: "1", revision: "r1", tools: { deny: [] }, skills: [] }),
      trustedSkillNames: () => [],
    },
    tools: { get: () => undefined },
    provide: vi.fn(),
    on: vi.fn(() => () => undefined),
    effect: vi.fn((register: () => () => void) => {
      self.disposers.push(register());
    }),
  };
  return self;
}

const config: Config = { presetId: "lark-standard" };

let ctx: ReturnType<typeof makeCtx>;

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeCtx();
});

describe("HTTP server 生命周期", () => {
  it("正常路径：dispose 后调用 close", async () => {
    apply(ctx as never, config);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
    for (const dispose of ctx.disposers.splice(0)) dispose();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalled());
  });

  it("dispose 早于 listen 完成：迟到的 server 立即关闭（teardown 竞态）", async () => {
    let release!: () => void;
    const serverReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.start.mockImplementationOnce(async () => {
      await serverReady;
      return { close: mocks.close };
    });
    void apply(ctx as never, config);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
    // startRunServer 已开始但仍未返回 server，closeServer 仍为 undefined。
    for (const dispose of ctx.disposers.splice(0)) dispose();
    release();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalled());
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("端口绑定失败使插件启动失败", async () => {
    mocks.start.mockRejectedValueOnce(new Error("listen failed"));

    await expect(apply(ctx as never, config)).rejects.toThrow("listen failed");
  });
});
