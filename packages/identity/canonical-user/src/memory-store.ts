import { randomUUID } from "node:crypto";

import {
  parseStoredCommandResult,
  storedMutation,
  storedResolution,
  type StoredCommandResult,
} from "./command-journal.js";
import {
  assertExpectedVersion,
  assertExternalId,
  assertNamespace,
  assertRecord,
  assertUsageSource,
  assertUuid,
  assertWebResolveMetadata,
  cloneNamespace,
  commandDigest,
  identityKey,
  namespaceKey,
  resolveCommandTiming,
  resolution,
  sha256,
  webKey,
  type CommandTiming,
} from "./internal.js";
import type {
  BindCanonicalIdentityInput,
  BindingId,
  CanonicalBindingRecord,
  CanonicalMembersInput,
  CanonicalMutationResult,
  CanonicalMutationSuccess,
  CanonicalPrincipalRecord,
  CanonicalUserId,
  CanonicalUserOutboxEvent,
  CanonicalUserOutboxRecord,
  CanonicalUserStoreSnapshot,
  CanonicalUserWriter,
  IdentityNamespace,
  MemoryMutationCheckpoint,
  PrincipalId,
  PrincipalResolution,
  ResolveForUsageInput,
  UnbindCanonicalIdentityInput,
} from "./types.js";
import { CanonicalUserError } from "./types.js";

interface MemoryState {
  principals: Map<PrincipalId, CanonicalPrincipalRecord>;
  bindings: Map<BindingId, CanonicalBindingRecord>;
  outbox: Map<string, CanonicalUserOutboxRecord>;
  commands: Map<string, MemoryCommandRecord>;
}

interface MemoryCommandRecord {
  digest: string;
  result: StoredCommandResult;
  completedAt: string;
}

interface MemoryMutationCompletion {
  digest: string;
  result: CanonicalMutationResult;
  completedAt: string;
}

export interface MemoryCanonicalUserStoreOptions {
  now?: () => Date;
  randomUUID?: () => string;
  checkpoint?: (checkpoint: MemoryMutationCheckpoint) => void;
}

interface EnsureFeishuInput {
  namespace: IdentityNamespace;
  subject: string;
  eventId: string;
  occurredAt: string;
  completedAt: string;
  digest: string;
}

interface PrincipalCreateInput {
  namespace: IdentityNamespace;
  kind: CanonicalPrincipalRecord["kind"];
  canonicalUserId: CanonicalUserId | null;
  createdAt: string;
}

interface BindingCreateInput {
  namespace: IdentityNamespace;
  subject: string;
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  version: number;
  eventId: string;
  validFrom: string;
}

interface BindingTransitionInput {
  active: CanonicalBindingRecord;
  canonicalUserId: CanonicalUserId | null;
  eventId: string;
  occurredAt: string;
  digest: string;
  eventType: "identity-bound" | "identity-unbound";
  outcome: "bound" | "unbound";
  principalId?: PrincipalId;
}

interface OutboxCreateInput {
  eventType: CanonicalUserOutboxEvent["eventType"];
  outcome: CanonicalUserOutboxEvent["outcome"];
  binding: CanonicalBindingRecord;
  digest: string;
  occurredAt: string;
}

interface UnchangedTransitionInput {
  eventType: "identity-bound" | "identity-unbound";
  active: CanonicalBindingRecord;
  digest: string;
  eventId: string;
  occurredAt: string;
}

