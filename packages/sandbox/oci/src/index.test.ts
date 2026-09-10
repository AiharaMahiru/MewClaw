/** sandbox-oci 资源清理必须由 Cordis disposer 等待。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
  resolve: vi.fn(() => ({ image: "sandbox-image" })),
}));

vi.mock("./config.js", () => ({ resolveSandboxConfig: mocks.resolve }));
vi.mock("./container.js", () => ({
  OciContainerRuntime: class { dispose = mocks.dispose; },
}));
vi.mock("./runtime.js", () => ({
  OciSandbox: class {},
  OciSubprocessRuntime: class {},
}));

function makeCtx() {
  const self = {
    effects: [] as Array<() => unknown>,
    effect: vi.fn((setup: () => () => unknown) => self.effects.push(setup())),
  };
  return self;
}

const config: Config = { image: "sandbox-image", workspaceRoot: "D:/workspace" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-sandbox-oci teardown", () => {
  it("将容器清理 Promise 交给 Cordis disposer", async () => {
    const ctx = makeCtx();
    apply(ctx as never, config);

    const result = ctx.effects[0]!();
    expect(result).toBeInstanceOf(Promise);
    await result;

    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("显式配置原样交给解析器，不用 truthiness 静默丢弃", () => {
    const ctx = makeCtx();
    apply(ctx as never, {
      ...config,
      podmanPath: "",
      network: "",
      storageLimitBytes: 0,
    });

    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      podmanPath: "",
      network: "",
      storageLimitBytes: 0,
    }));
  });
});
