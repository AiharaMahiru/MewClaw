import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import type { LarkErrorCode, RunRequest, RunStreamDone, RunStreamItem } from "dsh-lark-contracts";
import type { MemoryPart } from "dsh-memory";

import type { RunResult } from "./executor.js";

type RunAgent = AgentHandle["agent"];
type EndReason = "user" | "timeout";

interface RunObserverOptions {
  agent: RunAgent;
  request: RunRequest;
  stream: (item: RunStreamItem | RunStreamDone) => void;
  runTimeoutMs: number;
  runHardTimeoutMs: number;
  onFirstVisible?: () => void;
  signal?: AbortSignal;
  initialModel?: { provider: string; model: string };
}

export interface RunUsageRecord {
  turn: number;
  step: number;
  provider: string;
  model: string;
  usage: TokenUsage;
}

function doneLine(request: RunRequest, code: "OK" | LarkErrorCode, message?: string): RunStreamDone {
  return {
    envelope: { runId: request.runId, scope: request.scope },
    outcome: code === "OK" ? { code: "OK" } : { code, message: message ?? code },
  };
}

function assistantText(event: SessionEvent): string {
  if (event.type !== "assistant/message") return "";
  let text = "";
  for (const block of event.data.message.content) {
    if (block.type === "text" && block.text.trim().length > 0) text += block.text;
  }
  return text;
}

function assistantChunkText(event: SessionEvent): string {
  if (event.type !== "assistant/chunk" || event.data.chunk.type !== "text-delta") return "";
  return event.data.chunk.text;
}

export class RunObserver {
  #endedBy: EndReason | undefined;
  #failure: string | undefined;
  #seenVisible = false;
  #assistantText = "";
  #toolTraces: MemoryPart[] = [];
  #pendingTools = new Map<string, { tool: string; input: unknown }>();
  #provider: string;
  #model: string;
  #usageRecords: RunUsageRecord[] = [];
  #noProgress: NodeJS.Timeout | undefined;
  #hardLimit: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly options: RunObserverOptions) {
    this.#provider = options.initialModel?.provider ?? "unknown";
    this.#model = options.initialModel?.model ?? "unknown";
  }

  start(): void {
    const { agent, runHardTimeoutMs, signal } = this.options;
    if (runHardTimeoutMs > 0) {
      this.#hardLimit = setTimeout(() => this.#timeout("lark/run-hard-limit"), runHardTimeoutMs);
    }
    if (signal?.aborted) this.#abort();
    else signal?.addEventListener("abort", this.#abort, { once: true });
    this.#unsubscribe = agent.ctx.on("session/event", (_session, event: SessionEvent) => {
      this.armNoProgress();
      this.#record(event);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.options.signal?.removeEventListener("abort", this.#abort);
    if (this.#noProgress) clearTimeout(this.#noProgress);
    if (this.#hardLimit) clearTimeout(this.#hardLimit);
  }

  armNoProgress(): void {
    if (this.#noProgress) clearTimeout(this.#noProgress);
    this.#noProgress = setTimeout(
      () => this.#timeout("lark/run-no-progress"),
      this.options.runTimeoutMs,
    );
  }

  fail(error: unknown): void {
    this.#failure = error instanceof Error ? error.message : String(error);
  }

  assistantOutput(): string {
    return this.#assistantText;
  }

  toolTraces(): MemoryPart[] {
    return this.#toolTraces.slice(0, 32);
  }

  usageRecords(): RunUsageRecord[] {
    return this.#usageRecords.slice();
  }

  finish(startedAt: number): RunResult {
    const durationMs = Date.now() - startedAt;
    if (this.#endedBy === "user") return this.#emitResult("CANCELLED", { kind: "cancelled", durationMs });
    if (this.#endedBy === "timeout") return this.#emitResult("RUN_TIMEOUT", { kind: "timed-out", durationMs });
    if (this.#failure) {
      return this.#emitResult("RUNTIME_ERROR", { kind: "failed", code: "RUNTIME_ERROR", durationMs }, this.#failure);
    }
    if (!this.#seenVisible) return this.#emitResult("EMPTY_RESPONSE", { kind: "empty", durationMs });
    return this.#emitResult("OK", { kind: "ok", durationMs });
  }

  #record(event: SessionEvent): void {
    const { request, stream } = this.options;
    stream({ event, envelope: { runId: request.runId, scope: request.scope } });
    const chunkText = assistantChunkText(event);
    if (chunkText.trim().length > 0) {
      if (!this.#seenVisible) this.options.onFirstVisible?.();
      this.#seenVisible = true;
    }
    const text = assistantText(event);
    if (text.length > 0) {
      if (!this.#seenVisible) this.options.onFirstVisible?.();
      this.#seenVisible = true;
      this.#assistantText = (this.#assistantText + text).slice(0, 100_000);
    }
    if (event.type === "request/context") {
      this.#provider = event.data.provider;
      this.#model = event.data.model;
    }
    if (event.type === "assistant/message" && event.data.usage) {
      this.#usageRecords.push({
        turn: event.data.turn,
        step: event.data.step,
        provider: this.#provider,
        model: this.#model,
        usage: event.data.usage,
      });
    }
    if (event.type === "lark/artifact/created") this.#seenVisible = true;
    if (event.type === "tool/call") {
      this.#pendingTools.set(event.data.callId, {
        tool: event.data.name,
        input: parseToolArguments(event.data.arguments),
      });
    }
    if (event.type === "tool/result") {
      const pending = this.#pendingTools.get(event.data.message.source.callId);
      if (!pending) return;
      this.#pendingTools.delete(event.data.message.source.callId);
      this.#toolTraces.push({
        modality: "tool_trace",
        tool: pending.tool,
        input: pending.input,
        output: compactToolOutput(event.data.message.content),
        ok: !event.data.error,
      });
    }
  }

  #emitResult(code: "OK" | LarkErrorCode, result: RunResult, message?: string): RunResult {
    this.options.stream(doneLine(this.options.request, code, message));
    return result;
  }

  #timeout = (reason: string): void => {
    this.#endedBy = "timeout";
    this.options.agent.cancel({ kind: "hook", reason });
  };

  #abort = (): void => {
    this.#endedBy = "user";
    this.options.agent.cancel({ kind: "user" });
  };
}

function parseToolArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return value.slice(0, 4_000); }
}

function compactToolOutput(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded.slice(0, 8_000) : "";
  } catch { return "[unserializable tool output]"; }
}
