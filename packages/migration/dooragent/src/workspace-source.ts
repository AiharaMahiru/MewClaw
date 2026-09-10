import { createHash } from "node:crypto";

import { digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import type {
  DoorAgentUserRecord,
  DoorAgentWorkspaceRecord,
  WorkspaceAggregate,
} from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_COUNT = 10_000_000;

export function readWorkspaceRecords(
  manifest: Record<string, unknown>,
  users: readonly DoorAgentUserRecord[],
  authSnapshotDigest: string,
): DoorAgentWorkspaceRecord[] {
  validateManifest(manifest, authSnapshotDigest);
  const roots = manifest.workspace && isRecord(manifest.workspace)
    ? manifest.workspace.roots : undefined;
  if (!Array.isArray(roots)) invalid();
  const byHash = new Map<string, DoorAgentUserRecord>();
  for (const user of users) {
    const hash = digestPath(user.workspaceRoot);
    if (byHash.has(hash)) invalid();
    byHash.set(hash, user);
  }
  const records: DoorAgentWorkspaceRecord[] = [];
  for (const value of roots) {
    if (!isRecord(value)) invalid();
    const rootPathSha256 = text(value.root_path_sha256);
    const user = byHash.get(rootPathSha256);
    if (!user || records.some((item) => item.sourceUserId === user.sourceId)) invalid();
    const status = value.status;
    const aggregate = status === "manifested" ? readAggregate(value.aggregate) : null;
    if (status !== "manifested" && status !== "missing") invalid();
    if (status === "manifested") validateEvidence(value.evidence);
    const sourceDigest = digestCanonical({ rootPathSha256, status, aggregate });
    records.push({ sourceUserId: user.sourceId, rootPathSha256, sourceDigest, status,
      aggregate, workspaceRoot: user.workspaceRoot });
  }
  if (records.length !== users.length) invalid();
  validateCounts(manifest, records);
  return records.sort((left, right) => left.sourceUserId.localeCompare(right.sourceUserId));
}

function validateManifest(value: Record<string, unknown>, authSnapshotDigest: string): void {
  if (value.kind !== "dooragent-workspace-live-aggregate" || value.manifest_version !== 3
    || value.merkle_algorithm !== "sha256-canonical-leaves-path-digest-order-duplicate-last"
    || value.path_disclosure !== "sha256-only" || value.status !== "manifested"
    || value.semantics !== "live-aggregate-not-final-freeze-or-restorable-copy"
    || value.source_auth_snapshot_sha256 !== authSnapshotDigest) invalid();
  if (!isRecord(value.workspace) || !isRecord(value.uploads)) invalid();
}

function validateEvidence(value: unknown): void {
  if (!isRecord(value)) invalid();
  for (const key of ["directory_exists", "directory_uid_matches_runtime", "is_directory",
    "non_overlapping", "not_wide_system_root", "symlink_chain_absent", "unique_auth_reference",
    "user_id_is_path_component"] as const) {
    if (value[key] !== true) invalid();
  }
}

function validateCounts(manifest: Record<string, unknown>, records: readonly DoorAgentWorkspaceRecord[]): void {
  const workspace = manifest.workspace as Record<string, unknown>;
  const counts = workspace.aggregate;
  if (!isRecord(counts)) invalid();
  const manifested = records.filter((item) => item.status === "manifested");
  const missing = records.length - manifested.length;
  if (workspace.referenced_root_count !== records.length
    || workspace.manifested_root_count !== manifested.length
    || workspace.missing_count !== missing
    || workspace.rejected_root_count !== 0) invalid();
  const aggregate = readAggregate(counts);
  for (const key of ["bytes", "directoryCount", "fileCount", "symlinkCount", "specialFileCount"] as const) {
    const total = manifested.reduce((sum, item) => sum + (item.aggregate?.[key] ?? 0), 0);
    if (total !== aggregate[key]) invalid();
  }
}

function readAggregate(value: unknown): WorkspaceAggregate {
  if (!isRecord(value) || !SHA256_HEX.test(text(value.merkle_root_sha256))) invalid();
  const result = {
    bytes: integer(value.bytes),
    directoryCount: integer(value.directory_count),
    fileCount: integer(value.file_count),
    merkleRootSha256: text(value.merkle_root_sha256),
    specialFileCount: integer(value.special_file_count),
    symlinkCount: integer(value.symlink_count),
    unreadableEntries: integer(value.unreadable_entries),
    unstableFiles: integer(value.unstable_files),
  };
  if (result.directoryCount < 1 || result.unreadableEntries !== 0 || result.unstableFiles !== 0) invalid();
  return result;
}

function digestPath(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_COUNT * 1_000_000) invalid();
  return Number(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new DoorAgentMigrationError("SOURCE_DIGEST_MISMATCH");
}
