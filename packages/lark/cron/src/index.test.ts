/** lark-cron 连接池关闭必须由 Cordis disposer 等待。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  migrate: vi.fn(async () => undefined),
}));

vi.mock("dsh-lark-postgres-runtime", () => ({ runMigrations: mocks.migrate }));
vi.mock("./store-pg.js", () => ({
  PgCronDatabase: class { close = mocks.close; },
}));
vi.mock("./store.js", () => ({ PostgresCronStore: class {} }));
vi.mock("./runner.js", () => ({ CronRunner: class {} }));

function makeCtx() {
  const self = {
    credentials: { resolve: vi.fn(async () => ({ value: "postgres://test" })) },
    effects: [] as Array<() => unknown>,
    effect: vi.fn((setup: () => () => unknown) => self.effects.push(setup())),
    on: vi.fn(() => () => undefined),
    provide: vi.fn(),
  };
  return self;
}

const config: Config = { databaseUrlEnv: "DATABASE_URL", enabled: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-lark-cron teardown", () => {
  it("将连接池关闭 Promise 交给 Cordis disposer", async () => {
    const ctx = makeCtx();
    await apply(ctx as never, config);

    const result = ctx.effects[0]!();
    expect(result).toBeInstanceOf(Promise);
    await result;

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("在解析凭证前拒绝非法轮询配置", async () => {
    const ctx = makeCtx();

    await expect(apply(ctx as never, {
      databaseUrlEnv: "DATABASE_URL",
      pollIntervalMs: 0,
      enabled: false,
    })).rejects.toThrow(/pollIntervalMs/);

    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });
});
