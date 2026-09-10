/** dsh-lark 启动期凭证解析与服务提供回归测试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  createLarkApi: vi.fn(() => ({ name: "lark-api" })),
}));

vi.mock("./api.js", () => ({ createLarkApi: mocks.createLarkApi }));

function makeCtx(credentialValue = "credential-value") {
  const self = {
    credentials: { resolve: vi.fn(async (): Promise<{ value: string } | undefined> => ({ value: credentialValue })) },
    provide: vi.fn(),
    logger: { warn: vi.fn() },
    effect: vi.fn((register: () => () => void) => register()),
    on: vi.fn(() => () => undefined),
  };
  return self;
}

const config: Config = {
  appIdEnv: "LARK_APP_ID",
  appSecretEnv: "LARK_APP_SECRET",
  baseURL: "feishu.cn",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-lark 启动生命周期", () => {
  it("等待凭证解析后提供 API 服务", async () => {
    const ctx = makeCtx();

    await apply(ctx as never, config);

    expect(ctx.credentials.resolve).toHaveBeenCalledWith("LARK_APP_ID");
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("LARK_APP_SECRET");
    expect(ctx.provide).toHaveBeenCalledWith("lark", { name: "lark-api" });
  });

  it("缺失凭证会拒绝插件启动且不提供服务", async () => {
    const ctx = makeCtx();
    ctx.credentials.resolve.mockResolvedValue(undefined);

    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("非法资源上限在凭证解析前 fail loud", async () => {
    const ctx = makeCtx();

    await expect(apply(ctx as never, { ...config, maxResourceBytes: 0 })).rejects.toThrow("maxResourceBytes");
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
    expect(ctx.provide).not.toHaveBeenCalled();
  });
});
