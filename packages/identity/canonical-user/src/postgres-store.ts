import { randomUUID } from "node:crypto";

import {
  parseStoredCommandResult,
  storedMutation,
  storedResolution,
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
  resolveCommandTiming,
  resolution,
  sha256,
  webKey,
  type CommandTiming,
} from "./internal.js";
import {
  findActive,
  findCommand,
  insertBinding,
  insertCommand,
  insertOutbox,
  insertPrincipal,
  integer,
  lockEvent,
  lockIdentity,
  namespaceValues,
  precedes,
  type BindingRow,
  type PrincipalRow,
} from "./postgres-queries.js";
import {
  CANONICAL_USER_TRANSACTION_EXECUTOR,
  type CanonicalUserDatabase,
  type CanonicalUserQueryExecutor,
  type CanonicalUserTransactionExecutor,
} from "./database.js";
import type {
  BindCanonicalIdentityInput,
  BindingId,
  CanonicalMembersInput,
  CanonicalMutationResult,
  CanonicalMutationSuccess,
  CanonicalUserId,
  CanonicalUserOutboxEvent,
  CanonicalUserWriter,
  IdentityNamespace,
  PrincipalId,
  PrincipalResolution,
  ResolveForUsageInput,
  UnbindCanonicalIdentityInput,
} from "./types.js";
import { CanonicalUserError } from "./types.js";

interface WriterOptions {
  now?: () => Date;
  randomUUID?: () => string;
}

interface MutationContext {
  executor: CanonicalUserTransactionExecutor;
  input: BindCanonicalIdentityInput;
  occurredAt: string;
  completedAt: string;
  digest: string;
  active: BindingRow;
}

interface EnsurePostgresInput {
  executor: CanonicalUserTransactionExecutor;
  namespace: IdentityNamespace;
  subject: string;
  eventId: string;
  occurredAt: string;
  completedAt: string;
  digest: string;
}

interface CommandCompletionInput {
  eventId: string;
  digest: string;
  result: CanonicalMutationResult;
  completedAt: string;
}

interface EventCreateInput {
  eventType: CanonicalUserOutboxEvent["eventType"];
  outcome: CanonicalUserOutboxEvent["outcome"];
  namespace: IdentityNamespace;
  bindingId: BindingId;
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  bindingVersion: number;
  subject: string;
  eventId: string;
  occurredAt: string;
}

interface WriterReplacementInput {
  context: MutationContext;
  canonicalUserId: CanonicalUserId | null;
  principalId: PrincipalId;
  eventType: "identity-bound" | "identity-unbound";
  outcome: "bound" | "unbound";
}

type PreparedMutation =
  | { kind: "ready"; context: MutationContext }
  | { kind: "replay"; result: CanonicalMutationResult }
  | { kind: "missing" };

const claimedWriterTransactions = new WeakSet<CanonicalUserTransactionExecutor>();

export class PostgresCanonicalUserResolver {
  readonly #now: () => Date;
  readonly #randomUUID: () => string;

  constructor(private readonly database: CanonicalUserDatabase, options: WriterOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? randomUUID;
  }

