/**
 * dsh-lark-admin 插件测试（SPEC admin.md §8）：
 * 假 webServer 捕获注册路由，直接驱动 handler（mock req/res），
 * 覆盖鉴权（401/恒定时间比较路径）、快照、上传 wire 校验、
 * 生命周期动作与静态面。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scopeKey, type Scope } from "dsh-lark-contracts";
import type { BillingService } from "dsh-lark-billing";

import { apply, resolveAdminScope } from "./index.js";
import type { ControlPlaneConfig } from "./control-plane.js";

interface RegisteredRoute {
  kind: string;
  path: string;
  handler: (req: MockRequest, res: MockResponse) => void;
}

interface MockRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
}

interface MockResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  /** 静态流 pipe 目标（测试内捕获）。 */
  pipe?: ReturnType<typeof vi.fn>;
  /** 流接线桩（pipe 会向目标注册 on/once/emit/write/destroy）。 */
  on?: ReturnType<typeof vi.fn>;
  once?: ReturnType<typeof vi.fn>;
  emit?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
}

const ADMIN_TOKEN = "admin-secret-token";
const WORKER_TOKEN = "worker-secret-token";
const CONTROL_PLANE: ControlPlaneConfig = {
  workerBaseUrl: "http://127.0.0.1:8787",
  workerTokenEnv: "WORKER_TOKEN",
  targets: [{
    id: "current-agent",
    label: "当前 Agent",
    scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_admin", conversationId: "oc_admin" },
  }],
};

describe("dsh-lark-admin · identity", () => {
  it("非法品牌化 ID 在装载前 fail closed", () => {
    expect(() => resolveAdminScope({
      tenantId: "t",
      botId: "b",
      deploymentId: "d",
      adminUserId: "",
    })).toThrow(/identity/);
  });
});

function mockRequest(options: {
  method: string;
  url: string;
  authorization?: string;
  body?: Buffer;
  headers?: Record<string, string | string[] | undefined>;
}): MockRequest {
  const chunks = options.body ? [options.body] : [];
  return {
    method: options.method,
    url: options.url,
    headers: {
      ...options.headers,
      ...(options.authorization ? { authorization: options.authorization } : {}),
    },
    [Symbol.asyncIterator]: async function* iterator() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    status: 0,
    headers: {},
    body: "",
    writeHead: vi.fn((status: number, headers: Record<string, string | number>) => {
      response.status = status;
      response.headers = headers;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      response.body = chunk ? String(chunk) : response.body;
    }),
    pipe: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
  };
  return response;
}

interface MockKnowledge {
  retrieve: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  getDocument: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  moveVisibility: ReturnType<typeof vi.fn>;
  reindex: ReturnType<typeof vi.fn>;
  ingestionRuns: ReturnType<typeof vi.fn>;
  ingestionRun: ReturnType<typeof vi.fn>;
}

let uploadsRoot: string;
const tempDirs: string[] = [];
let routes: RegisteredRoute[] = [];
let effectDisposers: Array<() => void> = [];

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), "dsh-lark-admin-"));
  tempDirs.push(uploadsRoot);
  routes = [];
  effectDisposers = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