/** 无密钥测试 Provider；与 PostgreSQL Store 使用同一 interval/claim 状态机。 */
export class MemoryCanonicalUserStore implements CanonicalUserWriter {
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #checkpoint: (checkpoint: MemoryMutationCheckpoint) => void;
  #state: MemoryState = emptyState();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryCanonicalUserStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#checkpoint = options.checkpoint ?? (() => undefined);
  }

  async resolveForUsage(input: ResolveForUsageInput): Promise<PrincipalResolution> {
    assertRecord(input, "input");
    assertNamespace(input.namespace);
    const source = input.source;
    assertUsageSource(source);
    if (source.kind === "web") {
      assertWebResolveMetadata(input);
      return this.exclusive(() => this.resolveWeb(input.namespace, source.userId));
    }
    if (input.eventId !== undefined) assertUuid(input.eventId, "eventId");
    const eventId = input.eventId ?? this.#randomUUID();
    const timing = resolveCommandTiming(input.occurredAt, this.#now);
    const digest = commandDigest({
      operation: "ensure", namespace: input.namespace, subject: source.openId,
      canonicalUserId: null, occurredAt: input.occurredAt === undefined ? null : timing.occurredAt,
    });
    return this.mutate(() => this.ensureFeishu({
      namespace: input.namespace, subject: source.openId, eventId, ...timing, digest,
    }));
  }

  async members(input: CanonicalMembersInput): Promise<readonly PrincipalId[]> {
    assertRecord(input, "input");
    assertNamespace(input.namespace);
    assertUuid(input.canonicalUserId, "canonicalUserId");
    return this.exclusive(() => [...this.#state.principals.values()]
      .filter((item) => namespaceKey(item.namespace) === namespaceKey(input.namespace))
      .filter((item) => item.canonicalUserId === input.canonicalUserId)
      .sort(comparePrincipals)
      .map((item) => item.principalId));
  }

  async bind(input: BindCanonicalIdentityInput): Promise<CanonicalMutationResult> {
    const validation = validateMutationInput(input, this.#now);
    if (!validation.ok) return validation.result;
    return this.mutate(() => this.bindIdentity(input, validation.timing));
  }

  async unbind(input: UnbindCanonicalIdentityInput): Promise<CanonicalMutationResult> {
    const validation = validateMutationInput(input, this.#now);
    if (!validation.ok) return validation.result;
    return this.mutate(() => this.unbindIdentity(input, validation.timing));
  }

  snapshot(): CanonicalUserStoreSnapshot {
    return {
      principals: [...this.#state.principals.values()].map(clonePrincipal).sort(comparePrincipals),
      bindings: [...this.#state.bindings.values()].map(cloneBinding).sort((a, b) => a.version - b.version),
      outbox: [...this.#state.outbox.values()].map(cloneOutbox).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    };
  }

  private resolveWeb(namespace: IdentityNamespace, canonicalUserId: CanonicalUserId): PrincipalResolution {
    const key = webKey(namespace, canonicalUserId);
    const existing = [...this.#state.principals.values()].find((item) => item.kind === "web" && webKey(item.namespace, item.canonicalUserId!) === key);
    if (existing) return resolution(existing.principalId, canonicalUserId, 1);
    const principal = this.newPrincipal({ namespace, kind: "web", canonicalUserId, createdAt: this.#now().toISOString() });
    this.#state.principals.set(principal.principalId, principal);
    return resolution(principal.principalId, canonicalUserId, 1);
  }

  private ensureFeishu(input: EnsureFeishuInput): PrincipalResolution {
    const replay = this.#state.commands.get(input.eventId);
    if (replay) {
      if (replay.digest !== input.digest || replay.result.kind !== "resolution") {
        throw new CanonicalUserError("EVENT_ID_CONFLICT", "canonical-user: eventId 已用于其他命令");
      }
      return parseStoredCommandResult(replay.result).result as PrincipalResolution;
    }
    const active = this.activeBinding(input.namespace, input.subject);
    if (active) {
      const result = resolution(active.principalId, active.canonicalUserId, active.version);
      this.recordCommand(input.eventId, {
        digest: input.digest, result: storedResolution(result), completedAt: input.completedAt,
      });
      return result;
    }
    const principal = this.newPrincipal({ namespace: input.namespace, kind: "feishu-provisional", canonicalUserId: null, createdAt: input.occurredAt });
    this.#state.principals.set(principal.principalId, principal);
    this.#checkpoint("after-principal");
    const binding = this.newBinding({
      namespace: input.namespace, subject: input.subject, principalId: principal.principalId,
      canonicalUserId: null, version: 1, eventId: input.eventId, validFrom: input.occurredAt,
    });
    this.#state.bindings.set(binding.bindingId, binding);
    this.#checkpoint("after-binding");
    this.recordOutbox({ eventType: "identity-provisioned", outcome: "created", binding, digest: input.digest, occurredAt: input.occurredAt });
    this.#checkpoint("after-outbox");
    const result = resolution(principal.principalId, null, 1);
    this.recordCommand(input.eventId, {
      digest: input.digest, result: storedResolution(result), completedAt: input.completedAt,
    });
    return result;
  }

  private bindIdentity(input: BindCanonicalIdentityInput, timing: CommandTiming): CanonicalMutationResult {
    const { occurredAt, completedAt } = timing;
    const digest = mutationDigest("bind", input, occurredAt);
    const replay = this.replayMutation(input.eventId, digest);
    if (replay) return replay;
    const active = this.activeBinding(input.namespace, input.openId);
    if (!active) {
      if (input.expectedVersion === undefined) return this.bindFirstContact(input, timing, digest);
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "IDENTITY_NOT_BOUND" }, completedAt,
      });
    }
    if (precedes(occurredAt, active.validFrom)) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "INVALID_INPUT" }, completedAt,
      });
    }
    const mismatch = versionMismatch(active.version, input.expectedVersion);
    if (mismatch) return this.finishMutation(input.eventId, { digest, result: mismatch, completedAt });
    if (active.canonicalUserId === input.canonicalUserId) {
      const result = this.unchanged({ eventType: "identity-bound", active, digest, eventId: input.eventId, occurredAt });
      return this.finishMutation(input.eventId, { digest, result, completedAt });
    }
    if (active.canonicalUserId !== null) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "IDENTITY_ALREADY_BOUND" }, completedAt,
      });
    }
    const principal = this.#state.principals.get(active.principalId)!;
    if (principal.canonicalUserId && principal.canonicalUserId !== input.canonicalUserId) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "IDENTITY_ALREADY_BOUND" }, completedAt,
      });
    }
    this.#state.principals.set(principal.principalId, { ...principal, canonicalUserId: input.canonicalUserId, claimedAt: occurredAt });
    const result = this.replaceBinding({ active, canonicalUserId: input.canonicalUserId, eventId: input.eventId, occurredAt, digest, eventType: "identity-bound", outcome: "bound" });
    return this.finishMutation(input.eventId, { digest, result, completedAt });
  }

  private unbindIdentity(input: UnbindCanonicalIdentityInput, timing: CommandTiming): CanonicalMutationResult {
    const { occurredAt, completedAt } = timing;
    const digest = mutationDigest("unbind", input, occurredAt);
    const replay = this.replayMutation(input.eventId, digest);
    if (replay) return replay;
    const active = this.activeBinding(input.namespace, input.openId);
    if (!active) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "IDENTITY_NOT_BOUND" }, completedAt,
      });
    }
    if (precedes(occurredAt, active.validFrom)) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "INVALID_INPUT" }, completedAt,
      });
    }
    const mismatch = versionMismatch(active.version, input.expectedVersion);
    if (mismatch) return this.finishMutation(input.eventId, { digest, result: mismatch, completedAt });
    if (active.canonicalUserId === null) {
      const result = this.unchanged({ eventType: "identity-unbound", active, digest, eventId: input.eventId, occurredAt });
      return this.finishMutation(input.eventId, { digest, result, completedAt });
    }
    if (active.canonicalUserId !== input.canonicalUserId) {
      return this.finishMutation(input.eventId, {
        digest, result: { ok: false, code: "CANONICAL_USER_MISMATCH" }, completedAt,
      });
    }
    const principal = this.newPrincipal({ namespace: input.namespace, kind: "feishu-provisional", canonicalUserId: null, createdAt: occurredAt });
    this.#state.principals.set(principal.principalId, principal);
    this.#checkpoint("after-principal");
    const result = this.replaceBinding({ active, canonicalUserId: null, eventId: input.eventId, occurredAt, digest, eventType: "identity-unbound", outcome: "unbound", principalId: principal.principalId });
    return this.finishMutation(input.eventId, { digest, result, completedAt });
  }

  private bindFirstContact(
    input: BindCanonicalIdentityInput,
    timing: CommandTiming,
    digest: string,
  ): CanonicalMutationResult {
    const { occurredAt, completedAt } = timing;
    const principal = this.newPrincipal({
      namespace: input.namespace, kind: "feishu-provisional",
      canonicalUserId: input.canonicalUserId, createdAt: occurredAt,
    });
    this.#state.principals.set(principal.principalId, principal);
    this.#checkpoint("after-principal");
    const binding = this.newBinding({
      namespace: input.namespace, subject: input.openId, principalId: principal.principalId,
      canonicalUserId: input.canonicalUserId, version: 1, eventId: input.eventId, validFrom: occurredAt,
    });
    this.#state.bindings.set(binding.bindingId, binding);
    this.#checkpoint("after-binding");
    const event = this.recordOutbox({ eventType: "identity-bound", outcome: "bound", binding, digest, occurredAt });
    this.#checkpoint("after-outbox");
    return this.finishMutation(input.eventId, {
      digest, result: success("bound", event), completedAt,
    });
  }

  private replaceBinding(input: BindingTransitionInput): CanonicalMutationSuccess {
    this.#state.bindings.set(input.active.bindingId, { ...input.active, validTo: input.occurredAt });
    const next = this.newBinding({
      namespace: input.active.namespace,
      subject: input.active.subject,
      principalId: input.principalId ?? input.active.principalId,
      canonicalUserId: input.canonicalUserId,
      version: input.active.version + 1,
      eventId: input.eventId,
      validFrom: input.occurredAt,
    });
    this.#state.bindings.set(next.bindingId, next);
    this.#checkpoint("after-binding");
    const event = this.recordOutbox({
      eventType: input.eventType, outcome: input.outcome, binding: next,
      digest: input.digest, occurredAt: input.occurredAt,
    });
    this.#checkpoint("after-outbox");
    return success(input.outcome, event);
  }

  private unchanged(input: UnchangedTransitionInput): CanonicalMutationSuccess {
    const event = this.recordOutbox({
      eventType: input.eventType,
      outcome: "unchanged",
      binding: { ...input.active, eventId: input.eventId },
      digest: input.digest,
      occurredAt: input.occurredAt,
    });
    this.#checkpoint("after-outbox");
    return success("unchanged", event);
  }

  private replayMutation(eventId: string, digest: string): CanonicalMutationResult | undefined {
    const record = this.#state.commands.get(eventId);
    if (!record) return undefined;
    if (record.digest !== digest || record.result.kind !== "mutation") return { ok: false, code: "EVENT_ID_CONFLICT" };
    return parseStoredCommandResult(record.result).result as CanonicalMutationResult;
  }

  private finishMutation(eventId: string, completion: MemoryMutationCompletion): CanonicalMutationResult {
    this.recordCommand(eventId, { ...completion, result: storedMutation(completion.result) });
    return completion.result;
  }

  private recordCommand(eventId: string, record: MemoryCommandRecord): void {
    this.#state.commands.set(eventId, { ...record, result: parseStoredCommandResult(record.result) });
    this.#checkpoint("after-command");
  }

  private activeBinding(namespace: IdentityNamespace, subject: string): CanonicalBindingRecord | undefined {
    const key = identityKey(namespace, subject);
    return [...this.#state.bindings.values()].find((item) => item.validTo === null && identityKey(item.namespace, item.subject) === key);
  }

  private newPrincipal(input: PrincipalCreateInput): CanonicalPrincipalRecord {
    return {
      principalId: this.#randomUUID() as PrincipalId,
      namespace: cloneNamespace(input.namespace),
      kind: input.kind,
      canonicalUserId: input.canonicalUserId,
      createdAt: input.createdAt,
      claimedAt: input.canonicalUserId === null ? null : input.createdAt,
    };
  }

  private newBinding(input: BindingCreateInput): CanonicalBindingRecord {
    return {
      bindingId: this.#randomUUID() as BindingId,
      namespace: cloneNamespace(input.namespace), provider: "feishu", subject: input.subject,
      principalId: input.principalId, canonicalUserId: input.canonicalUserId,
      version: input.version, validFrom: input.validFrom, validTo: null, eventId: input.eventId,
    };
  }

  private recordOutbox(input: OutboxCreateInput): CanonicalUserOutboxEvent {
    const event: CanonicalUserOutboxEvent = {
      eventId: input.binding.eventId, eventType: input.eventType, outcome: input.outcome,
      namespace: cloneNamespace(input.binding.namespace), bindingId: input.binding.bindingId,
      principalId: input.binding.principalId, canonicalUserId: input.binding.canonicalUserId,
      bindingVersion: input.binding.version, subjectDigest: sha256(input.binding.subject), occurredAt: input.occurredAt,
    };
    this.#state.outbox.set(event.eventId, { ...event, commandDigest: input.digest });
    return event;
  }

  private mutate<T>(run: () => T): Promise<T> {
    return this.exclusive(() => {
      const before = cloneState(this.#state);
      try {
        return run();
      } catch (error) {
        this.#state = before;
        throw error;
      }
    });
  }

  private exclusive<T>(run: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(run, run).finally(release);
  }
}

function validateMutationInput(
  input: BindCanonicalIdentityInput,
  now: () => Date,
): { ok: true; timing: CommandTiming } | { ok: false; result: CanonicalMutationResult } {
  try {
    assertRecord(input, "input");
    assertNamespace(input.namespace);
    assertExternalId(input.openId, "openId");
    assertUuid(input.canonicalUserId, "canonicalUserId");
    assertUuid(input.eventId, "eventId");
    assertExpectedVersion(input.expectedVersion);
    return { ok: true, timing: resolveCommandTiming(input.occurredAt, now) };
  } catch (error) {
    if (error instanceof CanonicalUserError && error.code === "INVALID_INPUT") {
      return { ok: false, result: { ok: false, code: "INVALID_INPUT" } };
    }
    throw error;
  }
}

function versionMismatch(version: number, expected: number | undefined): CanonicalMutationResult | undefined {
  return expected !== undefined && version !== expected
    ? { ok: false, code: "EXPECTED_VERSION_MISMATCH", currentVersion: version }
    : undefined;
}

function success(outcome: CanonicalMutationSuccess["outcome"], event: CanonicalUserOutboxEvent): CanonicalMutationSuccess {
  return {
    ok: true,
    outcome,
    resolution: resolution(event.principalId, event.canonicalUserId, event.bindingVersion),
    event,
  };
}

function emptyState(): MemoryState {
  return { principals: new Map(), bindings: new Map(), outbox: new Map(), commands: new Map() };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    principals: new Map([...state.principals].map(([key, value]) => [key, clonePrincipal(value)])),
    bindings: new Map([...state.bindings].map(([key, value]) => [key, cloneBinding(value)])),
    outbox: new Map([...state.outbox].map(([key, value]) => [key, cloneOutbox(value)])),
    commands: new Map([...state.commands].map(([key, value]) => [key, cloneCommand(value)])),
  };
}