  async resolveForUsage(input: ResolveForUsageInput): Promise<PrincipalResolution> {
    assertRecord(input, "input");
    assertNamespace(input.namespace);
    const source = input.source;
    assertUsageSource(source);
    if (source.kind === "web") {
      assertWebResolveMetadata(input);
      try {
        return await this.database.transaction((executor) => this.resolveWeb(executor, input.namespace, source.userId));
      } catch (error) {
        throw sanitizePostgresError(error);
      }
    }
    if (input.eventId !== undefined) assertUuid(input.eventId, "eventId");
    const eventId = input.eventId ?? this.#randomUUID();
    const timing = resolveCommandTiming(input.occurredAt, this.#now);
    const digest = commandDigest({
      operation: "ensure", namespace: input.namespace, subject: source.openId,
      canonicalUserId: null, occurredAt: input.occurredAt === undefined ? null : timing.occurredAt,
    });
    try {
      return await this.database.transaction((executor) => this.ensureFeishu({
        executor, namespace: input.namespace, subject: source.openId, eventId, ...timing, digest,
      }));
    } catch (error) {
      throw sanitizePostgresError(error);
    }
  }

  async members(input: CanonicalMembersInput): Promise<readonly PrincipalId[]> {
    assertRecord(input, "input");
    assertNamespace(input.namespace);
    assertUuid(input.canonicalUserId, "canonicalUserId");
    try {
      const result = await this.database.query<PrincipalRow>(
        `SELECT principal_id, canonical_user_id, created_at FROM canonical_user_principals
         WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND canonical_user_id = $4
         ORDER BY created_at, principal_id`,
        [...namespaceValues(input.namespace), input.canonicalUserId],
      );
      return result.rows.map((row) => row.principal_id as PrincipalId);
    } catch (error) {
      throw sanitizePostgresError(error);
    }
  }

  private async resolveWeb(
    executor: CanonicalUserQueryExecutor,
    namespace: IdentityNamespace,
    canonicalUserId: CanonicalUserId,
  ): Promise<PrincipalResolution> {
    await lockIdentity(executor, webKey(namespace, canonicalUserId));
    const params = [...namespaceValues(namespace), canonicalUserId];
    const existing = await executor.query<PrincipalRow>(
      `SELECT principal_id, canonical_user_id, created_at FROM canonical_user_principals
       WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND kind = 'web' AND canonical_user_id = $4`,
      params,
    );
    if (existing.rows[0]) return resolution(existing.rows[0].principal_id as PrincipalId, canonicalUserId, 1);
    const principalId = this.#randomUUID() as PrincipalId;
    await executor.query(
      `INSERT INTO canonical_user_principals
       (principal_id, tenant_id, bot_id, deployment_id, kind, canonical_user_id, created_at, claimed_at)
       VALUES ($1,$2,$3,$4,'web',$5,$6,$6) ON CONFLICT DO NOTHING`,
      [principalId, ...namespaceValues(namespace), canonicalUserId, this.#now().toISOString()],
    );
    const stored = await executor.query<PrincipalRow>(
      `SELECT principal_id, canonical_user_id, created_at FROM canonical_user_principals
       WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND kind = 'web' AND canonical_user_id = $4`,
      params,
    );
    if (!stored.rows[0]) throw new Error("canonical-user: web principal disappeared");
    return resolution(stored.rows[0].principal_id as PrincipalId, canonicalUserId, 1);
  }

  private async ensureFeishu(input: EnsurePostgresInput): Promise<PrincipalResolution> {
    await lockEvent(input.executor, input.eventId);
    await lockIdentity(input.executor, identityKey(input.namespace, input.subject));
    const replay = await findCommand(input.executor, input.eventId);
    if (replay) {
      if (replay.command_digest !== input.digest) throw eventIdConflict();
      const stored = parseStoredCommandResult(replay.result_json);
      if (stored.kind !== "resolution") throw eventIdConflict();
      return stored.result;
    }
    const active = await findActive(input.executor, input.namespace, input.subject);
    if (active) {
      const result = resolutionFromBinding(active);
      await insertCommand(input.executor, {
        eventId: input.eventId, digest: input.digest,
        result: storedResolution(result), completedAt: input.completedAt,
      });
      return result;
    }
    const principalId = this.#randomUUID() as PrincipalId;
    const bindingId = this.#randomUUID() as BindingId;
    await insertPrincipal(input.executor, { principalId, namespace: input.namespace, canonicalUserId: null, occurredAt: input.occurredAt });
    await insertBinding(input.executor, {
      bindingId, namespace: input.namespace, subject: input.subject, principalId,
      canonicalUserId: null, version: 1, eventId: input.eventId, occurredAt: input.occurredAt,
    });
    const event = makeEvent({
      eventType: "identity-provisioned", outcome: "created", namespace: input.namespace,
      bindingId, principalId, canonicalUserId: null, bindingVersion: 1,
      subject: input.subject, eventId: input.eventId, occurredAt: input.occurredAt,
    });
    await insertOutbox(input.executor, event, input.digest);
    const result = resolutionFromEvent(event);
    await insertCommand(input.executor, {
      eventId: input.eventId, digest: input.digest,
      result: storedResolution(result), completedAt: input.completedAt,
    });
    return result;
  }
}

export function createPostgresCanonicalUserWriter(
  executor: CanonicalUserTransactionExecutor,
  options: WriterOptions = {},
): CanonicalUserWriter {
  assertTransactionExecutor(executor);
  return new PostgresCanonicalUserWriter(executor, options);
}

class PostgresCanonicalUserWriter implements CanonicalUserWriter {
  readonly #now: () => Date;
  readonly #randomUUID: () => string;

  constructor(private readonly executor: CanonicalUserTransactionExecutor, options: WriterOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? randomUUID;
  }

  async bind(input: BindCanonicalIdentityInput): Promise<CanonicalMutationResult> {
    claimWriterTransaction(this.executor);
    const validation = validateMutationInput(input, this.#now);
    if (!validation.ok) return validation.result;
    const digest = mutationDigest("bind", input, validation.timing.occurredAt);
    try {
      const prepared = await this.prepare(input, validation.timing, digest);
      if (prepared.kind === "replay") return prepared.result;
      if (prepared.kind === "missing") {
        if (input.expectedVersion !== undefined) {
          return this.complete({
            eventId: input.eventId, digest, result: { ok: false, code: "IDENTITY_NOT_BOUND" },
            completedAt: validation.timing.completedAt,
          });
        }
        return this.bindFirstContact(input, validation.timing, digest);
      }
      return this.bindActive(prepared.context);
    } catch (error) {
      throw sanitizePostgresError(error);
    }
  }

  async unbind(input: UnbindCanonicalIdentityInput): Promise<CanonicalMutationResult> {
    claimWriterTransaction(this.executor);
    const validation = validateMutationInput(input, this.#now);
    if (!validation.ok) return validation.result;
    const digest = mutationDigest("unbind", input, validation.timing.occurredAt);
    try {
      const prepared = await this.prepare(input, validation.timing, digest);
      if (prepared.kind === "replay") return prepared.result;
      if (prepared.kind === "missing") {
        return this.complete({
          eventId: input.eventId, digest, result: { ok: false, code: "IDENTITY_NOT_BOUND" },
          completedAt: validation.timing.completedAt,
        });
      }
      return this.unbindActive(prepared.context);
    } catch (error) {
      throw sanitizePostgresError(error);
    }
  }

  private async bindActive(context: MutationContext): Promise<CanonicalMutationResult> {
    const input = context.input;
    if (context.active.canonical_user_id === input.canonicalUserId) {
      return this.complete({
        eventId: input.eventId, digest: context.digest,
        result: await this.unchanged(context, "identity-bound"), completedAt: context.completedAt,
      });
    }
    if (context.active.canonical_user_id !== null) {
      return this.complete({
        eventId: input.eventId, digest: context.digest,
        result: { ok: false, code: "IDENTITY_ALREADY_BOUND" }, completedAt: context.completedAt,
      });
    }
    const claimed = await this.executor.query<{ canonical_user_id: string | null }>(
      "SELECT canonical_user_id FROM canonical_user_principals WHERE principal_id = $1 FOR UPDATE",
      [context.active.principal_id],
    );
    const owner = claimed.rows[0]?.canonical_user_id ?? null;
    if (owner !== null && owner !== input.canonicalUserId) {
      return this.complete({
        eventId: input.eventId, digest: context.digest,
        result: { ok: false, code: "IDENTITY_ALREADY_BOUND" }, completedAt: context.completedAt,
      });
    }
    await this.executor.query(
      "UPDATE canonical_user_principals SET canonical_user_id = $2, claimed_at = COALESCE(claimed_at, $3) WHERE principal_id = $1",
      [context.active.principal_id, input.canonicalUserId, context.occurredAt],
    );
    const result = await this.replace({
      context, canonicalUserId: input.canonicalUserId,
      principalId: context.active.principal_id as PrincipalId,
      eventType: "identity-bound", outcome: "bound",
    });
    return this.complete({
      eventId: input.eventId, digest: context.digest, result, completedAt: context.completedAt,
    });
  }

  private async unbindActive(context: MutationContext): Promise<CanonicalMutationResult> {
    const input = context.input;
    if (context.active.canonical_user_id === null) {
      return this.complete({
        eventId: input.eventId, digest: context.digest,
        result: await this.unchanged(context, "identity-unbound"), completedAt: context.completedAt,
      });
    }
    if (context.active.canonical_user_id !== input.canonicalUserId) {
      return this.complete({
        eventId: input.eventId, digest: context.digest,
        result: { ok: false, code: "CANONICAL_USER_MISMATCH" }, completedAt: context.completedAt,
      });
    }
    const principalId = this.#randomUUID() as PrincipalId;
    await insertPrincipal(this.executor, {
      principalId, namespace: input.namespace, canonicalUserId: null, occurredAt: context.occurredAt,
    });
    const result = await this.replace({
      context, canonicalUserId: null, principalId, eventType: "identity-unbound", outcome: "unbound",
    });
    return this.complete({
      eventId: input.eventId, digest: context.digest, result, completedAt: context.completedAt,
    });
  }

  private async prepare(
    input: BindCanonicalIdentityInput,
    timing: CommandTiming,
    digest: string,
  ): Promise<PreparedMutation> {
    const { occurredAt, completedAt } = timing;
    await lockEvent(this.executor, input.eventId);
    await lockIdentity(this.executor, identityKey(input.namespace, input.openId));
    const replay = await findCommand(this.executor, input.eventId);
    if (replay) {
      if (replay.command_digest !== digest) return { kind: "replay", result: { ok: false, code: "EVENT_ID_CONFLICT" } };
      const stored = parseStoredCommandResult(replay.result_json);
      return stored.kind === "mutation"
        ? { kind: "replay", result: stored.result }
        : { kind: "replay", result: { ok: false, code: "EVENT_ID_CONFLICT" } };
    }
    const active = await findActive(this.executor, input.namespace, input.openId);
    if (!active) return { kind: "missing" };
    if (precedes(occurredAt, active.valid_from)) {
      const result = await this.complete({
        eventId: input.eventId, digest, result: { ok: false, code: "INVALID_INPUT" }, completedAt,
      });
      return { kind: "replay", result };
    }
    if (input.expectedVersion !== undefined && integer(active.version) !== input.expectedVersion) {
      const failure = { ok: false, code: "EXPECTED_VERSION_MISMATCH", currentVersion: integer(active.version) } as const;
      return {
        kind: "replay",
        result: await this.complete({ eventId: input.eventId, digest, result: failure, completedAt }),
      };
    }
    return { kind: "ready", context: { executor: this.executor, input, ...timing, digest, active } };
  }

  private async bindFirstContact(
    input: BindCanonicalIdentityInput,
    timing: CommandTiming,
    digest: string,
  ): Promise<CanonicalMutationResult> {
    const { occurredAt, completedAt } = timing;
    const principalId = this.#randomUUID() as PrincipalId;
    const bindingId = this.#randomUUID() as BindingId;
    await insertPrincipal(this.executor, {
      principalId, namespace: input.namespace, canonicalUserId: input.canonicalUserId, occurredAt,
    });
    await insertBinding(this.executor, {
      bindingId, namespace: input.namespace, subject: input.openId, principalId,
      canonicalUserId: input.canonicalUserId, version: 1, eventId: input.eventId, occurredAt,
    });
    const event = makeEvent({
      eventType: "identity-bound", outcome: "bound", namespace: input.namespace,
      bindingId, principalId, canonicalUserId: input.canonicalUserId, bindingVersion: 1,
      subject: input.openId, eventId: input.eventId, occurredAt,
    });
    await insertOutbox(this.executor, event, digest);
    return this.complete({
      eventId: input.eventId, digest, result: mutationSuccess("bound", event), completedAt,
    });
  }

  private async complete(input: CommandCompletionInput): Promise<CanonicalMutationResult> {
    await insertCommand(this.executor, { ...input, result: storedMutation(input.result) });
    return input.result;
  }

  private async replace(input: WriterReplacementInput): Promise<CanonicalMutationSuccess> {
    await this.executor.query(
      "UPDATE canonical_user_bindings SET valid_to = $2 WHERE binding_id = $1 AND valid_to IS NULL",
      [input.context.active.binding_id, input.context.occurredAt],
    );
    const bindingId = this.#randomUUID() as BindingId;
    const version = integer(input.context.active.version) + 1;
    await insertBinding(this.executor, {
      bindingId, namespace: input.context.input.namespace, subject: input.context.input.openId,
      principalId: input.principalId, canonicalUserId: input.canonicalUserId, version,
      eventId: input.context.input.eventId, occurredAt: input.context.occurredAt,
    });
    const event = makeEvent({
      eventType: input.eventType, outcome: input.outcome, namespace: input.context.input.namespace,
      bindingId, principalId: input.principalId, canonicalUserId: input.canonicalUserId,
      bindingVersion: version, subject: input.context.input.openId,
      eventId: input.context.input.eventId, occurredAt: input.context.occurredAt,
    });
    await insertOutbox(this.executor, event, input.context.digest);
    return mutationSuccess(input.outcome, event);
  }

  private async unchanged(
    context: MutationContext,
    eventType: "identity-bound" | "identity-unbound",
  ): Promise<CanonicalMutationSuccess> {
    const event = makeEvent({
      eventType, outcome: "unchanged", namespace: context.input.namespace,
      bindingId: context.active.binding_id as BindingId,
      principalId: context.active.principal_id as PrincipalId,
      canonicalUserId: context.active.canonical_user_id as CanonicalUserId | null,
      bindingVersion: integer(context.active.version), subject: context.input.openId,
      eventId: context.input.eventId, occurredAt: context.occurredAt,
    });
    await insertOutbox(this.executor, event, context.digest);
    return mutationSuccess("unchanged", event);
  }
}

function assertTransactionExecutor(executor: CanonicalUserTransactionExecutor): void {
  if (executor[CANONICAL_USER_TRANSACTION_EXECUTOR] !== true) {
    throw new Error("canonical-user: Writer requires a transaction executor");
  }
}

function claimWriterTransaction(executor: CanonicalUserTransactionExecutor): void {
  if (claimedWriterTransactions.has(executor)) {
    throw new Error("canonical-user: transaction supports one command");
  }
  claimedWriterTransactions.add(executor);
}

function makeEvent(input: EventCreateInput): CanonicalUserOutboxEvent {
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    outcome: input.outcome,
    namespace: cloneNamespace(input.namespace),
    bindingId: input.bindingId,
    principalId: input.principalId,
    canonicalUserId: input.canonicalUserId,
    bindingVersion: input.bindingVersion,
    subjectDigest: sha256(input.subject),
    occurredAt: input.occurredAt,
  };
}

function mutationSuccess(
  outcome: CanonicalMutationSuccess["outcome"],
  event: CanonicalUserOutboxEvent,
): CanonicalMutationSuccess {
  return { ok: true, outcome, resolution: resolutionFromEvent(event), event };
}

function resolutionFromEvent(event: CanonicalUserOutboxEvent): PrincipalResolution {
  return resolution(event.principalId, event.canonicalUserId, event.bindingVersion);
}

function resolutionFromBinding(row: BindingRow): PrincipalResolution {
  return resolution(row.principal_id as PrincipalId, row.canonical_user_id as CanonicalUserId | null, integer(row.version));
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

function eventIdConflict(): CanonicalUserError {
  return new CanonicalUserError("EVENT_ID_CONFLICT", "canonical-user: eventId 已用于其他命令");
}

function sanitizePostgresError(error: unknown): Error {
  if (error instanceof CanonicalUserError) return error;
  const code = sqlState(error);
  return new Error(`canonical-user: PostgreSQL operation failed${code ? ` (${code})` : ""}`);
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
