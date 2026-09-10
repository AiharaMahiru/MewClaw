import { request as httpRequest } from "node:http";

import { describe, expect, it } from "vitest";

interface RpcBody {
  type: string;
  rpcId: string;
  result: {
    ok: boolean;
    value?: unknown;
    error?: { code: string };
  };
}

interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface ModelDirectory {
  current: ModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    models: Array<{
      id: string;
      reasoning?: { defaultEffort?: string };
    }>;
  }>;
  failures: unknown[];
}

const webUrl = (process.env.DSH_WEB_URL ?? "").replace(/\/$/, "");
const larkUrl = (process.env.DSH_LARK_URL ?? "").replace(/\/$/, "");
const liveSessionId = process.env.DSH_TEST_SESSION_ID ?? "";
const missingSessionId = `session-${"0".repeat(64)}`;
let rpcSequence = 0;

async function postRpc(method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`${webUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: `dsh-web-test-${method}-${++rpcSequence}`,
      method,
      payload,
    }),
  });
  return { response, body: await response.json() as RpcBody };
}

function openDownlink(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${webUrl.replace(/^http/, "ws")}/api/${path}`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket timeout: ${path}`));
    }, 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${path}`));
    });
  });
}

function forbiddenHostStatus(): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${webUrl}/api/host.describe`, {
      method: "POST",
      headers: { host: "evil.invalid", "content-type": "application/json" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end("{}");
  });
}

describe.skipIf(!webUrl)("官方 dsh Web live 协议", () => {
  it("首页提供官方 bootstrap 与聊天 roster", async () => {
    const response = await fetch(webUrl);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("window.__DSH_BOOT__");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-conversation");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-commands");
    expect(html).toContain("@deepseek-ai/dsh-client-ui-settings");
  });

  it("点号 RPC 通过官方 client-request envelope 路由", async () => {
    for (const method of ["host.describe", "session.list", "llm.providers"]) {
      const { response, body } = await postRpc(method);
      expect(response.status).toBe(200);
      expect(body.type).toBe("server-response");
      expect(body.result.ok).toBe(true);
    }
  });

  it("保持 content-type、Host trust fence 与事件升级边界", async () => {
    const wrongMedia = await fetch(`${webUrl}/api/host.describe`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongMedia.status).toBe(415);

    expect(await forbiddenHostStatus()).toBe(403);

    const events = await fetch(`${webUrl}/api/events.mux`);
    expect(events.status).toBe(426);
    expect(events.headers.get("upgrade")).toBe("websocket");
  });

  it("session history、prompt、cancel 均进入官方路由且不触发模型", async () => {
    const requests: Array<[string, Record<string, unknown>]> = [
      ["session.history", { sessionId: missingSessionId }],
      ["session.prompt", {
        sessionId: missingSessionId,
        mode: "queue",
        content: [{ type: "text", text: "protocol probe" }],
      }],
      ["session.cancel", { sessionId: missingSessionId }],
    ];
    for (const [method, payload] of requests) {
      const { response, body } = await postRpc(method, payload);
      expect(response.status).toBe(200);
      expect(body.result.ok).toBe(false);
      expect(body.result.error?.code).toBe("session-not-found");
    }
  });

  it("slash 命令使用官方 commands/list 与 commands/execute 路径", async () => {
    const requests: Array<[string, Record<string, unknown>]> = [
      ["commands/list", { args: { agentId: missingSessionId } }],
      ["commands/execute", {
        args: { agentId: missingSessionId, line: "/help", images: [] },
      }],
    ];
    for (const [method, payload] of requests) {
      const { response, body } = await postRpc(method, payload);
      expect(response.status).toBe(200);
      expect(body.result.ok).toBe(false);
      expect(body.result.error?.code).toBe("session-not-found");
    }
  });

  it("两个官方只下行事件通道都能升级", async () => {
    await openDownlink("events.mux");
    await openDownlink("events.host");
  });

  it.skipIf(!larkUrl)("/v1 与官方 Web 在同一 Worker 共存并保留 Bearer 边界", async () => {
    const health = await fetch(`${larkUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const overview = await fetch(`${larkUrl}/v1/session-overview`);
    expect(overview.status).toBe(401);
  });
});

describe.skipIf(!webUrl || !liveSessionId)("官方 dsh Web 模型选择", () => {
  it("枚举、切换并恢复隔离会话的模型选择", async () => {
    const initial = await postRpc("session.models", { sessionId: liveSessionId });
    expect(initial.response.status).toBe(200);
    expect(initial.body.result.ok).toBe(true);
    const directory = initial.body.result.value as ModelDirectory;
    expect(directory.routable).toBe(true);
    expect(directory.failures).toEqual([]);

    const candidates = directory.groups.flatMap((group) => group.models.map((model) => ({
      provider: group.id,
      model: model.id,
      ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
    })));
    const target = candidates.find((candidate) =>
      candidate.provider !== directory.current.provider || candidate.model !== directory.current.model,
    ) ?? candidates[0];
    expect(target).toBeDefined();

    try {
      const selected = await postRpc("session.selectModel", { sessionId: liveSessionId, ...target });
      expect(selected.body.result).toMatchObject({ ok: true, value: { selected: target } });
      const after = await postRpc("session.models", { sessionId: liveSessionId });
      expect(after.body.result).toMatchObject({ ok: true, value: { current: target } });
    } finally {
      const restored = await postRpc("session.selectModel", {
        sessionId: liveSessionId,
        ...directory.current,
      });
      expect(restored.body.result).toMatchObject({ ok: true, value: { selected: directory.current } });
    }
  });
});
