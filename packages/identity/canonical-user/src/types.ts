import type { BotId, DeploymentId, TenantId } from "dsh-lark-contracts";

declare const canonicalUserIdBrand: unique symbol;
declare const principalIdBrand: unique symbol;
declare const bindingIdBrand: unique symbol;

export type CanonicalUserId = string & { readonly [canonicalUserIdBrand]: true };
export type PrincipalId = string & { readonly [principalIdBrand]: true };
export type BindingId = string & { readonly [bindingIdBrand]: true };

export interface IdentityNamespace {
  tenantId: TenantId;
  botId: BotId;
  deploymentId: DeploymentId;
}

export type UsageIdentitySource =
  | { kind: "web"; userId: CanonicalUserId }
  | { kind: "feishu"; openId: string };

export interface WebResolveForUsageInput {
  namespace: IdentityNamespace;
  source: Extract<UsageIdentitySource, { kind: "web" }>;
  eventId?: never;
  occurredAt?: never;
}

export interface FeishuResolveForUsageInput {
  namespace: IdentityNamespace;
  source: Extract<UsageIdentitySource, { kind: "feishu" }>;
  eventId?: string;
  occurredAt?: string;
}

export type ResolveForUsageInput = WebResolveForUsageInput | FeishuResolveForUsageInput;

export interface CanonicalMembersInput {
  namespace: IdentityNamespace;
  canonicalUserId: CanonicalUserId;
}

export interface PrincipalResolution {
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  bindingVersion: number;
}

export interface BindCanonicalIdentityInput {
  namespace: IdentityNamespace;
  openId: string;
  canonicalUserId: CanonicalUserId;
  eventId: string;
  occurredAt?: string;
  expectedVersion?: number;
}

export type UnbindCanonicalIdentityInput = BindCanonicalIdentityInput;

export type CanonicalUserEventType =
  | "identity-provisioned"
  | "identity-bound"
  | "identity-unbound";

export type CanonicalUserEventOutcome = "created" | "bound" | "unbound" | "unchanged";

export interface CanonicalUserOutboxEvent {
  eventId: string;
  eventType: CanonicalUserEventType;
  outcome: CanonicalUserEventOutcome;
  namespace: IdentityNamespace;
  bindingId: BindingId;
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  bindingVersion: number;
  subjectDigest: string;
  occurredAt: string;
}

export interface CanonicalUserOutboxRecord extends CanonicalUserOutboxEvent {
  commandDigest: string;
}

export interface CanonicalMutationSuccess {
  ok: true;
  outcome: Extract<CanonicalUserEventOutcome, "bound" | "unbound" | "unchanged">;
  resolution: PrincipalResolution;
  event: CanonicalUserOutboxEvent;
}

export type CanonicalMutationFailure =
  | { ok: false; code: "EXPECTED_VERSION_MISMATCH"; currentVersion: number }
  | { ok: false; code: "IDENTITY_ALREADY_BOUND" }
  | { ok: false; code: "IDENTITY_NOT_BOUND" }
  | { ok: false; code: "CANONICAL_USER_MISMATCH" }
  | { ok: false; code: "EVENT_ID_CONFLICT" }
  | { ok: false; code: "INVALID_INPUT" };

export type CanonicalMutationResult = CanonicalMutationSuccess | CanonicalMutationFailure;

export interface CanonicalUserResolver {
  resolveForUsage(input: ResolveForUsageInput): Promise<PrincipalResolution>;
  members(input: CanonicalMembersInput): Promise<readonly PrincipalId[]>;
}

export interface CanonicalUserWriter {
  bind(input: BindCanonicalIdentityInput): Promise<CanonicalMutationResult>;
  unbind(input: UnbindCanonicalIdentityInput): Promise<CanonicalMutationResult>;
}

export interface CanonicalPrincipalRecord {
  principalId: PrincipalId;
  namespace: IdentityNamespace;
  kind: "web" | "feishu-provisional";
  canonicalUserId: CanonicalUserId | null;
  createdAt: string;
  claimedAt: string | null;
}

export interface CanonicalBindingRecord {
  bindingId: BindingId;
  namespace: IdentityNamespace;
  provider: "feishu";
  subject: string;
  principalId: PrincipalId;
  canonicalUserId: CanonicalUserId | null;
  version: number;
  validFrom: string;
  validTo: string | null;
  eventId: string;
}

export interface CanonicalUserStoreSnapshot {
  principals: CanonicalPrincipalRecord[];
  bindings: CanonicalBindingRecord[];
  outbox: CanonicalUserOutboxRecord[];
}

export type MemoryMutationCheckpoint = "after-principal" | "after-binding" | "after-outbox" | "after-command";

export class CanonicalUserError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "EVENT_ID_CONFLICT", message: string) {
    super(message);
    this.name = "CanonicalUserError";
  }
}
