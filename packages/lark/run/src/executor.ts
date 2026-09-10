/** 一次 RunRequest 的 agent 生命周期编排。 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle, AgentRegistry, ModelSelection } from "@deepseek-ai/dsh-agent";
import type { AgentPresets } from "@deepseek-ai/dsh-agent-presets";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import type { BillingService } from "dsh-lark-billing";
import "dsh-lark-contracts/context";
import "dsh-lark-contracts/events";
import { LarkError, scopeKey, type RunRequest, type RunStreamDone, type RunStreamItem } from "dsh-lark-contracts";
import type { LarkUploads } from "dsh-lark-uploads";
import type { MemoryCapture, MemoryPart, MemoryService } from "dsh-memory";
import type { SkillTrustService } from "dsh-skill-trust";
import type { LarkSessionDirectory, SessionResolution } from "dsh-lark-session-directory";

import { createRunAgent } from "./agent-bootstrap.js";
import {
  attachFeishuSession,
  feishuPromptTitle,
  updateFeishuWorkspaceTitle,
  type ProjectionCachePort,
  type WorkspaceRegistration,
  type WorkspaceRegistryPort,
} from "./feishu-session-index.js";
import { RunObserver } from "./run-observer.js";
import {
  appendRunInputs,
  boundedMemory,
  MEMORY_REMEMBER_TIMEOUT_MS,
  prepareRunPrompt,
} from "./run-prompt.js";
import { atRunStage, atRunStageSync, reportRunStage, type RunStageReporter } from "./run-diagnostics.js";
import { sessionIdForScope } from "./session-overview.js";

export interface RunPreset {
  name: string;
  version: string;
  revision: string;
  skills: string[];
  trustedSkills: string[];
  denyTools: string[];
  autoRetrieve: boolean;
  persona?: string;
}

export interface RunExecutionOptions {
  agents: AgentRegistry;
  agentPresets: AgentPresets;
  sessionPersistence: SessionPersistence;
  sessionDirectory: LarkSessionDirectory;
  workspaceRegistry?: WorkspaceRegistryPort;
  sessionProjectionCache?: ProjectionCachePort;
  selection: ModelSelection;
  agentPresetId: string;
  workspaceRoot: string;
  request: RunRequest;
  stream: (item: RunStreamItem | RunStreamDone) => void;
  runTimeoutMs: number;
  runHardTimeoutMs: number;
  signal?: AbortSignal;
  reportStage?: RunStageReporter;
  skillTrust?: SkillTrustService;
  registerScope?: (sessionId: SessionId, scope: RunRequest["scope"]) => () => void;
  uploads?: LarkUploads;
  preset?: RunPreset;
  memory?: MemoryService;
  billing?: BillingService;
  logger?: Pick<Context["logger"], "warn">;
  /** 内部派生值，供提示构建落记忆事件。 */
  sessionId: SessionId;
  /** agent scope 的 preset 应用函数，避免 bootstrap 反向依赖实现。 */
  applyPreset: typeof applyPresetSkillPolicy;
}

export type RunEndKind = "ok" | "cancelled" | "timed-out" | "failed" | "empty";

export interface RunResult {
  kind: RunEndKind;
  code?: string;
  durationMs: number;
}

const AGENT_DISPOSE_TIMEOUT_MS = 5_000;

/** 用 scoped 同名 shadow 隐藏 preset 未授权的受审 Skill。 */
export function applyPresetSkillPolicy(ctx: Context, preset: RunPreset): void {
  const allowed = new Set(preset.skills);
  for (const skill of preset.trustedSkills) {
    if (allowed.has(skill)) continue;
    ctx.skills.register({
      name: skill,
      description: "此技能未获当前 preset 授权。",
      source: "runtime",
      content: "",
      invocation: { modelInvocable: false, userInvocable: false },
    });
  }
}

async function preflight(options: RunExecutionOptions): Promise<void> {
  if (!options.skillTrust) return;
  const report = await options.skillTrust.preflight();
  if (!report.ok) {
    throw new LarkError("SESSION_CREATE_FAILED", "environment", "技能供应链预检失败，拒绝加载技能");
  }
}

