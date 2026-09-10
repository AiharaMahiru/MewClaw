import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  databaseConstruct: vi.fn(),
  migrate: vi.fn(async (): Promise<void> => undefined),
  provide: vi.fn(),
  resolver: { resolveForUsage: vi.fn(), members: vi.fn() },
}));

vi.mock("dsh-lark-postgres-runtime", () => ({ runMigrations: mocks.migrate }));
vi.mock("./database.js", () => ({
  PgCanonicalUserDatabase: class {
    close = mocks.close;
    constructor() { mocks.databaseConstruct(); }
  },
}));
vi.mock("./postgres-store.js", () => ({
  PostgresCanonicalUserResolver: class { resolveForUsage = mocks.resolver.resolveForUsage; members = mocks.resolver.members; },
}));

function makeContext() {
  const effects: Array<() => unknown> = [];
  return {
    credentials: { resolve: vi.fn(async (): Promise<{ value: string } | undefined> => ({ value: "postgres://canonical-test" })) },
    provide: mocks.provide,
    effect: (setup: () => () => unknown) => effects.push(setup()),
    on: vi.fn(() => () => undefined),
    logger: { warn: vi.fn() },
    effects,
  };
}

const config: Config = { databaseUrlEnv: "DATABASE_URL" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-canonical-user Provider", () => {
  it("凭证、迁移、provide 与 close 遵循 Cordis 生命周期", async () => {
    const ctx = makeContext();
    await apply(ctx as never, config);
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("DATABASE_URL");
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.provide).toHaveBeenCalledWith("canonicalUsers", expect.objectContaining({
      resolveForUsage: expect.any(Function), members: expect.any(Function),
    }));
    const provided = mocks.provide.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(provided.bind).toBeUndefined();
    expect(provided.unbind).toBeUndefined();
    for (const dispose of ctx.effects) await dispose();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("缺少凭证时 fail loud 且不 provide", async () => {
    const ctx = makeContext();
    ctx.credentials.resolve.mockResolvedValue(undefined);
    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");
    expect(mocks.provide).not.toHaveBeenCalled();
  });

  it("凭证引用非法时错误不回显配置值", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";
    await expect(apply(ctx as never, { databaseUrlEnv: secret })).rejects.toThrow("数据库凭证引用无效");
    await expect(apply(ctx as never, { databaseUrlEnv: secret })).rejects.not.toThrow(secret);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });

  it("凭证解析失败时不回显底层错误", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";
    ctx.credentials.resolve.mockRejectedValueOnce(new Error(`credential failed: ${secret}`));
    const error = await apply(ctx as never, config).catch((reason: unknown) => reason);
    expect(error).toEqual(new Error("canonical-user: 数据库凭证解析失败"));
    expect(String(error)).not.toContain(secret);
  });

  it("迁移失败时关闭连接并移除 PostgreSQL detail", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";
    ctx.credentials.resolve.mockResolvedValueOnce({ value: secret });
    mocks.migrate.mockRejectedValueOnce(Object.assign(new Error(`connect failed: ${secret}`), { detail: secret }));
    const error = await apply(ctx as never, config).catch((reason: unknown) => reason);
    expect(error).toEqual(new Error("canonical-user: PostgreSQL 初始化失败"));
    expect(String(error)).not.toContain(secret);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

describe("dsh-canonical-user Provider disposal", () => {
  it("凭证解析期间 dispose 不建库、不迁移、不 provide", async () => {
    let release!: () => void;
    const ctx = makeContext();
    ctx.credentials.resolve.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ value: "postgres://canonical-test" });
    }));
    const pending = apply(ctx as never, config);
    await vi.waitFor(() => expect(ctx.effects).toHaveLength(1));
    await ctx.effects[0]!();
    release();
    await pending;
    expect(mocks.databaseConstruct).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.provide).not.toHaveBeenCalled();
  });

  it("初始化期间 dispose 会关闭连接且不 provide", async () => {
    let release!: () => void;
    mocks.migrate.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const ctx = makeContext();
    const pending = apply(ctx as never, config);
    await vi.waitFor(() => expect(ctx.effects).toHaveLength(2));
    await ctx.effects[0]!();
    await ctx.effects[1]!();
    expect(mocks.close).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(mocks.provide).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
