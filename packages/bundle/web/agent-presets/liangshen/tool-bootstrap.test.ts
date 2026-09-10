import { describe, expect, it, vi } from "vitest";
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";

// 该 preset 是 Cordis 直接加载的 JavaScript 插件，没有独立声明文件。
// @ts-expect-error 测试按生产加载路径直接验证其公开 apply。
import { apply } from "./tool-bootstrap.mjs";

describe("全能优化模式事件恢复", () => {
  it("通过 Session snapshotEvents 公开契约增量扫描事件", async () => {
    type Listener = (...args: unknown[]) => unknown;
    const listeners = new Map<string, Listener>();
    const ctx = {
      logger: { warn: vi.fn() },
      on(name: string, callback: Listener): void { listeners.set(name, callback); },
    };
    const events: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
    const snapshotEvents = vi.fn((from = 0) => events.filter((event) => event.seq >= from));
    const session = {
      header: { cwd: "/workspace" },
      snapshotEvents,
    };
    const agent = { session, ctx: { tools: { presentAs: vi.fn(() => () => undefined) } } };

    apply(ctx, {
      shellTools: ["bash"],
      commonTools: ["str_replace_editor"],
      messageSources: ["user"],
      anchorGate: true,
      maxBootstrapSteps: 4,
      promotedPresentation: "ptc",
      promoteAfterFirstResponse: true,
    });

    const assemble = listeners.get("system-prompt/assemble");
    expect(assemble).toBeTypeOf("function");
    const next = vi.fn(async () => ({
      tools: [{ name: "bash" }, { name: "str_replace_editor" }, { name: "read" }],
      contexts: [{ kind: "runtime" }],
      sections: [{ name: PERSONA_PREFIX_SECTION, text: "persona" }, { name: PERSONA_SUFFIX_SECTION, text: "suffix" }, { name: "plan:policy", text: "plan" }],
    }));

    await expect(assemble?.({}, { agent }, next)).resolves.toMatchObject({
      tools: [{ name: "bash" }, { name: "str_replace_editor" }],
      contexts: [],
      sections: [{ name: PERSONA_PREFIX_SECTION, text: "persona" }, { name: PERSONA_SUFFIX_SECTION, text: "suffix" }],
    });
    expect(snapshotEvents).toHaveBeenLastCalledWith(0);

    events.push({ seq: 0, type: "tool/call", data: {} });
    await expect(assemble?.({}, { agent }, next)).resolves.toBeDefined();
    expect(snapshotEvents).toHaveBeenLastCalledWith(0);

    events.push({ seq: 1, type: "step/start", data: {} });
    await expect(assemble?.({}, { agent }, next)).resolves.toBeDefined();
    expect(snapshotEvents).toHaveBeenLastCalledWith(1);
    events.push({ seq: 2, type: "turn/end", data: {} });
    await expect(assemble?.({}, { agent }, next)).resolves.toMatchObject({
      sections: [
        { name: PERSONA_PREFIX_SECTION, text: "persona\n\nYour working directory is /workspace." },
        { name: PERSONA_SUFFIX_SECTION, text: "suffix" },
        { name: "plan:policy", text: "plan" },
      ],
    });
    expect(agent.ctx.tools.presentAs).toHaveBeenCalledWith("ptc");
  });
});