async function disposeAgent(dispose: () => Promise<void>): Promise<void> {
  await Promise.race([
    dispose(),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, AGENT_DISPOSE_TIMEOUT_MS)),
  ]);
}

/** 在 deterministic 会话释放前落一次投影，缩短 Web 列表看到旧标题的窗口。 */
async function checkpointFeishuProjection(
  options: RunExecutionOptions,
  agent: AgentHandle["agent"],
): Promise<void> {
  const cache = options.sessionProjectionCache;
  if (!cache) return;
  const startedAt = Date.now();
  try {
    await cache.write(agent.session);
    reportRunStage(options.reportStage, "session-projection-cache", startedAt, "ok");
  } catch (error) {
    reportRunStage(options.reportStage, "session-projection-cache", startedAt, "failed");
    const name = error instanceof Error ? error.name : "unknown";
    options.logger?.warn(`lark-run: Feishu projection cache checkpoint failed (${name})`);
  }
}

/** 执行一次运行，并保证 Scope 索引与 agent handle 有界清理。 */
export async function executeRun(input: Omit<RunExecutionOptions, "sessionId" | "applyPreset">): Promise<RunResult> {
  const startedAt = Date.now();
  if (input.billing) {
    await atRunStage("billing-quota", () => input.billing!.assertCanStart(input.request.scope), input.reportStage);
  }
  const target = await atRunStage("session-target", () => input.sessionDirectory.resolve({
    scope: input.request.scope,
    sessionGeneration: input.request.sessionGeneration ?? 0,
  }), input.reportStage);
  const sessionId = targetSessionId(target, input);
  const workspace = target.mode === "shared"
    ? target.cwd
    : resolve(input.workspaceRoot, scopeKey(input.request.scope));
  const selection = target.mode === "shared" && target.selection ? target.selection : input.selection;
  const options: RunExecutionOptions = { ...input, selection, sessionId, applyPreset: applyPresetSkillPolicy };
  if (target.mode === "deterministic") {
    await atRunStage("workspace", () => mkdir(workspace, { recursive: true }), options.reportStage);
  }
  const uploads = options.uploads;
  const artifactBaseline = uploads
    ? await atRunStage("artifact-snapshot", () => uploads.snapshot({ workspace }), options.reportStage)
    : undefined;
  await atRunStage("skill-preflight", () => preflight(options), options.reportStage);
  const owned = await createRunAgent(options, sessionId, workspace, target.mode);
  let unsubscribeTitle: (() => void) | undefined;
  try {
    const { agent } = owned;
    let attachedWorkspace: WorkspaceRegistration | undefined;
    if (target.mode === "deterministic" && options.workspaceRegistry) {
      const provisionalTitle = feishuPromptTitle(options.request.prompt);
      await atRunStage(
        "workspace-attach",
        async () => {
          attachedWorkspace = await attachFeishuSession({
            registry: options.workspaceRegistry!,
            workspacePath: workspace,
            sessionId,
            title: provisionalTitle,
          });
          return attachedWorkspace;
        },
        options.reportStage,
      );
      if (attachedWorkspace) {
        unsubscribeTitle = agentTitleListener(attachedWorkspace, sessionId, provisionalTitle, agent, options.logger);
      }
    }
    atRunStageSync("session-input", () => appendRunInputs(options, agent), options.reportStage);
    const prepared = await atRunStage(
      "prompt-prepare",
      () => prepareRunPrompt(options, agent, workspace),
      options.reportStage,
    );
    let modelStartedAt = 0;
    const observer = new RunObserver({
      agent,
      request: options.request,
      stream: options.stream,
      runTimeoutMs: options.runTimeoutMs,
      runHardTimeoutMs: options.runHardTimeoutMs,
      onFirstVisible: () => {
        if (modelStartedAt > 0) reportRunStage(options.reportStage, "first-visible", modelStartedAt, "ok");
      },
      ...(options.signal ? { signal: options.signal } : {}),
      initialModel: options.selection,
    });
    observer.start();
    if (prepared.failure) observer.fail(prepared.failure);
    try {
      if (!prepared.failure) {
        atRunStageSync(
          "model-followup",
          () => {
            modelStartedAt = Date.now();
            agent.followup(createUserMessage({ content: [{ type: "text", text: prepared.prompt }], source: { kind: "user" } }));
          },
          options.reportStage,
        );
        observer.armNoProgress();
        await atRunStage("agent-idle", () => agent.whenIdle(), options.reportStage);
        if (target.mode === "deterministic") await checkpointFeishuProjection(options, agent);
        // 成功路径收集交付物（R-06）：observer 仍在订阅，事件随运行流到达网关产物行。
        if (options.uploads) {
          await atRunStage(
            "artifact-collect",
            () => options.uploads!.collect({
              scope: options.request.scope,
              session: agent.session,
              workspace,
              baseline: artifactBaseline,
            }),
            options.reportStage,
          );
        }
      }
    } catch (error) {
      observer.fail(error);
    } finally {
      observer.stop();
    }
    if (options.billing) {
      try {
        for (const usage of observer.usageRecords()) {
          await options.billing.recordUsage({
            scope: options.request.scope,
            runId: options.request.runId,
            turn: usage.turn,
            step: usage.step,
            provider: usage.provider,
            model: usage.model,
            usage: usage.usage,
          });
        }
      } catch (error) {
        observer.fail(error);
      }
    }
    const result = observer.finish(startedAt);
    if (result.kind === "ok" && options.memory && observer.assistantOutput().trim()) {
      const feedback = looksLikeMemoryFeedback(options.request.prompt);
      const operation = feedback
        ? options.memory.feedback(options.request.scope, options.request.prompt).then(() => undefined)
        : options.memory.remember(
          options.request.scope,
          options.request.prompt,
          observer.assistantOutput(),
          buildMemoryCapture(options.request, observer),
        );
      void boundedMemory(operation, undefined, MEMORY_REMEMBER_TIMEOUT_MS);
    }
    return result;
  } finally {
    unsubscribeTitle?.();
    owned.unregisterScope();
    if (owned.dispose) {
      await atRunStage("agent-dispose", () => disposeAgent(owned.dispose!), options.reportStage);
    }
  }
}

