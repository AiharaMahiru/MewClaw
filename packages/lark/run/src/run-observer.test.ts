import { describe, expect, it, vi } from "vitest";

import { makeRunId, parseScope } from "dsh-lark-contracts";

import { RunObserver } from "./run-observer.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!parsedScope.ok) throw new Error("unreachable");

describe("RunObserver", () => {
  it("只把非空 text-delta 计为首个用户可见输出", () => {
    const listeners: Array<(...args: unknown[]) => void> = [];
    const agent = {
      ctx: { on: vi.fn((_event: string, listener: (...args: unknown[]) => void) => { listeners.push(listener); return () => undefined; }) },
      cancel: vi.fn(),
    };
    const streamed: unknown[] = [];
    const onFirstVisible = vi.fn();
    const observer = new RunObserver({
      agent: agent as never,
      request: { runId: makeRunId("run-1"), scope: parsedScope.value } as never,
      stream: (item) => streamed.push(item),
      runTimeoutMs: 60_000,
      runHardTimeoutMs: 0,
      onFirstVisible,
    });

    observer.start();
    const emit = (frame: unknown) => listeners[1]!({ agent, frame });
    emit({ type: "start", attemptId: "a1", turn: 1, step: 1 });
    emit({ type: "chunk", attemptId: "a1", chunk: { type: "reasoning-delta", index: 0, text: "hidden" } });
    emit({ type: "chunk", attemptId: "a1", chunk: { type: "tool-call-delta", index: 1, id: "call_1", argumentsDelta: "{}" } });
    expect(onFirstVisible).not.toHaveBeenCalled();

    emit({ type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "回答" } });
    expect(onFirstVisible).toHaveBeenCalledTimes(1);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({ assistant: { turn: 1, step: 1, text: "回答" } });
    observer.stop();
    expect(observer.finish(Date.now()).kind).toBe("ok");
  });
});
