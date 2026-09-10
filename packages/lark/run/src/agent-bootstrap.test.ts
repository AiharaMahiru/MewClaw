import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { makeMessageId, makeRunId, parseScope } from "dsh-lark-contracts";
import { describe, expect, it, vi } from "vitest";

import { createRunAgent } from "./agent-bootstrap.js";
import { applyPresetSkillPolicy, type RunExecutionOptions } from "./executor.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_setup", conversationId: "oc_setup",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scopeValue = parsedScope.value;

interface FakeAgentContext {
  context: Context;
  register: ReturnType<typeof vi.fn>;
  section: ReturnType<typeof vi.fn>;
}

function makeAgentContext(agentPreset: string, selected?: string): FakeAgentContext {
  const register = vi.fn();
  const section = vi.fn();
  const events = selected
    ? [{ type: "agent-preset/selected", data: { agentPreset: selected } }]
    : [];
  const context = {
    agent: { session: { header: { agentPreset }, events } },
    on: vi.fn(() => () => undefined),
    inject: vi.fn(async (_keys: readonly string[], callback: (ctx: Context) => void) => {
      await callback(context as unknown as Context);
    }),
    skills: { register },
    tools: { restrict: vi.fn() },
    systemPrompt: { section },
  } as unknown as Context;
  return { context, register, section };
}

function makeOptions(input: {
  persisted: boolean;
  context: Context;
  mount: ReturnType<typeof vi.fn>;
}): RunExecutionOptions {
  const handle = { agent: {} as never, dispose: vi.fn(async () => undefined) };
  const runSetup = async (request: { setup?: (ctx: Context, agent: never) => Promise<void> }) => {
    await request.setup?.(input.context, (input.context as unknown as { agent: never }).agent);
    return handle;
  };
  return {
    agents: { get: vi.fn(), create: vi.fn(runSetup), resume: vi.fn(runSetup) },
    agentPresets: { mount: input.mount },
    sessionPersistence: {
      list: vi.fn(async () => input.persisted ? [{ header: { id: "session-setup" } }] : []),
    },
    selection: { provider: "deepseek-official", model: "deepseek-chat" },
    agentPresetId: "standard",
    workspaceRoot: ".workspaces-test",
    request: {
      runId: makeRunId("run-setup"),
      scope: scopeValue,
      messageId: makeMessageId("om_setup"),
      prompt: "你好",
    },
    stream: vi.fn(),
    runTimeoutMs: 60_000,
    runHardTimeoutMs: 0,
    preset: {
      name: "lark-standard",
      version: "1.0.0",
      revision: "a".repeat(64),
      skills: ["lark-rag"],
      trustedSkills: ["lark-rag", "lark-cron"],
      denyTools: [],
      autoRetrieve: true,
      persona: "你是 MewClaw。",
    },
    sessionId: "session-setup" as SessionId,
    applyPreset: applyPresetSkillPolicy,
  } as unknown as RunExecutionOptions;
}

describe("createRunAgent setup", () => {
  it("新会话写入 standard，并在发布前挂载同一 DSH preset", async () => {
    const fake = makeAgentContext("standard");
    const mount = vi.fn(async () => ({ id: "standard" }));
    const options = makeOptions({ persisted: false, context: fake.context, mount });

    await createRunAgent(options, options.sessionId, ".workspaces-test/setup");

    expect(options.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: ".workspaces-test/setup", agentPreset: "standard" },
    }));
    expect(mount).toHaveBeenCalledWith(fake.context, "standard");
    expect(fake.section.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "name": "lark:preset-persona",
            "order": 40,
            "text": "你是 MewClaw。",
          },
        ],
      ]
    `);
  });

  it("恢复历史 lark-standard header，不用部署默认值覆盖既有日志", async () => {
    const fake = makeAgentContext("lark-standard");
    const mount = vi.fn(async () => ({ id: "lark-standard" }));
    const options = makeOptions({ persisted: true, context: fake.context, mount });

    await createRunAgent(options, options.sessionId, ".workspaces-test/setup");

    expect(options.agents.resume).toHaveBeenCalledTimes(1);
    expect(options.agents.create).not.toHaveBeenCalled();
    expect(mount).toHaveBeenCalledWith(fake.context, "lark-standard");
    expect(fake.register).toHaveBeenCalledWith(expect.objectContaining({
      name: "lark-cron",
      invocation: { modelInvocable: false, userInvocable: false },
    }));
  });

  it("恢复时以最后一个 agent-preset/selected 事件为准", async () => {
    const fake = makeAgentContext("lark-standard", "code");
    const mount = vi.fn(async () => ({ id: "code" }));
    const options = makeOptions({ persisted: true, context: fake.context, mount });

    await createRunAgent(options, options.sessionId, ".workspaces-test/setup");

    expect(mount).toHaveBeenCalledWith(fake.context, "code");
  });
});
