import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { foldRequestHeader, type SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { inspectStoredSession } from "./persistence.js";
import {
  isSessionClaimCode,
  LarkError,
  type SessionClaimRequest,
  type SessionDirectoryCurrent,
  type SessionDirectoryEntry,
  type SessionDirectoryRequest,
  type SessionUseRequest,
} from "dsh-lark-contracts";

import {
  bindingKey,
  loadState,
  MAX_STORED_BINDINGS,
  saveState,
  scopeGenerationKey,
  type DirectoryState,
} from "./storage.js";
import type {
  LarkSessionDirectory,
  SessionClaim,
  SessionModelSelection,
  SessionResolution,
} from "./types.js";

interface ClaimRecord {
  sessionId: SessionId;
  expiresAt: number;
}

export interface FileSessionDirectoryOptions {
  filePath: string;
  persistence: Pick<SessionPersistence, "open">;
  claimTtlMs: number;
  maxEntries: number;
  now?: () => number;
  randomBytes?: () => Buffer;
}

const CODE_BYTES = 18;
const MAX_CODE_ATTEMPTS = 4;

function unavailable(): LarkError {
  return new LarkError("SESSION_NOT_AVAILABLE", "user-visible", "会话不可用或未授权");
}

function invalidClaim(): LarkError {
  return new LarkError("SESSION_CLAIM_INVALID", "user-visible", "分享码无效或已过期");
}

function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function selectionKey(input: SessionDirectoryRequest): string {
  return scopeGenerationKey(input.scope, input.sessionGeneration);
}

function copyState(state: DirectoryState): DirectoryState {
  return { version: 1, bindings: [...state.bindings], selections: [...state.selections] };
}

function modelSelection(events: Parameters<typeof foldRequestHeader>[0]): SessionModelSelection | undefined {
  const config = foldRequestHeader(events)?.config;
  if (!config) return undefined;
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
}

export class FileSessionDirectory implements LarkSessionDirectory {
  readonly #claims = new Map<string, ClaimRecord>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: Required<Omit<FileSessionDirectoryOptions, "persistence">> & {
      persistence: FileSessionDirectoryOptions["persistence"];
    },
    private state: DirectoryState,
  ) {}

  static async open(options: FileSessionDirectoryOptions): Promise<FileSessionDirectory> {
    const resolved = {
      ...options,
      now: options.now ?? Date.now,
      randomBytes: options.randomBytes ?? (() => secureRandomBytes(CODE_BYTES)),
    };
    return new FileSessionDirectory(resolved, await loadState(options.filePath));
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #pruneClaims(now: number): void {
    for (const [hash, claim] of this.#claims) {
      if (claim.expiresAt <= now) this.#claims.delete(hash);
    }
  }

  #mintCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = this.options.randomBytes().toString("base64url");
      if (isSessionClaimCode(code) && !this.#claims.has(codeHash(code))) return code;
    }
    throw new LarkError("SESSION_DIRECTORY_FAILED", "environment", "无法生成会话分享码");
  }

  async #inspect(sessionId: SessionId): Promise<Extract<SessionResolution, { mode: "shared" }>> {
    try {
      const inspection = await inspectStoredSession(this.options.persistence, sessionId);
      const cwd = inspection.meta.cwd;
      if (!cwd || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw unavailable();
      const selection = modelSelection(inspection.events);
      return { mode: "shared", sessionId, cwd, ...(selection ? { selection } : {}) };
    } catch (error) {
      if (error instanceof LarkError) throw error;
      throw unavailable();
    }
  }

  async issueClaim(sessionId: SessionId): Promise<SessionClaim> {
    await this.#inspect(sessionId);
    return this.#enqueue(async () => {
      const now = this.options.now();
      this.#pruneClaims(now);
      const code = this.#mintCode();
      const expiresAt = now + this.options.claimTtlMs;
      this.#claims.set(codeHash(code), { sessionId, expiresAt });
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  async claim(input: SessionClaimRequest): Promise<SessionDirectoryCurrent> {
    return this.#enqueue(async () => {
      const now = this.options.now();
      this.#pruneClaims(now);
      if (!isSessionClaimCode(input.code)) throw invalidClaim();
      const hash = codeHash(input.code);
      const claim = this.#claims.get(hash);
      if (!claim || claim.expiresAt <= now) throw invalidClaim();
      await this.#inspect(claim.sessionId);
      const next = this.#claimedState(input, claim.sessionId, new Date(now).toISOString());
      await saveState(this.options.filePath, next);
      this.state = next;
      this.#claims.delete(hash);
      return { mode: "shared", sessionId: claim.sessionId };
    });
  }

  #claimedState(input: SessionDirectoryRequest, sessionId: SessionId, at: string): DirectoryState {
    const next = copyState(this.state);
    next.bindings = next.bindings.filter((item) => item.sessionId !== sessionId);
    next.selections = next.selections.filter((item) => item.sessionId !== sessionId
      && scopeGenerationKey(item.scope, item.generation) !== selectionKey(input));
    if (next.bindings.length >= MAX_STORED_BINDINGS) {
      throw new LarkError("SESSION_DIRECTORY_FAILED", "environment", "会话授权目录已满");
    }
    next.bindings.push({ scope: input.scope, generation: input.sessionGeneration, sessionId, claimedAt: at, lastUsedAt: at });
    next.selections.push({ scope: input.scope, generation: input.sessionGeneration, sessionId });
    return next;
  }

  async list(input: SessionDirectoryRequest): Promise<{ sessions: SessionDirectoryEntry[] }> {
    await this.#tail;
    const key = selectionKey(input);
    const selected = this.state.selections.find((item) => (
      scopeGenerationKey(item.scope, item.generation) === key
    ))?.sessionId;
    const candidates = this.state.bindings
      .filter((item) => scopeGenerationKey(item.scope, item.generation) === key)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, this.options.maxEntries);
    const inspected = await Promise.all(candidates.map(async (item) => {
      try {
        await this.#inspect(item.sessionId);
        return {
          sessionId: item.sessionId,
          selected: item.sessionId === selected,
          claimedAt: item.claimedAt,
          lastUsedAt: item.lastUsedAt,
        };
      } catch {
        return undefined;
      }
    }));
    return { sessions: inspected.filter((item): item is SessionDirectoryEntry => item !== undefined) };
  }

  async resolve(input: SessionDirectoryRequest): Promise<SessionResolution> {
    await this.#tail;
    const key = selectionKey(input);
    const selected = this.state.selections.find((item) => (
      scopeGenerationKey(item.scope, item.generation) === key
    ));
    return selected ? this.#inspect(selected.sessionId) : { mode: "deterministic" };
  }

  async current(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    const target = await this.resolve(input);
    return target.mode === "shared" ? { mode: "shared", sessionId: target.sessionId } : target;
  }

  async use(input: SessionUseRequest): Promise<SessionDirectoryCurrent> {
    return this.#enqueue(async () => {
      const key = selectionKey(input);
      const binding = this.state.bindings.find((item) => bindingKey(item) === bindingKey({
        scope: input.scope, generation: input.sessionGeneration, sessionId: input.sessionId,
      }));
      if (!binding) throw unavailable();
      await this.#inspect(input.sessionId);
      const next = copyState(this.state);
      next.bindings = next.bindings.map((item) => item === binding
        ? { ...item, lastUsedAt: new Date(this.options.now()).toISOString() } : item);
      next.selections = next.selections.filter((item) => (
        scopeGenerationKey(item.scope, item.generation) !== key
      ));
      next.selections.push({ scope: input.scope, generation: input.sessionGeneration, sessionId: input.sessionId });
      await saveState(this.options.filePath, next);
      this.state = next;
      return { mode: "shared", sessionId: input.sessionId };
    });
  }

  async newSession(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    return this.#enqueue(async () => {
      const key = selectionKey(input);
      const next = copyState(this.state);
      next.selections = next.selections.filter((item) => (
        scopeGenerationKey(item.scope, item.generation) !== key
      ));
      if (next.selections.length !== this.state.selections.length) await saveState(this.options.filePath, next);
      this.state = next;
      return { mode: "deterministic" };
    });
  }

  async unlink(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent> {
    return this.#enqueue(async () => {
      const key = selectionKey(input);
      const selected = this.state.selections.find((item) => (
        scopeGenerationKey(item.scope, item.generation) === key
      ));
      if (!selected) return { mode: "deterministic" };
      const next = copyState(this.state);
      next.selections = next.selections.filter((item) => (
        scopeGenerationKey(item.scope, item.generation) !== key
      ));
      next.bindings = next.bindings.filter((item) => bindingKey(item) !== bindingKey(selected));
      await saveState(this.options.filePath, next);
      this.state = next;
      return { mode: "deterministic" };
    });
  }
}