function cloneCommand(value: MemoryCommandRecord): MemoryCommandRecord {
  return { ...value, result: parseStoredCommandResult(value.result) };
}

function mutationDigest(
  operation: "bind" | "unbind",
  input: BindCanonicalIdentityInput,
  occurredAt: string,
): string {
  return commandDigest({
    operation, namespace: input.namespace, subject: input.openId,
    canonicalUserId: input.canonicalUserId, expectedVersion: input.expectedVersion,
    occurredAt: input.occurredAt === undefined ? null : occurredAt,
  });
}

function precedes(occurredAt: string, validFrom: string): boolean {
  return new Date(occurredAt).getTime() < new Date(validFrom).getTime();
}

function clonePrincipal(value: CanonicalPrincipalRecord): CanonicalPrincipalRecord {
  return { ...value, namespace: cloneNamespace(value.namespace) };
}

function cloneBinding(value: CanonicalBindingRecord): CanonicalBindingRecord {
  return { ...value, namespace: cloneNamespace(value.namespace) };
}

function cloneOutbox(value: CanonicalUserOutboxRecord): CanonicalUserOutboxRecord {
  return { ...value, namespace: cloneNamespace(value.namespace) };
}

function comparePrincipals(left: CanonicalPrincipalRecord, right: CanonicalPrincipalRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.principalId.localeCompare(right.principalId);
}
