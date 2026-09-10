/** dsh-lark-run-client 启动期凭证解析与服务提供回归测试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  createRunClient: vi.fn(() => ({ name: "run-client" })),
}));

vi.mock("./client.js", () => ({ createRunClient: mocks.createRunClient }));

function makeCtx() {
  const self = {
    credentials: { resolve: vi.fn(async (): Promise<{ value: string } | undefined> => ({ value: "worker-token" })) },
    effect: vi.fn((register: () => () => void) => register()),
    emit: vi.fn(),
    logger: { warn: vi.fn() },
    provide: vi.fn(),
  };
  return self;
}

const config: Config = {
  baseURL: "http://127.0.0.1:3210",
  tokenEnv: "WORKER_TOKEN",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-lark-run-client 启动生命周期", () => {
  it("等待凭证解析后提供桥接客户端", async () => {
    const ctx = makeCtx();

    await apply(ctx as never, config);

    expect(ctx.credentials.resolve).toHaveBeenCalledWith("WORKER_TOKEN");
    expect(ctx.provide).toHaveBeenCalledWith("larkRunClient", { name: "run-client" });
  });

  it("缺失 worker 凭证会拒绝插件启动且不提供服务", async () => {
    const ctx = makeCtx();
    ctx.credentials.resolve.mockResolvedValue(undefined);

    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("非法事件上限在凭证解析前 fail loud", async () => {
    const ctx = makeCtx();
    await expect(apply(ctx as never, { ...config, maxEventBytes: 0 })).rejects.toThrow(/maxEventBytes/);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
    expect(ctx.provide).not.toHaveBeenCalled();
  });
});
