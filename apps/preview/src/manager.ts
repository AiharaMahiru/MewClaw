import { randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { Scope } from "dsh-lark-contracts";
import type { PreviewDescriptor, PreviewId, PreviewService } from "dsh-preview";

import type { AppConfig } from "./config.js";
import { PreviewAppError } from "./errors.js";
import { authorizeWorkspace } from "./path-policy.js";
import type { PreviewRuntime } from "./podman.js";

interface Entry {
  descriptor: PreviewDescriptor;
  userId: string;
  container: string;
  timer: NodeJS.Timeout;
}

export type PreviewAuditEvent =
  | { type: "preview/created"; id: string; userId: string; occurredAt: string }
  | { type: "preview/revoked" | "preview/expired"; id: string; userId: string; occurredAt: string; reason: "revoked" | "expired" }
  | { type: "preview/cleanup-failed"; id: string; userId: string; occurredAt: string; reason: "revoke" | "expire" | "dispose" };

export type PreviewAuditSink = (event: PreviewAuditEvent) => void;

const BLOCKED_PORTS = new Set([13_080, 13_081, 13_082, 18_788, 18_791, 5432]);

export class PreviewManager implements PreviewService {
  readonly #entries = new Map<string, Entry>();
  #disposed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: PreviewRuntime,
    private readonly now: () => number = Date.now,
    private readonly audit: PreviewAuditSink = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    await this.runtime.cleanupOrphans();
  }

  async publish(input: Parameters<PreviewService["publish"]>[0]): Promise<PreviewDescriptor> {
    this.#assertActive();
    validatePublish(input.command, input.port);
    const workspace = await authorizeWorkspace(this.config.workspaceRoot, input.workspace, input.scope);
    await this.#expireDue();
    const active = [...this.#entries.values()].filter((entry) => entry.userId === input.scope.userId).length;
    if (active >= this.config.maxSharesPerUser) throw new PreviewAppError("PREVIEW_QUOTA");
    const ttl = input.ttlMinutes === undefined ? this.config.defaultTtlMinutes : input.ttlMinutes;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > this.config.maxTtlMinutes) {
      throw new PreviewAppError("PREVIEW_INVALID_INPUT", "ttlMinutes 超出范围");
    }
    const id = randomBytes(16).toString("hex") as PreviewId;
    const container = await this.runtime.create({
      id,
      userId: input.scope.userId,
      workspace,
      command: input.command,
      port: input.port,
    });
    const created = this.now();
    const expires = created + ttl * 60_000;
    const descriptor: PreviewDescriptor = {
      id,
      url: `${this.config.publicBaseUrl}/share/${id}/`,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      port: input.port,
    };
    const timer = setTimeout(() => { void this.#expire(id).catch(() => undefined); }, Math.max(0, expires - this.now()));
    timer.unref();
    this.#entries.set(id, { descriptor, userId: input.scope.userId, container, timer });
    this.#emit({ type: "preview/created", id, userId: input.scope.userId, occurredAt: new Date(created).toISOString() });
    return descriptor;
  }

  async list(scope: Scope): Promise<readonly PreviewDescriptor[]> {
    this.#assertActive();
    await this.#expireDue();
    return [...this.#entries.values()]
      .filter((entry) => entry.userId === scope.userId)
      .map((entry) => entry.descriptor);
  }

  async revoke(scope: Scope, id: string): Promise<void> {
    this.#assertActive();
    const entry = this.#entries.get(id);
    if (!entry) throw new PreviewAppError("PREVIEW_NOT_FOUND");
    if (entry.userId !== scope.userId) throw new PreviewAppError("PREVIEW_FORBIDDEN");
    await this.#remove(id, entry, "revoke");
  }

  async resolvePublic(id: string): Promise<{ descriptor: PreviewDescriptor; bridge: () => ChildProcessWithoutNullStreams }> {
    this.#assertActive();
    const entry = this.#entries.get(id);
    if (!entry || Date.parse(entry.descriptor.expiresAt) <= this.now()) {
      if (entry) await this.#expire(id);
      throw new PreviewAppError("PREVIEW_NOT_FOUND");
    }
    return {
      descriptor: entry.descriptor,
      bridge: () => this.runtime.bridge(entry.container, entry.descriptor.port),
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const entries = [...this.#entries.entries()];
    this.#entries.clear();
    await Promise.allSettled(entries.map(async ([, entry]) => {
      clearTimeout(entry.timer);
      try {
        await this.runtime.remove(entry.container);
      } catch {
        this.#emit({ type: "preview/cleanup-failed", id: entry.descriptor.id, userId: entry.userId, occurredAt: new Date(this.now()).toISOString(), reason: "dispose" });
      }
    }));
  }

  async #expireDue(): Promise<void> {
    const due = [...this.#entries.entries()].filter(([, entry]) => Date.parse(entry.descriptor.expiresAt) <= this.now());
    await Promise.all(due.map(([id]) => this.#expire(id)));
  }

  async #expire(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry) await this.#remove(id, entry, "expire");
  }

  async #remove(id: string, entry: Entry, reason: "revoke" | "expire"): Promise<void> {
    this.#entries.delete(id);
    clearTimeout(entry.timer);
    try {
      await this.runtime.remove(entry.container);
      this.#emit({
        type: reason === "revoke" ? "preview/revoked" : "preview/expired",
        id,
        userId: entry.userId,
        occurredAt: new Date(this.now()).toISOString(),
        reason: reason === "revoke" ? "revoked" : "expired",
      });
    } catch (error) {
      this.#emit({ type: "preview/cleanup-failed", id, userId: entry.userId, occurredAt: new Date(this.now()).toISOString(), reason });
      throw error;
    }
  }

  #emit(event: PreviewAuditEvent): void {
    try { this.audit(event); } catch { /* 审计消费者故障不得破坏分享生命周期。 */ }
  }

  #assertActive(): void {
    if (this.#disposed) throw new PreviewAppError("PREVIEW_UNAVAILABLE", "Preview manager 已关闭");
  }
}

function validatePublish(command: string, port: number): void {
  if (typeof command !== "string" || !command.trim() || command.length > 8_192
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || BLOCKED_PORTS.has(port)) {
    throw new PreviewAppError("PREVIEW_INVALID_INPUT");
  }
}
