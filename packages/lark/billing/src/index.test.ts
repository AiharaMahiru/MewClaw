import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type BillingConfig } from "./index.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  migrate: vi.fn(async () => undefined),
  provide: vi.fn(),
}));

vi.mock("dsh-lark-postgres-runtime", () => ({ runMigrations: mocks.migrate }));
vi.mock("./database.js", () => ({
  PgBillingDatabase: class {
    close = mocks.close;
  },
}));
vi.mock("./postgres-store.js", () => ({ PostgresBillingStore: class {} }));
vi.mock("./service.js", () => ({
  DefaultBillingService: class {
    constructor(...args: unknown[]) { void args; }
  },
}));

function makeContext() {
  const effects: Array<() => unknown> = [];
  return {
    credentials: { resolve: vi.fn(async (): Promise<{ value: string } | undefined> => ({ value: "postgres://billing-test" })) },
    provide: mocks.provide,
    effect: (setup: () => () => unknown) => effects.push(setup()),
    effects,
  };
}

const config: BillingConfig = { databaseUrlEnv: "DATABASE_URL" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-lark-billing Provider", () => {
  it("凭证解析、迁移和 ctx.billing 提供按顺序完成", async () => {
    const ctx = makeContext();
    await apply(ctx as never, config);
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("DATABASE_URL");
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.provide).toHaveBeenCalledWith("billing", expect.anything());
    for (const dispose of ctx.effects) await dispose();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("缺少凭证时 fail loud，且不提供服务", async () => {
    const ctx = makeContext();
    ctx.credentials.resolve.mockResolvedValue(undefined);
    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");
    expect(mocks.provide).not.toHaveBeenCalled();
  });
});
