import { basename } from "node:path";

import { digestCanonical } from "./canonical-json.js";
import { readAuthUsers } from "./auth-source.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import {
  parseJsonObject,
  readManifestFile,
  resolveSnapshotRoot,
  type ReadSourceFile,
} from "./source-files.js";
import { readWorkspaceRecords } from "./workspace-source.js";
import type {
  FrozenDoorAgentSource,
  LoadedDoorAgentSource,
  MigrationInventory,
  MigrationInventoryUser,
} from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ROOT_MANIFEST = /^manifest-v([1-9][0-9]*)\.json$/;
const MIN_FINAL_MANIFEST_VERSION = 5;
const DOMAIN_PATHS = {
  auth: "auth/manifest.json",
  jsonl: "files/jsonl-manifest-v2.json",
  qdrant: "qdrant/manifest.json",
  source: "files/source-manifest-v3.json",
  sqlite: "sqlite/manifest.json",
  topology: "topology/manifest.json",
  workspaces: "files/workspaces-manifest-v2.json",
} as const;

const ROOT_MANIFEST_CONTRACTS = [
  { kind: "dooragent-source-freeze-aggregate", status: "frozen" },
  { kind: "dooragent-source-freeze-final-aggregate", status: "frozen-with-derived-qdrant" },
] as const;

interface RootManifest {
  manifestVersion: number;
  domains: Record<keyof typeof DOMAIN_PATHS, DomainManifest>;
}

interface DomainManifest {
  path: string;
  digest: string;
}

export async function readFrozenDoorAgentSource(
  source: FrozenDoorAgentSource,
  signal?: AbortSignal,
): Promise<LoadedDoorAgentSource> {
  try {
    validateInput(source);
    const root = await resolveSnapshotRoot(source.snapshotPath);
    const rootFile = await readManifestFile(root, source.manifestPath, signal);
    if (rootFile.digest !== source.manifestDigest) digestMismatch();
    const manifest = parseRootManifest(parseJsonObject(rootFile), source.manifestPath);
    const domainFiles = await readDomains(root, manifest.domains, signal);
    const authManifest = parseJsonObject(domainFiles.auth);
    const records = await readAuthUsers(root, authManifest, signal);
    const authSnapshot = authManifest.snapshot;
    if (!isRecord(authSnapshot) || typeof authSnapshot.sha256 !== "string") digestMismatch();
    const workspaces = readWorkspaceRecords(
      parseJsonObject(domainFiles.workspaces), records, authSnapshot.sha256,
    );
    await assertRootUnchanged(root, source, signal);
    return { records, workspaces, inventory: buildInventory(source.manifestDigest, manifest.manifestVersion, records) };
  } catch (error) {
    if (error instanceof DoorAgentMigrationError) throw error;
    throw new DoorAgentMigrationError("SOURCE_DIGEST_MISMATCH");
  }
}

function validateInput(source: FrozenDoorAgentSource): void {
  if (!source || typeof source !== "object") inputInvalid();
  if (typeof source.snapshotPath !== "string" || !source.snapshotPath) inputInvalid();
  if (typeof source.manifestPath !== "string" || !ROOT_MANIFEST.test(basename(source.manifestPath))) inputInvalid();
  if (!SHA256_HEX.test(source.manifestDigest)) inputInvalid();
}

function parseRootManifest(value: Record<string, unknown>, manifestPath: string): RootManifest {
  const version = value.manifest_version;
  if (!Number.isSafeInteger(version) || Number(version) < MIN_FINAL_MANIFEST_VERSION) notFrozen();
  if (manifestPath !== `manifest-v${version}.json`) digestMismatch();
  if (value.final_freeze !== true || !ROOT_MANIFEST_CONTRACTS.some((contract) =>
    value.kind === contract.kind && value.status === contract.status)) notFrozen();
  if (!emptyArray(value.blocked_domains) || !emptyArray(value.drift_domains)) notFrozen();
  if (!exactTextArray(value.discarded_domains, ["qdrant"])) notFrozen();
  if (!SHA256_HEX.test(typeof value.supersedes_manifest_sha256 === "string"
    ? value.supersedes_manifest_sha256 : "")) digestMismatch();
  return { manifestVersion: Number(version), domains: parseDomains(value.domains) };
}

function parseDomains(value: unknown): RootManifest["domains"] {
  if (!isRecord(value) || !sameKeys(value, Object.keys(DOMAIN_PATHS))) digestMismatch();
  const parsed = {} as RootManifest["domains"];
  for (const [domain, expectedPath] of Object.entries(DOMAIN_PATHS)) {
    const entry = value[domain];
    if (!isRecord(entry) || entry.manifest_relative_path !== expectedPath) digestMismatch();
    const expectedStatus = domain === "qdrant" ? "derived" : "frozen";
    if (entry.status !== expectedStatus || !SHA256_HEX.test(text(entry.manifest_sha256))) {
      digestMismatch();
    }
    parsed[domain as keyof typeof DOMAIN_PATHS] = {
      path: expectedPath,
      digest: entry.manifest_sha256 as string,
    };
  }
  return parsed;
}

async function readDomains(
  root: string,
  domains: RootManifest["domains"],
  signal?: AbortSignal,
): Promise<Record<keyof typeof DOMAIN_PATHS, ReadSourceFile>> {
  const result = {} as Record<keyof typeof DOMAIN_PATHS, ReadSourceFile>;
  for (const domain of Object.keys(DOMAIN_PATHS) as Array<keyof typeof DOMAIN_PATHS>) {
    throwIfAborted(signal);
    const file = await readManifestFile(root, domains[domain].path, signal);
    if (file.digest !== domains[domain].digest) digestMismatch();
    parseJsonObject(file);
    result[domain] = file;
  }
  assertQdrantDisposition(parseJsonObject(result.qdrant));
  return result;
}

function assertQdrantDisposition(value: Record<string, unknown>): void {
  if (value.status !== "derived" || value.migration_disposition !== "discarded"
    || value.rebuild_strategy !== "reingest-from-facts") digestMismatch();
}

function buildInventory(
  snapshotDigest: string,
  manifestVersion: number,
  records: LoadedDoorAgentSource["records"],
): MigrationInventory {
  const users: MigrationInventoryUser[] = records.map(({ sourceId, sourceDigest, role, status }) => ({
    sourceId, sourceDigest, role, status,
  }));
  const content = {
    sourceSystem: "dooragent" as const,
    snapshotDigest,
    manifestVersion,
    counts: [{ sourceType: "user" as const, count: users.length }],
    users,
  };
  return { ...content, inventoryDigest: digestCanonical(content) };
}

async function assertRootUnchanged(
  root: string,
  source: FrozenDoorAgentSource,
  signal?: AbortSignal,
): Promise<void> {
  const current = await readManifestFile(root, source.manifestPath, signal);
  if (current.digest !== source.manifestDigest) digestMismatch();
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function exactTextArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sameKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputInvalid(): never {
  throw new DoorAgentMigrationError("IMPORT_INPUT_INVALID");
}

function notFrozen(): never {
  throw new DoorAgentMigrationError("SOURCE_NOT_FROZEN");
}

function digestMismatch(): never {
  throw new DoorAgentMigrationError("SOURCE_DIGEST_MISMATCH");
}
