import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apply, inject, name, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(async () => undefined),
  constructError: undefined as Error | undefined,
  connectionStrings: [] as string[],
  migrate: vi.fn<() => Promise<void>>(async () => undefined),
  storeConstructError: undefined as Error | undefined,
}));

vi.mock("./postgres-import-store.js", () => ({
  PgAuthImportPersistence: class {
    constructor(connectionString: string) {
      if (mocks.constructError) throw mocks.constructError;
      mocks.connectionStrings.push(connectionString);
    }

    migrate = mocks.migrate;
    close = mocks.close;
  },
  PostgresAuthImportStore: class {
    constructor() {
      if (mocks.storeConstructError) throw mocks.storeConstructError;
    }

    async assertOperator(): Promise<void> {}
    async issueApproval(): Promise<void> {}
    async revokeApproval(): Promise<boolean> { return true; }
    async resolveUser(): Promise<{ kind: "missing" }> { return { kind: "missing" }; }
    async applyUserImport(): Promise<never> { throw new Error("not implemented"); }
    async claimResource(): Promise<never> { throw new Error("not implemented"); }
    async authorizeImportRun(): Promise<never> { throw new Error("not implemented"); }
    async reconcileImport(): Promise<never> { throw new Error("not implemented"); }
    async rollbackImport(): Promise<never> { throw new Error("not implemented"); }
    close = mocks.close;
  },
}));

interface TestContext {
  credentials: { resolve: ReturnType<typeof vi.fn> };
  disposers: Array<() => void | Promise<void>>;
  effect: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  provide: ReturnType<typeof vi.fn>;
}

const rollbackPath = join(process.cwd(), ".test-credential-rollbacks");
const config: Config = {
  databaseUrlEnv: "DATABASE_URL",
  credentialRollbackKeyEnv: "CREDENTIAL_ROLLBACK_KEY",
  credentialRollbackPath: rollbackPath,
  approvalTtlMs: 900_000,
};

function makeContext(credentialValue: string | null = "postgres://auth") : TestContext {
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    credentials: {
      resolve: vi.fn(async (reference: string) => {
        if (!credentialValue) return undefined;
        return reference === "CREDENTIAL_ROLLBACK_KEY"
          ? { value: Buffer.alloc(32, 7).toString("base64url") }
          : { value: credentialValue };
      }),
    },
    disposers,
    effect: vi.fn((register: () => () => void | Promise<void>) => {
      disposers.push(register());
    }),
    logger: { warn: vi.fn() },
    on: vi.fn(),
    provide: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.constructError = undefined;
  mocks.storeConstructError = undefined;
  mocks.connectionStrings.length = 0;
  rmSync(rollbackPath, { recursive: true, force: true });
});

afterEach(() => rmSync(rollbackPath, { recursive: true, force: true }));

describe("dsh-lark-auth Cordis provider", () => {
  it("declares the stable plugin identity and credentials injection", () => {
    expect(name).toBe("auth");
    expect(inject).toEqual(["credentials"]);
  });

  it("migrates before providing the narrow auth capability", async () => {
    const ctx = makeContext();

    await apply(ctx as never, config);

    expect(ctx.credentials.resolve).toHaveBeenCalledWith("DATABASE_URL");
    expect(ctx.credentials.resolve).toHaveBeenCalledWith("CREDENTIAL_ROLLBACK_KEY");
    expect(mocks.connectionStrings).toEqual(["postgres://auth"]);
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(ctx.provide).toHaveBeenCalledWith("auth", expect.objectContaining({
      dryRunUserImport: expect.any(Function),
      applyUserImport: expect.any(Function),
      issueImportApproval: expect.any(Function),
      revokeImportApproval: expect.any(Function),
    }));
  });

  it("fails loud without constructing a database when the credential is missing", async () => {
    const ctx = makeContext(null);

    await expect(apply(ctx as never, config)).rejects.toThrow("凭证引用未配置");

    expect(mocks.connectionStrings).toEqual([]);
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("rejects an invalid credential reference without echoing a secret", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";

    const error = await apply(ctx as never, { ...config, databaseUrlEnv: secret })
      .catch((reason: unknown) => reason);

    expect(error).toEqual(new Error("auth: 数据库凭证引用无效"));
    expect(String(error)).not.toContain(secret);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });

  it("sanitizes credential provider failures", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";
    ctx.credentials.resolve.mockRejectedValueOnce(new Error(`credential failed: ${secret}`));

    const error = await apply(ctx as never, config).catch((reason: unknown) => reason);

    expect(error).toEqual(new Error("auth: 数据库凭证解析失败"));
    expect(String(error)).not.toContain(secret);
    expect(mocks.connectionStrings).toEqual([]);
  });

  it("sanitizes persistence construction failures", async () => {
    const ctx = makeContext();
    const secret = "postgres://user:secret@example.invalid/database";
    mocks.constructError = new Error(`pool failed: ${secret}`);

    const error = await apply(ctx as never, config).catch((reason: unknown) => reason);

    expect(error).toEqual(new Error("auth: PostgreSQL 初始化失败"));
    expect(String(error)).not.toContain(secret);
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("closes the database and does not provide after disposal during migration", async () => {
    let finishMigration: (() => void) | undefined;
    mocks.migrate.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishMigration = resolve;
    }));
    const ctx = makeContext();
    const pending = apply(ctx as never, config);
    await vi.waitFor(() => expect(mocks.migrate).toHaveBeenCalledOnce());

    ctx.disposers[0]?.();
    finishMigration?.();
    await pending;

    expect(ctx.provide).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not construct or migrate a database after disposal during credential resolution", async () => {
    let finishResolution: ((value: { value: string }) => void) | undefined;
    const ctx = makeContext();
    ctx.credentials.resolve.mockImplementationOnce(() => new Promise((resolve) => {
      finishResolution = resolve;
    }));
    const pending = apply(ctx as never, config);
    await vi.waitFor(() => expect(ctx.credentials.resolve).toHaveBeenCalledOnce());

    ctx.disposers[0]?.();
    finishResolution?.({ value: "postgres://auth" });
    await pending;

    expect(mocks.connectionStrings).toEqual([]);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("closes the database when migration fails", async () => {
    const secret = "postgres://user:secret@example.invalid/database";
    mocks.migrate.mockRejectedValueOnce(new Error(`migration unavailable: ${secret}`));
    const ctx = makeContext();

    const error = await apply(ctx as never, config).catch((reason: unknown) => reason);

    expect(error).toEqual(new Error("auth: PostgreSQL 初始化失败"));
    expect(String(error)).not.toContain(secret);
    expect(ctx.provide).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the database when capability construction fails", async () => {
    mocks.storeConstructError = new Error("store construction failed");
    const ctx = makeContext();

    await expect(apply(ctx as never, config)).rejects.toThrow("store construction failed");

    expect(ctx.provide).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the database when capability registration fails", async () => {
    const ctx = makeContext();
    ctx.provide.mockImplementationOnce(() => { throw new Error("provide failed"); });

    await expect(apply(ctx as never, config)).rejects.toThrow("provide failed");

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the database when a later Cordis registration fails", async () => {
    const ctx = makeContext();
    ctx.on.mockImplementationOnce(() => { throw new Error("listener failed"); });

    await expect(apply(ctx as never, config)).rejects.toThrow("listener failed");

    expect(ctx.provide).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
