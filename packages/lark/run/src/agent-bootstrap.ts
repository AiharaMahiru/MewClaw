import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";

import type { RunExecutionOptions } from "./executor.js";
import { atRunStage } from "./run-diagnostics.js";

interface AgentSetupInput {
  ctx: Context;
  options: RunExecutionOptions;
  sessionId: SessionId;
  agent: Agent;
}

function agentPresetForSetup(ctx: Context, agent: Agent, fallback: string): string {
  const session = agent.session;
  if (!session) return fallback;
  // Alpha 版本从 SessionProjectionRegistry 读取；保留无 registry 的轻量测试/启动路径。
  if (ctx.sessionProjections) {
    const projected = ctx.sessionProjections.stateOf(session, "agentPreset");
    return typeof projected === "string" ? projected : fallback;
  }
  // 兼容真实 Session 与轻量测试替身：前者提供 snapshotEvents，后者可能仅暴露 events。
  const sessionRecord = session as unknown as {
    snapshotEvents?: () => readonly unknown[];
    events?: readonly unknown[];
    header?: { agentPreset?: string };
  };
  const events = typeof sessionRecord.snapshotEvents === "function"
    ? sessionRecord.snapshotEvents()
    : sessionRecord.events ?? [];
  const selected = [...events].reverse().find((event): event is { type: "agent-preset/selected"; data: { agentPreset: string } } => {
    if (!event || typeof event !== "object") return false;
    const candidate = event as { type?: unknown; data?: unknown };
    if (candidate.type !== "agent-preset/selected" || !candidate.data || typeof candidate.data !== "object") return false;
    return typeof (candidate.data as { agentPreset?: unknown }).agentPreset === "string";
  });
  return selected?.type === "agent-preset/selected"
    ? selected.data.agentPreset!
    : sessionRecord.header?.agentPreset ?? fallback;
}

export interface RunAgentHandle {
  agent: Agent;
  dispose?: () => Promise<void>;
  unregisterScope(): void;
}

async function setupAgent(input: AgentSetupInput): Promise<(() => void) | undefined> {
  const { ctx, options, sessionId, agent } = input;
  installModelSelection(ctx, { current: options.selection, assembled: undefined });
  await options.agentPresets.mount(ctx, agentPresetForSetup(ctx, agent, options.agentPresetId));
  const preset = options.preset;
  if (preset) {
    await ctx.inject(["skills"], (skillCtx) => {
      options.applyPreset(skillCtx, preset);
    });
  }
  if (preset && preset.denyTools.length > 0) {
    ctx.tools.restrict({ deny: preset.denyTools });
  }
  if (preset?.persona) {
    ctx.systemPrompt.section({
      name: "lark:preset-persona",
      order: 40,
      text: preset.persona,
    });
  }
  return options.registerScope?.(sessionId, options.request.scope);
}

/** create/resume 共用的 agent 组装面。 */
export async function createRunAgent(
  options: RunExecutionOptions,
  sessionId: SessionId,
  workspace: string,
  mode: "deterministic" | "shared" = "deterministic",
): Promise<RunAgentHandle> {
  const live = options.agents.get(sessionId);
  if (live) {
    const unregister = options.registerScope?.(sessionId, options.request.scope);
    return { agent: live, unregisterScope: () => unregister?.() };
  }
  const hasPersistedSession = mode === "shared" ? true : await hasPersisted(options, sessionId);
  let unregister: (() => void) | undefined;
  const common = {
    agentOptions: { provider: options.selection.provider, model: options.selection.model },
    setup: async (ctx: Context, agent: Agent) => {
      unregister = await setupAgent({ ctx, agent, options, sessionId });
    },
  };
  const handle = !hasPersistedSession
    ? await atRunStage("agent-create", () => options.agents.create({
        sessionId,
        meta: { cwd: workspace, agentPreset: options.agentPresetId },
        ...common,
      }), options.reportStage)
    : await atRunStage("agent-resume", () => options.agents.resume({ resumeSessionId: sessionId, ...common }), options.reportStage);
  return { agent: handle.agent, dispose: () => handle.dispose(), unregisterScope: () => unregister?.() };
}

async function hasPersisted(options: RunExecutionOptions, sessionId: SessionId): Promise<boolean> {
  const snapshots = await atRunStage(
    "agent-list-snapshots",
    () => options.sessionPersistence.list(),
    options.reportStage,
  );
  return snapshots.some((snapshot) => snapshot.header.id === sessionId);
}