/** 组装环境：假 webServer 捕获路由 + mock knowledge/credentials。 */
async function makeEnv(input: {
  credentialValue: string | undefined;
  workerCredentialValue?: string;
  controlPlane?: ControlPlaneConfig;
  billing?: BillingService;
} = { credentialValue: ADMIN_TOKEN }) {
  const webServer = {
    host: "127.0.0.1",
    // disposer 真正移除路由（模拟 host-webserver 裸 Map 删除，供泄漏回归）。
    register: vi.fn((route: RegisteredRoute) => {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    }),
  };
  const knowledge: MockKnowledge = {
    retrieve: vi.fn(async () => []),
    ingest: vi.fn(async (_scope: unknown, input: { sourceName: string }) => ({
      runId: "22222222-2222-4222-8222-222222222222",
      fileName: input.sourceName,
      stage: "queued",
      progress: 10,
      status: "processing",
    })),
    snapshot: vi.fn(async () => ({ documents: [], summary: { activeDocuments: 0 } })),
    getDocument: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    moveVisibility: vi.fn(async () => undefined),
    reindex: vi.fn(async () => undefined),
    ingestionRuns: vi.fn(async () => []),
    ingestionRun: vi.fn(async () => undefined),
  };
  const credentials = {
    resolve: vi.fn(async (reference: unknown) => {
      const value = reference === "WORKER_TOKEN" ? input.workerCredentialValue ?? WORKER_TOKEN : input.credentialValue;
      return value ? { value } : undefined;
    }),
  };
  const ctx = {
    webServer,
    knowledge,
    credentials,
    logger: { error: vi.fn(), warn: vi.fn() },
    ...(input.billing ? { billing: input.billing } : {}),
    effect: (setup: () => () => void) => {
      const dispose = setup();
      effectDisposers.push(dispose);
      return () => dispose();
    },
  };
  const adminConfig = {
    identity: { tenantId: "t", botId: "b", deploymentId: "d", adminUserId: "ou_admin" },
    uploadsRoot,
    webRoot: join(uploadsRoot, "web-dist"),
    adminTokenEnv: "ADMIN_TOKEN",
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
  };
  await apply(ctx as never, adminConfig);
  return { knowledge, credentials };
}

/** 找到已注册的 prefix 路由。 */
function route(path: string): RegisteredRoute {
  const found = [...routes].reverse().find((item) => item.path === path);
  if (!found) throw new Error(`route not registered: ${path}`);
  return found;
}

