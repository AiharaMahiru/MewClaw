/**
 * dsh-lark-ws 插件接线测试（SPEC lark-ws.md §8）：
 * mock createLarkWs，覆盖凭证解析、事件接线、健康状态与关停。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

// mock client 模块：捕获构造参数与生命周期回调。
const mocks = vi.hoisted(() => ({
  built: undefined as {
    options: {
      handlers: {
        onMessage: (...args: never[]) => void;
        onRecalled: (...args: never[]) => void;
        onCardAction: (...args: never[]) => void;
        onBotMenu: (...args: never[]) => void;
        onParseFailure: (...args: never[]) => void;
      };
      lifecycle: {
        onReady: () => void;
        onReconnected: () => void;
        onReconnecting: () => void;
        onError: () => void;
      };
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } | undefined,
}));

vi.mock("./client.js", () => ({
  createLarkWs: (options: never) => {
    mocks.built = {
      options,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    return mocks.built;
  },
}));

/** 最小假 ctx：只实现插件用到的面（用 self 引用避免 this 丢失）。 */
function makeCtx() {
  const self = {
    emits: [] as Array<{ event: string; payload: unknown }>,
    credentials: {
      resolve: vi.fn(async (reference: string): Promise<{ value: string } | undefined> => ({ value: `${reference}:value` })),
    },
    logger: { warn: vi.fn() },
    emit(event: string, payload: unknown) {
      self.emits.push({ event, payload });
    },
    on: vi.fn(() => () => undefined),
    disposers: [] as Array<() => void>,
    effect: vi.fn((register: () => () => void) => {
      self.disposers.push(register());
    }),
  };
  return self;
}

const config: Config = {
  appIdEnv: "LARK_APP_ID",
  appSecretEnv: "LARK_APP_SECRET",
  baseURL: "feishu.cn",
  failureWindowMs: 60_000,
  healthPublishIntervalMs: 30_000,
};

let ctx: ReturnType<typeof makeCtx>;

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeCtx();
});

afterEach(() => {
  for (const dispose of ctx.disposers) dispose();
  mocks.built = undefined;
});

const booted = async () => {
  await apply(ctx as never, config);
  await vi.waitFor(() => expect(mocks.built).toBeDefined());
  return mocks.built!;
};

describe("启动接线", () => {
  it("解析两个凭证引用，把值交给 createLarkWs", async () => {
    await booted();
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("LARK_APP_ID");
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("LARK_APP_SECRET");
  });

  it("凭证缺失使插件启动失败", async () => {
    ctx.credentials.resolve.mockResolvedValue(undefined);

    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");
  });

  it("非法连接窗口在凭证解析前 fail loud", async () => {
    await expect(apply(ctx as never, { ...config, failureWindowMs: 0 })).rejects.toThrow(/failureWindowMs/);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });

  it("入站回调接到 lark 事件", async () => {
    const built = await booted();
    built.options.handlers.onMessage({ eventId: "e", messageId: "om_1", userId: "ou_1", chatId: "oc_1", delivery: "prompt", text: "hi", resources: [] } as never);
    expect(ctx.emits).toContainEqual({ event: "lark/message/received", payload: expect.objectContaining({ messageId: "om_1" }) });
  });

  it("畸形帧计数并告警", async () => {
    const built = await booted();
    built.options.handlers.onParseFailure();
    built.options.handlers.onParseFailure();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("累计 2"));
  });
});

describe("连接状态", () => {
  it("lifecycle 回调 → lark/connection 事件", async () => {
    const built = await booted();
    built.options.lifecycle.onReady();
    built.options.lifecycle.onReconnected();
    built.options.lifecycle.onReconnecting();
    const states = ctx.emits.filter((entry) => entry.event === "lark/connection").map((entry) => (entry.payload as { state: string }).state);
    expect(states).toEqual(["connected", "connected", "reconnecting"]);
  });

  it("持续重连超窗 → failed；恢复 connected 清除窗口", async () => {
    vi.useFakeTimers();
    try {
      const built = await booted();
      built.options.lifecycle.onReconnecting();
      vi.advanceTimersByTime(61_000);
      let last = ctx.emits.filter((entry) => entry.event === "lark/connection").at(-1);
      expect((last!.payload as { state: string }).state).toBe("failed");

      built.options.lifecycle.onReconnecting();
      built.options.lifecycle.onReady();
      vi.advanceTimersByTime(61_000);
      last = ctx.emits.filter((entry) => entry.event === "lark/connection").at(-1);
      expect((last!.payload as { state: string }).state).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("健康心跳周期性发布最近状态", async () => {
    vi.useFakeTimers();
    try {
      const built = await booted();
      built.options.lifecycle.onReady();
      const before = ctx.emits.filter((entry) => entry.event === "lark/connection").length;
      vi.advanceTimersByTime(31_000);
      const after = ctx.emits.filter((entry) => entry.event === "lark/connection").length;
      expect(after).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("关停", () => {
  it("effect 注册的 disposer 调用 ws.stop 并清定时器", async () => {
    const built = await booted();
    expect(ctx.disposers).toHaveLength(1);
    ctx.disposers[0]!();
    expect(built.stop).toHaveBeenCalled();
  });

  it("停止后忽略迟到的 SDK 生命周期回调", async () => {
    vi.useFakeTimers();
    try {
      const built = await booted();
      for (const dispose of ctx.disposers.splice(0)) dispose();
      const emittedBefore = ctx.emits.length;

      built.options.lifecycle.onReconnecting();
      vi.advanceTimersByTime(61_000);

      expect(ctx.emits).toHaveLength(emittedBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("teardown 竞态", () => {
  it("dispose 发生在凭证解析期间：迟到的连接启动后立即停掉", async () => {
    let release!: (value: { value: string }) => void;
    const gate = new Promise<{ value: string }>((resolveGate) => { release = resolveGate; });
    ctx.credentials.resolve = vi.fn(async () => gate);
    void apply(ctx as never, config);
    // 凭证未解析完成即销毁：此时 ws 尚未创建，disposer 只能置 active=false。
    for (const dispose of ctx.disposers.splice(0)) dispose();
    release({ value: "late" });
    await vi.waitFor(() => expect(mocks.built).toBeDefined());
    await vi.waitFor(() => expect(mocks.built?.stop).toHaveBeenCalled());
    expect(mocks.built?.start).toHaveBeenCalledTimes(1);
  });
});
