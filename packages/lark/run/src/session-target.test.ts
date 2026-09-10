import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";
import { makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";

import { executeRun } from "./executor.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scope = parsedScope.value;

function makeAgent() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    session: { append: vi.fn(), events: [] },
    ctx: { on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
      return () => undefined;
    }) },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {
      for (const listener of listeners.get("session/event") ?? []) {
        listener({}, { type: "assistant/message", seq: 1, time: 1, data: { message: { content: [{ type: "text", text: "ok" }] } } });
      }
    }),
  };
}

function options(input: {
  target: unknown;
  live?: ReturnType<typeof makeAgent>;
  handle?: { agent: ReturnType<typeof makeAgent>; dispose: ReturnType<typeof vi.fn> };
}) {
  const agent = input.handle?.agent ?? input.live ?? makeAgent();
  const handle = input.handle ?? { agent, dispose: vi.fn(async () => undefined) };
  const registerScope = vi.fn(() => vi.fn());
  const create = vi.fn(async () => handle);
  const resume = vi.fn(async () => handle);
  return {
    run: {
      agents: { get: vi.fn(() => input.live), create, resume },
      agentPresets: { mount: vi.fn(async () => undefined) },
      sessionPersistence: { listSnapshots: vi.fn(async () => []) },
      sessionDirectory: { resolve: vi.fn(async () => input.target) },
      selection: { provider: "deployment", model: "default" },
      agentPresetId: "standard",
      workspaceRoot: ".workspaces-test",
      request: { runId: makeRunId("run-target"), scope, messageId: makeMessageId("om-target"), prompt: "继续" },
      stream: vi.fn(), runTimeoutMs: 60_000, runHardTimeoutMs: 0, registerScope,
    },
    agent, handle, create, resume, registerScope,
  };
}

describe("executeRun shared session lifecycle", () => {
  it("borrowed live agent 只 followup，不 create/resume/dispose，仍注册飞书 Scope", async () => {
    const sessionId = SessionId("web-live-session");
    const live = makeAgent();
    const env = options({
      target: { mode: "shared", sessionId, cwd: "D:/web/project", selection: { provider: "web", model: "chosen" } },
      live,
    });

    await executeRun(env.run as never);

    expect(env.create).not.toHaveBeenCalled();
    expect(env.resume).not.toHaveBeenCalled();
    expect(env.handle.dispose).not.toHaveBeenCalled();
    expect(env.registerScope).toHaveBeenCalledWith(sessionId, scope);
    expect(live.followup).toHaveBeenCalledTimes(1);
  });

  it("cold shared session 按持久化 cwd/model resume，并只释放 owned handle", async () => {
    const sessionId = SessionId("web-cold-session");
    const ownedAgent = makeAgent();
    const owned = { agent: ownedAgent, dispose: vi.fn(async () => undefined) };
    const env = options({
      target: {
        mode: "shared", sessionId, cwd: "D:/web/cold",
        selection: { provider: "persisted", model: "persisted-model", reasoningEffort: "high" },
      },
      handle: owned,
    });

    await executeRun(env.run as never);

    expect(env.create).not.toHaveBeenCalled();
    expect(env.resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: sessionId,
      agentOptions: { provider: "persisted", model: "persisted-model" },
    }));
    expect(owned.dispose).toHaveBeenCalledTimes(1);
  });
});