/** 驱动 handler 并等待（fs 线程池回调是 macrotask，轮询直到响应落定）。 */
async function dispatch(path: string, request: MockRequest): Promise<MockResponse> {
  const response = mockResponse();
  route(path).handler(request, response as never);
  for (let attempt = 0; attempt < 300 && response.status === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return response;
}

/** 等待多个微任务轮次，确保 upload 落盘完成。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("dsh-lark-admin · 鉴权", () => {
  it("无令牌 / 错令牌 → 401（恒定时间比较路径）", async () => {
    await makeEnv();
    const noToken = await dispatch("/api/admin/knowledge", mockRequest({ method: "GET", url: "/api/admin/knowledge" }));
    expect(noToken.status).toBe(401);
    expect(JSON.parse(noToken.body)).toEqual({ error: "UNAUTHORIZED" });

    const wrong = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge", authorization: "Bearer wrong" }),
    );
    expect(wrong.status).toBe(401);

    const correct = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(correct.status).toBe(200);
  });

  it("启动时令牌缺失会拒绝插件加载", async () => {
    await expect(makeEnv({ credentialValue: undefined })).rejects.toThrow("凭证引用未配置");
    expect(routes).toHaveLength(0);
  });
});

describe("dsh-lark-admin · 知识面", () => {
  it("GET 快照：以配置的 admin Scope 调 knowledge.snapshot", async () => {
    const { knowledge } = await makeEnv();
    const response = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(response.status).toBe(200);
    expect(knowledge.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t",
      botId: "b",
      deploymentId: "d",
      userId: "ou_admin",
      conversationId: "admin-console",
    }));
  });

  it("GET 文档不存在 → 404；action 对不存在文档 → 404（不泄露存在性）", async () => {
    const { knowledge } = await makeEnv();
    const get = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge/documents/11111111-1111-4111-8111-111111111111", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(get.status).toBe(404);

    const action = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/documents/11111111-1111-4111-8111-111111111111/action",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from(JSON.stringify({ action: "archive" })),
      }),
    );
    expect(action.status).toBe(404);
    expect(knowledge.archive).toHaveBeenCalled();
  });

  it("action：set_visibility 校验目标；reindex 走 force", async () => {
    const { knowledge } = await makeEnv();
    const invalid = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/documents/11111111-1111-4111-8111-111111111111/action",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from(JSON.stringify({ action: "set_visibility", visibility: "global" })),
      }),
    );
    expect(invalid.status).toBe(400);

    const reindex = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/documents/11111111-1111-4111-8111-111111111111/action",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from(JSON.stringify({ action: "reindex" })),
      }),
    );
    expect(reindex.status).toBe(404);
    expect(knowledge.reindex).toHaveBeenCalledWith(expect.anything(), "11111111-1111-4111-8111-111111111111", { force: true });
  });

  it("上传：落盘 scope 归属目录 → ingest；非法 tags/name → 400", async () => {
    const { knowledge } = await makeEnv();
    const ok = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/uploads?name=notes.md&mime=text%2Fmarkdown&visibility=bot_shared&category=product_manual&tags=%5B%22a%22%5D",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from("# 内容"),
      }),
    );
    expect(ok.status).toBe(202);
    await settle();
    const ingestCall = knowledge.ingest.mock.calls[0]!;
    const scope = ingestCall[0] as Scope;
    const input = ingestCall[1] as { sourcePath: string; sourceMime: string; category: string };
    expect(input.sourcePath).toContain(join(uploadsRoot, scopeKey(scope)));
    expect(input.sourceMime).toBe("text/markdown");
    expect(input.category).toBe("product_manual");
    expect(ingestCall[2]).toBe("bot_shared");
    expect(await readFile(input.sourcePath, "utf8")).toBe("# 内容");

    const badTags = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/uploads?name=n.md&mime=text%2Fmarkdown&tags=not-json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from("x"),
      }),
    );
    expect(badTags.status).toBe(400);

    const badName = await dispatch(
      "/api/admin/knowledge",
      mockRequest({
        method: "POST",
        url: "/api/admin/knowledge/uploads?name=%20%20&mime=text%2Fmarkdown",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: Buffer.from("x"),
      }),
    );
    expect(badName.status).toBe(400);
  });

  it("uploads 列表与单查；healthz 探活", async () => {
    const { knowledge } = await makeEnv();
    knowledge.ingestionRuns.mockResolvedValue([{ runId: "r1" }]);
    const list = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge/uploads?limit=3", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ runs: [{ runId: "r1" }] });
    expect(knowledge.ingestionRuns).toHaveBeenCalledWith(expect.anything(), 3);

    knowledge.ingestionRun.mockResolvedValue({ runId: "r1" });
    const one = await dispatch(
      "/api/admin/knowledge",
      mockRequest({ method: "GET", url: "/api/admin/knowledge/uploads/22222222-2222-4222-8222-222222222222", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(one.status).toBe(200);

    const health = await dispatch(
      "/api/admin/healthz",
      mockRequest({ method: "GET", url: "/api/admin/healthz", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
  });

  it("healthz：knowledge 探活失败 → 503", async () => {
    const { knowledge } = await makeEnv();
    knowledge.ingestionRuns.mockRejectedValue(new Error("db down"));
    const health = await dispatch(
      "/api/admin/healthz",
      mockRequest({ method: "GET", url: "/api/admin/healthz", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(health.status).toBe(503);
  });

  it("静态面：服务文件与 SPA 深链；缺失资源仍回退 404", async () => {
    await makeEnv();
    await mkdir(join(uploadsRoot, "web-dist"), { recursive: true });
    await writeFile(join(uploadsRoot, "web-dist", "index.html"), "<html></html>", "utf8");

    // 断言到 200 + content-type（流接线是 Node 内部行为，不在时序敏感断言内）。
    const index = await dispatch("/admin", mockRequest({ method: "GET", url: "/admin" }));
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");

    const deepLink = await dispatch("/admin", mockRequest({ method: "GET", url: "/admin/conversations" }));
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers["content-type"]).toContain("text/html");

    const missing = await dispatch("/admin", mockRequest({ method: "GET", url: "/admin/ghost.html" }));
    expect(missing.status).toBe(404);
  });
});

describe("dsh-lark-admin · billing", () => {
  it("复用 admin Bearer，按配置 tenant/bot/deployment 查询并修改额度", async () => {
    const billing = {
      aggregate: vi.fn(async () => [{ periodStart: "2026-08-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_user", provider: "deepseek", model: "deepseek-chat", calls: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 1, totalMicroCredits: 12 }]),
      quota: vi.fn(async (input: Scope) => ({
        scope: { tenantId: input.tenantId, botId: input.botId, deploymentId: input.deploymentId, userId: input.userId },
        periodStart: "2026-08-01",
        monthlyLimitMicroCredits: 100,
        usedMicroCredits: 12,
        remainingMicroCredits: 88,
      })),
      setQuota: vi.fn(async (input: Scope) => ({
        scope: { tenantId: input.tenantId, botId: input.botId, deploymentId: input.deploymentId, userId: input.userId },
        periodStart: "2026-08-01",
        monthlyLimitMicroCredits: 200,
        usedMicroCredits: 12,
        remainingMicroCredits: 188,
      })),
      listPrices: vi.fn(async () => []),
      setPrice: vi.fn(async (input: unknown) => input),
      assertCanStart: vi.fn(async () => undefined),
      recordUsage: vi.fn(),
    } as unknown as BillingService;
    await makeEnv({ credentialValue: ADMIN_TOKEN, billing });

    const denied = await dispatch("/api/admin/billing", mockRequest({ method: "GET", url: "/api/admin/billing/summary" }));
    expect(denied.status).toBe(401);

    const summary = await dispatch("/api/admin/billing", mockRequest({
      method: "GET",
      url: "/api/admin/billing/summary?userId=ou_user&provider=deepseek",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }));
    expect(summary.status).toBe(200);
    expect(JSON.parse(summary.body)).toMatchObject({ rows: [{ totalUsd: 0.000012 }] });
    expect(JSON.parse(summary.body).rows[0]).not.toHaveProperty("totalMicroCredits");
    expect(billing.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "ou_user",
      provider: "deepseek",
      scope: expect.objectContaining({ tenantId: "t", botId: "b", deploymentId: "d" }),
    }));

    const quota = await dispatch("/api/admin/billing", mockRequest({
      method: "PUT",
      url: "/api/admin/billing/quota",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      body: Buffer.from(JSON.stringify({ userId: "ou_user", monthlyLimitUsd: 0.0002 })),
    }));
    expect(quota.status).toBe(200);
    expect(JSON.parse(quota.body)).toMatchObject({ monthlyLimitUsd: 0.0002, usedUsd: 0.000012, remainingUsd: 0.000188 });
    expect(JSON.parse(quota.body)).not.toHaveProperty("monthlyLimitMicroCredits");
    expect(billing.setQuota).toHaveBeenCalledWith(expect.objectContaining({ userId: "ou_user" }), 200);

    const invalidPrice = await dispatch("/api/admin/billing", mockRequest({
      method: "PUT",
      url: "/api/admin/billing/prices",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      body: Buffer.from(JSON.stringify({
        provider: " ",
        model: "deepseek-chat",
        inputUsdPerMillion: 0.000001,
        outputUsdPerMillion: 0.000001,
        cacheReadUsdPerMillion: 0,
        cacheWriteUsdPerMillion: 0,
        reasoningUsdPerMillion: 0,
      })),
    }));
    expect(invalidPrice.status).toBe(400);
    expect(JSON.parse(invalidPrice.body)).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("当前用户用量只接受内部认证头并返回美元与 Token 聚合", async () => {
    const billing = {
      aggregate: vi.fn(async () => [{ periodStart: "2026-08-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "user-1", provider: "deepseek", model: "deepseek-chat", calls: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 1, totalMicroCredits: 12 }]),
      quota: vi.fn(async (input: Scope) => ({ scope: { tenantId: input.tenantId, botId: input.botId, deploymentId: input.deploymentId, userId: input.userId }, periodStart: "2026-08-01", monthlyLimitMicroCredits: 100, usedMicroCredits: 12, remainingMicroCredits: 88 })),
      listPrices: vi.fn(async () => []),
      setPrice: vi.fn(async (input: unknown) => input),
      setQuota: vi.fn(),
      assertCanStart: vi.fn(),
      recordUsage: vi.fn(),
    } as unknown as BillingService;
    await makeEnv({ credentialValue: ADMIN_TOKEN, billing });

    const missing = await dispatch("/api/billing", mockRequest({ method: "GET", url: "/api/billing/usage", authorization: `Bearer ${ADMIN_TOKEN}` }));
    expect(missing.status).toBe(401);
    const usage = await dispatch("/api/billing", mockRequest({ method: "GET", url: "/api/billing/usage", authorization: `Bearer ${ADMIN_TOKEN}`, headers: { "x-dsh-auth-user-id": "user-1" } }));
    expect(usage.status).toBe(200);
    expect(JSON.parse(usage.body)).toMatchObject({ quota: { monthlyLimitUsd: 0.0001, usedUsd: 0.000012, remainingUsd: 0.000088 }, totals: { calls: 2, totalTokens: 33, totalUsd: 0.000012 }, models: [{ model: "deepseek-chat", totalUsd: 0.000012 }] });
    expect(billing.quota).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(billing.aggregate).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", from: expect.any(Date) }));
  });
});

describe("dsh-lark-admin · control-plane", () => {
  it("先验证 admin Bearer，再以服务端 Scope 和 worker token 读取 dashboard", async () => {
    const request = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/healthz")) return new Response(JSON.stringify({ ok: true, queueDepth: 2 }));
      return new Response(JSON.stringify({
        exists: false,
      }));
    });
    vi.stubGlobal("fetch", request);
    await makeEnv({ credentialValue: ADMIN_TOKEN, workerCredentialValue: WORKER_TOKEN, controlPlane: CONTROL_PLANE });

    const denied = await dispatch("/api/admin/dashboard", mockRequest({ method: "GET", url: "/api/admin/dashboard" }));
    expect(denied.status).toBe(401);
    expect(request).not.toHaveBeenCalled();

    const dashboard = await dispatch(
      "/api/admin/dashboard",
      mockRequest({ method: "GET", url: "/api/admin/dashboard", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(dashboard.status).toBe(200);
    expect(JSON.parse(dashboard.body)).toMatchObject({ targets: [{ target: { id: "current-agent" }, session: { exists: false } }] });
    expect(request).toHaveBeenCalledTimes(2);
    const overviewInit = request.mock.calls[1]?.[1];
    if (!overviewInit) throw new Error("missing overview request");
    expect(new Headers(overviewInit.headers).get("authorization")).toBe(`Bearer ${WORKER_TOKEN}`);
    expect(JSON.parse(String(overviewInit.body))).toEqual({
      scope: CONTROL_PLANE.targets[0]?.scope,
      sessionGeneration: 0,
    });
  });

  it("control-plane 未配置或 target 不存在时不调用 worker", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await makeEnv();
    const disabled = await dispatch(
      "/api/admin/dashboard",
      mockRequest({ method: "GET", url: "/api/admin/dashboard", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(disabled.status).toBe(409);
    expect(request).not.toHaveBeenCalled();

    await makeEnv({ credentialValue: ADMIN_TOKEN, controlPlane: CONTROL_PLANE });
    const unknown = await dispatch(
      "/api/admin/control/conversations",
      mockRequest({ method: "GET", url: "/api/admin/control/conversations/unknown?generation=0", authorization: `Bearer ${ADMIN_TOKEN}` }),
    );
    expect(unknown.status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("dsh-lark-admin · 可逆性", () => {
  it("路由注册经 ctx.effect：上下文销毁后所有路由全部移除（不残留）", async () => {
    await makeEnv();
    expect(routes.map((item) => item.path).sort()).toEqual([
      "/admin",
      "/api/admin/control/conversations",
      "/api/admin/dashboard",
      "/api/admin/healthz",
      "/api/admin/knowledge",
    ]);
    for (const dispose of effectDisposers.splice(0)) dispose();
    expect(routes).toHaveLength(0);
  });
});
