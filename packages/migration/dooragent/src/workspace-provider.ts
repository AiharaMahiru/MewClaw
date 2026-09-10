import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import {
  checkWorkspaceRollbackGuard,
  copyWorkspaceTree,
  removeWorkspaceTree,
} from "./workspace-copy.js";
import type { DoorAgentRole, WorkspaceAggregate } from "./types.js";

export interface WorkspaceMigrationProvider {
  migrate(input: {
    sourcePath: string;
    targetUserId: string;
    role: "admin" | "user";
    aggregate: WorkspaceAggregate;
    signal?: AbortSignal;
  }): Promise<WorkspaceMigrationResult>;
  rollback(input: WorkspaceRollbackInput): Promise<WorkspaceRollbackResult>;
}

export interface WorkspaceRollbackInput {
  sourcePath: string;
  targetUserId: string;
  role: DoorAgentRole;
  aggregate: WorkspaceAggregate;
  targetWorkspaceId: string;
  result: "migrated" | "merged";
  createdTarget: boolean;
  cutoverEpochId: string;
  expectedCutoverEpochId: string;
  signal?: AbortSignal;
}

export interface WorkspaceRollbackResult {
  result: "rolled-back" | "retained" | "rejected";
  reasonCode: string | null;
}

export interface WorkspaceMigrationResult {
  result: "migrated" | "merged";
  workspaceId: string;
  path: string;
}

export interface OfficialWorkspaceProviderOptions {
  baseUrl: string;
  token: string;
  userRoot: string;
  adminRoot: string;
  fetch?: typeof fetch;
}

export function createOfficialWorkspaceProvider(
  options: OfficialWorkspaceProviderOptions,
): WorkspaceMigrationProvider {
  const request = options.fetch ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const userRoot = absoluteRoot(options.userRoot);
  const adminRoot = absoluteRoot(options.adminRoot);
  if (!options.token || /\s/.test(options.token)) throw new Error("WORKSPACE_PROVIDER_TOKEN_INVALID");
  return {
    async migrate(input) {
      const root = input.role === "admin" ? adminRoot : userRoot;
      const targetPath = resolve(root, input.targetUserId);
      if (!within(root, targetPath) || targetPath === root) throw new DoorAgentMigrationError("PATH_ESCAPE");
      const copy = await copyWorkspaceTree(input.sourcePath, targetPath, input.aggregate, input.signal);
      throwIfAborted(input.signal);
      const workspace = await createOfficialWorkspace(request, baseUrl, options.token, targetPath, input.signal);
      return { result: copy.result, workspaceId: workspace.workspaceId, path: workspace.path };
    },
    async rollback(input) {
      const root = input.role === "admin" ? adminRoot : userRoot;
      const targetPath = resolve(root, input.targetUserId);
      if (!within(root, targetPath) || targetPath === root) return rejected("ROLLBACK_TARGET_UNSAFE");
      if (input.cutoverEpochId !== input.expectedCutoverEpochId) return rejected("ROLLBACK_EPOCH_MISMATCH");
      if (!input.createdTarget || input.result !== "migrated") return retained("MERGED_TARGET");
      const firstGuard = await checkWorkspaceRollbackGuard(
        input.sourcePath,
        targetPath,
        input.aggregate,
        input.signal,
      );
      if (firstGuard.result !== "rolled-back") return firstGuard;
      throwIfAborted(input.signal);
      await deleteOfficialWorkspace(request, baseUrl, options.token, input.targetWorkspaceId, input.signal);
      const secondGuard = await checkWorkspaceRollbackGuard(
        input.sourcePath,
        targetPath,
        input.aggregate,
        input.signal,
      );
      if (secondGuard.result === "rejected" && secondGuard.reasonCode === "ROLLBACK_TARGET_MISSING") {
        return { result: "rolled-back", reasonCode: null };
      }
      if (secondGuard.result !== "rolled-back") return secondGuard;
      return removeWorkspaceTree(targetPath);
    },
  };
}

async function createOfficialWorkspace(
  request: typeof fetch,
  baseUrl: string,
  token: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ workspaceId: string; path: string }> {
  const rpcId = randomUUID();
  const response = await request(`${baseUrl}/api/workspace.create`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method: "workspace.create", payload: { path } }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`WORKSPACE_PROVIDER_HTTP_${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  const result = body.result;
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value) || !isRecord(result.value.workspace)) {
    throw new Error("WORKSPACE_PROVIDER_RESPONSE_INVALID");
  }
  if (body.rpcId !== rpcId) throw new Error("WORKSPACE_PROVIDER_RPC_ID_MISMATCH");
  const workspace = result.value.workspace;
  const workspaceId = text(workspace.workspaceId);
  const actualPath = text(workspace.path);
  if (!workspaceId || /\s/.test(workspaceId) || actualPath !== path) throw new Error("WORKSPACE_PROVIDER_RESPONSE_INVALID");
  return { workspaceId, path: actualPath };
}

async function deleteOfficialWorkspace(
  request: typeof fetch,
  baseUrl: string,
  token: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  const rpcId = randomUUID();
  const response = await request(`${baseUrl}/api/workspace.delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "workspace.delete",
      payload: { workspaceId },
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`WORKSPACE_PROVIDER_HTTP_${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  if (body.rpcId !== rpcId || !isSuccessfulResult(body.result)) {
    throw new Error("WORKSPACE_PROVIDER_RESPONSE_INVALID");
  }
}

function normalizeBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    if (parsed.username || parsed.password) throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error("WORKSPACE_PROVIDER_URL_INVALID");
  }
}

function absoluteRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error("WORKSPACE_PROVIDER_ROOT_INVALID");
  return resolve(value);
}

function within(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rejected(reasonCode: string): WorkspaceRollbackResult {
  return { result: "rejected", reasonCode };
}

function retained(reasonCode: string): WorkspaceRollbackResult {
  return { result: "retained", reasonCode };
}

function isSuccessfulResult(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
