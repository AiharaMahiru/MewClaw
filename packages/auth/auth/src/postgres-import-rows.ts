import type { QueryResultRow } from "pg";

import type {
  AuthImportSource,
  AuthUserImportResult,
} from "./capability.js";

export type MappingResult = AuthUserImportResult["result"] | "claimed" | "unchanged";
export type TargetType = "user" | "session" | "workspace";

export interface PersistedAuthUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  defaultMode: "full" | "lightweight";
  status: "pending" | "active" | "disabled";
  createdAt: string;
}

export interface AuthImportMapping extends AuthImportSource {
  runId: string;
  planId: string;
  targetType: TargetType;
  targetId: string | null;
  targetUserId: string | null;
  result: MappingResult;
  reasonCode: string | null;
  createdTarget: boolean;
  createdAt: string;
  rolledBackAt: string | null;
}

export interface PersistedResource {
  resourceType: "session" | "workspace";
  resourceId: string;
  userId: string;
}

type Row = Record<string, unknown> & QueryResultRow;

export function userFromRow(row: Row): PersistedAuthUser {
  return {
    id: text(row.id),
    email: text(row.email_normalized),
    displayName: text(row.display_name),
    role: row.role === "admin" ? "admin" : "user",
    defaultMode: row.default_mode === "full" ? "full" : "lightweight",
    status: row.status === "pending" || row.status === "disabled" ? row.status : "active",
    createdAt: instant(row.created_at),
  };
}

export function mappingFromRow(row: Row): AuthImportMapping {
  return {
    sourceSystem: text(row.source_system),
    sourceType: text(row.source_type) as AuthImportSource["sourceType"],
    sourceId: text(row.source_id),
    sourceDigest: text(row.source_digest),
    runId: text(row.run_id),
    planId: text(row.plan_id),
    targetType: text(row.target_type) as TargetType,
    targetId: nullableText(row.target_id),
    targetUserId: nullableText(row.target_user_id),
    result: text(row.result) as MappingResult,
    reasonCode: nullableText(row.reason_code),
    createdTarget: row.created_target === true,
    createdAt: instant(row.created_at),
    rolledBackAt: row.rolled_back_at ? instant(row.rolled_back_at) : null,
  };
}

export function resourceFromRow(row: Row): PersistedResource {
  return {
    resourceType: row.resource_type === "workspace" ? "workspace" : "session",
    resourceId: text(row.resource_id),
    userId: text(row.user_id),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function instant(value: unknown): string {
  return new Date(text(value)).toISOString();
}
