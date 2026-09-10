/**
 * HTTP 面测试（SPEC lark-run.md §8）：真实 node:http 服务（port 0），
 * 覆盖鉴权、体校验、NDJSON 流（事件行/心跳/终止行）与 cancel。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeArtifactId, makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";

import { createRunServer, type RunServer, type RunServerOptions } from "./http.js";
import { QueueFullError } from "./queue.js";

const scope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!scope.ok) throw new Error("unreachable");

const validBody = {
  runId: "run-1",
  scope: scope.value,
  messageId: "om_1",
  prompt: "你好",
};

function makeOptions() {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "secret-token",
    enqueue: vi.fn(),
    cancel: vi.fn(() => true),
    resolveInteraction: vi.fn(() => true),
    sessionOverview: vi.fn(async () => ({ exists: false })),
    readArtifact: vi.fn(),
    queueDepth: () => 2,
    heartbeatIntervalMs: 50,
  };
}

describe("交互解答", () => {
  it("完整校验并传递回调 Scope", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    const response = await fetch(`${url}/v1/interaction/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ scope: scope.value, interactionId, answer: { selected: ["继续"] } }),
    });

    expect(response.status).toBe(200);
    expect(options.resolveInteraction).toHaveBeenCalledWith(
      scope.value,
      interactionId,
      { selected: ["继续"] },
    );
  });

  it("自定义答案允许空 selected 并传递 custom", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    const response = await fetch(`${url}/v1/interaction/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({
        scope: scope.value,
        interactionId,
        answer: { selected: [], custom: "补充说明" },
      }),
    });

    expect(response.status).toBe(200);
    expect(options.resolveInteraction).toHaveBeenCalledWith(
      scope.value,
      interactionId,
      { selected: [], custom: "补充说明" },
    );
  });

  it("缺少 Scope 时拒绝，不广播答案", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const response = await fetch(`${url}/v1/interaction/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c",
        answer: { selected: ["继续"] },
      }),
    });

    expect(response.status).toBe(400);
    expect(options.resolveInteraction).not.toHaveBeenCalled();
  });

  it("拒绝未知字段、过多选项和超长答案", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const interactionId = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    const bodies = [
      { scope: scope.value, interactionId, answer: { selected: ["继续"] }, extra: true },
      { scope: scope.value, interactionId, answer: { selected: ["继续"], extra: true } },
      { scope: scope.value, interactionId, answer: { selected: Array.from({ length: 65 }, () => "继续") } },
      { scope: scope.value, interactionId, answer: { selected: ["x".repeat(4_001)] } },
      { scope: scope.value, interactionId, answer: { selected: ["继续"], custom: "x".repeat(4_001) } },
    ];

    for (const body of bodies) {
      const response = await fetch(`${url}/v1/interaction/resolve`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(options.resolveInteraction).not.toHaveBeenCalled();
  });
});

let server: RunServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(options: RunServerOptions = makeOptions() as unknown as RunServerOptions): Promise<RunServer> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await createRunServer(options);
    try {
      // 本机 ephemeral range 可覆盖 Fetch 标准禁止端口；先探活，命中 bad port 就重新绑定。
      await fetch(`${candidate.url}/healthz`);
      server = candidate;
      return candidate;
    } catch (error) {
      await candidate.close();
      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
      if (!(cause instanceof Error) || cause.message !== "bad port") throw error;
    }
  }
  throw new Error("无法分配 Fetch 可用的测试端口");
}

describe("鉴权", () => {
  it("token 不匹配 → 401", async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(401);
  });

  it("token 匹配 → 进入业务路径（200 NDJSON）", async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    await response.body?.cancel();
  });

  it("无 token 配置 = 无鉴权模式", async () => {
    const options = makeOptions();
    const { url } = await boot({ ...options, token: undefined } as unknown as RunServerOptions);
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST",
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});

describe("请求校验", () => {
  it("非法 body → 400 + 错误码", async () => {
    const { url } = await boot();
    for (const body of ["not json", JSON.stringify({ runId: "" }), JSON.stringify({ ...validBody, prompt: "" })]) {
      const response = await fetch(`${url}/v1/runs`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
        body,
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe("INVALID_REQUEST");
    }
  });
});

describe("受限图片 artifact 读取", () => {
  const artifactBody = {
    scope: scope.value,
    artifactId: makeArtifactId("a".repeat(64)),
    name: "generated-image.png",
    digest: "b".repeat(64),
    bytes: 3,
  };

  it("认证后只返回 Worker 重新验证的图片字节", async () => {
    const options = makeOptions();
    options.readArtifact.mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" });
    const { url } = await boot(options as unknown as RunServerOptions);
    const response = await fetch(`${url}/v1/artifacts/read`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify(artifactBody),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
    expect(options.readArtifact).toHaveBeenCalledWith(artifactBody);
  });

  it("非法字段、路径和摘要在 Worker reader 前 fail closed", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const invalidBodies = [
      { ...artifactBody, name: "../escape.png" },
      { ...artifactBody, digest: "not-a-digest" },
      { ...artifactBody, bytes: 0 },
      { ...artifactBody, extra: true },
    ];

    for (const body of invalidBodies) {
      const response = await fetch(`${url}/v1/artifacts/read`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(options.readArtifact).not.toHaveBeenCalled();
  });
});

describe("会话查询", () => {
  it("完整校验 Scope 与代次后查询", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const response = await fetch(`${url}/v1/session-overview`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ scope: scope.value, sessionGeneration: 3 }),
    });
    expect(response.status).toBe(200);
    expect(options.sessionOverview).toHaveBeenCalledWith({ scope: scope.value, sessionGeneration: 3 });
  });

  it("缺失 Scope 或非法代次时 fail closed", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    for (const body of [{ sessionGeneration: 0 }, { scope: scope.value, sessionGeneration: -1 }]) {
      const response = await fetch(`${url}/v1/session-overview`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(options.sessionOverview).not.toHaveBeenCalled();
  });
});

describe("NDJSON 流", () => {
  it("事件行 + 心跳空行 + 终止行", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    // enqueue 期间写入事件行，停留超过心跳间隔（50ms）后写终止行。
    options.enqueue.mockImplementation(async (_request: unknown, _signal: unknown, writer?: { write: (item: unknown) => void }) => {
      writer!.write({ event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }, envelope: { runId: "run-1", scope: scope.value } });
      await new Promise((resolve) => setTimeout(resolve, 120));
      writer!.write({ envelope: { runId: "run-1", scope: scope.value }, outcome: { code: "OK" } });
    });
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify(validBody),
    });
    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as { event?: { type?: string }; outcome?: { code: string } });
    expect(parsed.some((item) => item.event?.type === "turn/start")).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ outcome: { code: "OK" } });
    // 心跳空行：流存活期间周期性写空行（原始文本中存在连续换行）。
    expect(text).toMatch(/\n\n/);
  });

  it("队列满 → 终止行 QUEUE_FULL", async () => {
    const options = makeOptions();
    options.enqueue.mockRejectedValue(new QueueFullError());
    const { url } = await boot(options as unknown as RunServerOptions);
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: JSON.stringify(validBody),
    });
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { outcome?: { code: string } });
    expect(lines.at(-1)?.outcome?.code).toBe("QUEUE_FULL");
  });
});

describe("cancel 与 healthz", () => {
  it("cancel 命中 → 200；未命中 → 404", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const hit = await fetch(`${url}/v1/runs/run-1/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(hit.status).toBe(200);
    expect(options.cancel).toHaveBeenCalledWith("run-1");

    options.cancel.mockReturnValue(false);
    const miss = await fetch(`${url}/v1/runs/run-9/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(miss.status).toBe(404);
  });

  it("cancel 路径中的未品牌化 runId → 400，且不进入取消器", async () => {
    const options = makeOptions();
    const { url } = await boot(options as unknown as RunServerOptions);
    const paths = ["run-%0Ainjected", "x".repeat(257)];

    for (const path of paths) {
      const response = await fetch(`${url}/v1/runs/${path}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
      });
      expect(response.status).toBe(400);
    }
    expect(options.cancel).not.toHaveBeenCalled();
  });

  it("healthz 返回队列深度摘要（无 scope 细节）", async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queueDepth: 2 });
  });
});

describe("cron HTTP 请求校验", () => {
  it("未品牌化 claim/ack 字段 → 400，且不触发 cron 服务", async () => {
    const options = makeOptions();
    const cron = {
      control: vi.fn(),
      claimDeliveries: vi.fn(async () => []),
      ackDelivery: vi.fn(async () => true),
    };
    const { url } = await boot({ ...options, cron } as unknown as RunServerOptions);
    const requests = [
      ["/v1/cron-deliveries/claim", {
        tenantId: "t\nunsafe", botId: "b", deploymentId: "d", userIds: ["ou_1"],
      }],
      ["/v1/cron-deliveries/ack", { runId: "run-1\nunsafe", deliveryToken: "token" }],
      ["/v1/cron-deliveries/ack", { runId: "run-1", deliveryToken: "token\nunsafe" }],
    ] as const;

    for (const [path, body] of requests) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(cron.claimDeliveries).not.toHaveBeenCalled();
    expect(cron.ackDelivery).not.toHaveBeenCalled();
  });
});

// 供未使用告警（makeRunId/makeMessageId 经 scope 校验路径覆盖）
void makeMessageId;
void makeRunId;