function looksLikeMemoryFeedback(prompt: string): boolean {
  return /^(请)?\s*(忘记|删除|不要记住|更正|纠正|改成|改为|补充|forget|delete|correct|update)\b/i.test(prompt.trim());
}

function buildMemoryCapture(request: RunRequest, observer: RunObserver): MemoryCapture | undefined {
  const parts: MemoryPart[] = [];
  for (const attachment of request.attachments ?? []) {
    if (!attachment.mimeType.startsWith("image/")) continue;
    parts.push({ modality: "image", uri: attachment.storageKey, alt: attachment.fileName, sha256: attachment.sha256 });
  }
  parts.push(...observer.toolTraces());
  if (parts.length === 0) return undefined;
  return {
    kind: parts.some((part) => part.modality === "tool_trace") ? "tool_trace" : "image",
    parts,
    metadata: { attachmentCount: request.attachments?.length ?? 0, toolTraceCount: observer.toolTraces().length },
    source: { kind: "conversation", reference: request.messageId },
  };
}

function agentTitleListener(
  workspace: WorkspaceRegistration,
  sessionId: SessionId,
  provisionalTitle: string,
  agent: AgentHandle["agent"],
  logger?: Pick<Context["logger"], "warn">,
): (() => void) | undefined {
  if (!workspace.setTitle) return undefined;
  return agent.ctx.on("session/event", (session, event: SessionEvent) => {
    if (session !== agent.session) return;
    if (event.type !== "session/title") return;
    void updateFeishuWorkspaceTitle({
      workspace,
      sessionId,
      provisionalTitle,
      title: event.data.title,
    }).catch(() => {
      logger?.warn("lark-run: Feishu workspace title sync failed");
    });
  });
}

function targetSessionId(
  target: SessionResolution,
  input: Omit<RunExecutionOptions, "sessionId" | "applyPreset">,
): SessionId {
  return target.mode === "shared"
    ? target.sessionId
    : sessionIdForScope(input.request.scope, input.request.sessionGeneration ?? 0);
}
