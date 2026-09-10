/** knowledge-postgres 连接池关闭必须由 Cordis disposer 等待。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply, type Config } from "./index.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  init: vi.fn(async () => undefined),
  migrate: vi.fn(async () => undefined),
}));

vi.mock("dsh-lark-postgres-runtime", () => ({
  KNOWLEDGE_MIGRATIONS: [],
  runMigrations: mocks.migrate,
}));
vi.mock("./database.js", () => ({
  PgKnowledgeDatabase: class { close = mocks.close; },
}));
vi.mock("./embedding.js", () => ({ SiliconFlowEmbeddingClient: class {} }));
vi.mock("./store.js", () => ({ PostgresKnowledgeStore: class {} }));
vi.mock("./admin.js", () => ({ PostgresKnowledgeAdminService: class {} }));
vi.mock("./ingestion.js", () => ({ PostgresKnowledgeIngestionService: class {} }));
vi.mock("./pipeline.js", () => ({
  KnowledgePipeline: class {
    init = mocks.init;
  },
}));

function makeCtx() {
  const self = {
    credentials: { resolve: vi.fn(async () => ({ value: "credential" })) },
    effects: [] as Array<() => unknown>,
    effect: vi.fn((setup: () => () => unknown) => self.effects.push(setup())),
    logger: { warn: vi.fn() },
    on: vi.fn(() => () => undefined),
    provide: vi.fn(),
  };
  return self;
}

const config: Config = {
  databaseUrlEnv: "DATABASE_URL",
  siliconflowApiKeyEnv: "SILICONFLOW_API_KEY",
  uploadsRoot: "D:/uploads",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dsh-knowledge-postgres teardown", () => {
  it("将连接池关闭 Promise 交给 Cordis disposer", async () => {
    const ctx = makeCtx();
    await apply(ctx as never, config);

    const result = ctx.effects.at(-1)!();
    expect(result).toBeInstanceOf(Promise);
    await result;

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("非法配置在解析凭证前 fail loud", async () => {
    const ctx = makeCtx();

    await expect(apply(ctx as never, {
      ...config,
      retrieval: { topK: 0, candidateCount: 20, rerank: true },
    })).rejects.toThrow(/topK/);
    expect(ctx.credentials.resolve).not.toHaveBeenCalled();
  });
});
