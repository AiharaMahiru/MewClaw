import { describe, expect, it } from "vitest";
import type { AuthService, AuthUser } from "dsh-lark-auth";
import { RemoteEventResults } from "./remote-event-results.js";

const user = { id: "user-a", role: "user" } as AuthUser;
const service = { findResource: async () => ({ userId: user.id }) } as unknown as AuthService;
const answer = (eventId = "event-1", clientId = "client-1", outcome: unknown = { kind: "result", value: "A" }) => ({ method: "$events/result", payload: { args: { clientId, eventId, outcome } } });
function open(registry: RemoteEventResults, clientId = "client-1") {
  const connection = registry.connection(user.id);
  connection.client(JSON.stringify({ type: "open", streamId: "events", endpoint: "$events" }));
  const send = (value: unknown) => connection.server(JSON.stringify({ type: "item", streamId: "events", value }));
  send({ type: "ready", clientId });
  send({ type: "waterfall", eventId: "event-1", agentId: "session-a" });
  return { ...connection, send };
}

describe("Remote选项回传的关联和清理", () => {
  it.each([{ kind: "next" }, { kind: "result" }, { kind: "result", value: { choice: "A" } }, { kind: "rejected", error: { name: "Error", message: "cancelled", details: ["reason", null] } }])("支持官方outcome %j且只消费一次", async outcome => {
    const registry = new RemoteEventResults();
    const connection = open(registry);
    expect(await registry.authorize(answer("event-1", "client-1", outcome), user, service)).toBeUndefined();
    expect(await registry.authorize(answer(), user, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    connection.dispose();
  });
  it("拒绝跨用户、未知事件和非法参数且不消耗合法回答", async () => {
    const registry = new RemoteEventResults();
    const connection = open(registry);
    expect(await registry.authorize(answer(), { ...user, id: "user-b" }, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    expect(await registry.authorize(answer("unknown"), user, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    expect(await registry.authorize(answer("event-1", "client-1", { kind: "next", value: true }), user, service)).toBe("INVALID_RPC");
    expect(await registry.authorize(answer(), user, service)).toBeUndefined();
    connection.dispose();
  });
  it.each(["cancel-event", "cancel-stream", "end", "error", "disconnect"])("%s后拒绝旧事件且不污染新连接", async mode => {
    const registry = new RemoteEventResults();
    const connection = open(registry);
    if (mode === "cancel-event") connection.send({ type: "cancel", eventId: "event-1" });
    else if (mode === "cancel-stream") connection.client(JSON.stringify({ type: "cancel", streamId: "events" }));
    else if (mode === "disconnect") connection.dispose();
    else connection.server(JSON.stringify({ type: mode, streamId: "events" }));
    expect(await registry.authorize(answer(), user, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    connection.dispose();
    const next = open(registry, "client-2");
    connection.send({ type: "ready", clientId: "client-1" });
    expect(await registry.authorize(answer(), user, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    expect(await registry.authorize(answer("event-1", "client-2"), user, service)).toBeUndefined();
    next.dispose();
  });
  it("业务流中的伪握手不授权；事件的实际会话归属重新校验", async () => {
    const registry = new RemoteEventResults();
    const connection = registry.connection(user.id);
    connection.client(JSON.stringify({ type: "open", streamId: "rpc", endpoint: "llm/models" }));
    connection.server(JSON.stringify({ type: "item", streamId: "rpc", value: { type: "ready", clientId: "client-1" } }));
    expect(await registry.authorize(answer(), user, service)).toBe("EVENT_RESULT_NOT_ALLOWED");
    const real = open(registry);
    const foreign = { findResource: async () => ({ userId: "user-b" }) } as unknown as AuthService;
    expect(await registry.authorize(answer(), user, foreign)).toBe("RESOURCE_NOT_ALLOWED");
    real.dispose();
    connection.dispose();
  });
  it("异步归属检查期间取消则拒绝；并发双答只通过一次", async () => {
    const registry = new RemoteEventResults();
    const connection = open(registry);
    const cancel = { findResource: async () => { connection.send({ type: "cancel", eventId: "event-1" }); return { userId: user.id }; } } as unknown as AuthService;
    expect(await registry.authorize(answer(), user, cancel)).toBe("EVENT_RESULT_NOT_ALLOWED");
    connection.send({ type: "waterfall", eventId: "event-2", agentId: "session-a" });
    const results = await Promise.all([registry.authorize(answer("event-2"), user, service), registry.authorize(answer("event-2"), user, service)]);
    expect(results.filter(result => result === undefined)).toHaveLength(1);
    connection.dispose();
  });
});
