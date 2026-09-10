import { digestJson } from "./manifest.js";
import type {
  ProductionPackageEntry,
  ProductionPackageLock,
  ProductionRuntimeEntry,
} from "./types.js";
import {
  asRecord,
  assertExactKeys,
  assertIsoTimestamp,
  assertSha256,
  readInteger,
  readString,
} from "./validation.js";

const REQUIRED_PACKAGES = new Set([
  "chromium", "chromium-common", "chromium-sandbox",
  "postgresql-17", "postgresql-client-17", "postgresql-17-pgvector", "podman",
]);
const ARCHIVE_REQUIRED_PACKAGES = new Set([
  "chromium", "chromium-common", "chromium-sandbox", "postgresql-17", "postgresql-client-17",
]);
const PACKAGE_KEYS = [
  "architecture", "archiveContentSha1", "archiveUrl", "filename", "name", "repository", "sha256", "size", "version",
];
const RUNTIME_KEYS = ["architecture", "name", "platform", "sha256", "size", "url", "version"];
const REPOSITORY_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._/-]+)? [A-Za-z0-9-]+\/[A-Za-z0-9-]+$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SNAPSHOT_FILE_ROOT = "https://snapshot.debian.org/file";
const NODE_VERSION_PATTERN = /^24\.\d+\.\d+$/;

export function parseProductionPackageLock(value: unknown): ProductionPackageLock {
  const root = asRecord(value, "production package lock");
  assertExactKeys(root, ["schemaVersion", "observedAt", "host", "packages", "runtimes"], "production package lock");
  if (root.schemaVersion !== 1) throw new Error("production package lock schemaVersion must be 1");
  const packages = parsePackages(root.packages);
  assertRequiredPackages(packages);
  return {
    schemaVersion: 1,
    observedAt: assertIsoTimestamp(readString(root, "observedAt", "production package lock"), "observedAt"),
    host: parseHost(root.host),
    packages,
    runtimes: parseRuntimes(root.runtimes),
  };
}

function parseRuntimes(value: unknown): readonly ProductionRuntimeEntry[] {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("exactly one Node runtime is required");
  const record = asRecord(value[0], "runtimes[0]");
  assertExactKeys(record, RUNTIME_KEYS, "runtimes[0]");
  const version = readString(record, "version", "runtimes[0]");
  const url = readString(record, "url", "runtimes[0]");
  if (record.name !== "node" || record.platform !== "linux" || record.architecture !== "x64") {
    throw new Error("runtime must be Node linux-x64");
  }
  if (!NODE_VERSION_PATTERN.test(version)) throw new Error("runtime must use Node 24");
  const expectedUrl = `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`;
  if (url !== expectedUrl) throw new Error("runtime url must pin the exact Node version");
  const size = readInteger(record, "size", "runtimes[0]");
  if (size < 1) throw new Error("runtimes[0].size must be positive");
  return [{
    architecture: "x64",
    name: "node",
    platform: "linux",
    sha256: assertSha256(readString(record, "sha256", "runtimes[0]"), "runtimes[0].sha256"),
    size,
    url,
    version,
  }];
}

export function productionPackageLockDigest(value: unknown): string {
  return digestJson(parseProductionPackageLock(value));
}

function parseHost(value: unknown): ProductionPackageLock["host"] {
  const record = asRecord(value, "package lock host");
  assertExactKeys(record, ["architecture", "os"], "package lock host");
  const architecture = readString(record, "architecture", "package lock host");
  if (architecture !== "amd64") throw new Error("package lock architecture must be amd64");
  return { architecture, os: readString(record, "os", "package lock host") };
}

function parsePackages(value: unknown): readonly ProductionPackageEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("packages must be a non-empty array");
  const packages = value.map((entry, index) => parsePackage(entry, index));
  if (new Set(packages.map((entry) => entry.name)).size !== packages.length) {
    throw new Error("package names must be unique");
  }
  return packages;
}

function parsePackage(value: unknown, index: number): ProductionPackageEntry {
  const label = `packages[${index}]`;
  const record = asRecord(value, label);
  assertExactKeys(record, PACKAGE_KEYS, label);
  const name = readString(record, "name", label);
  const version = readString(record, "version", label);
  const repository = readString(record, "repository", label);
  const filename = readString(record, "filename", label);
  const archive = parsePackageArchive(record, label);
  if (!/^[a-z0-9][a-z0-9+.-]+$/.test(name)) throw new Error(`${label}.name is invalid`);
  if (!/^[A-Za-z0-9.+:~_-]+$/.test(version)) throw new Error(`${label}.version is invalid`);
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`${label}.repository is invalid`);
  if (!/^[A-Za-z0-9._/+~:-]+$/.test(filename) || filename.includes("..")) throw new Error(`${label}.filename is invalid`);
  const size = readInteger(record, "size", label);
  if (size < 1) throw new Error(`${label}.size must be positive`);
  return {
    ...archive,
    architecture: readString(record, "architecture", label),
    filename,
    name,
    repository,
    sha256: assertSha256(readString(record, "sha256", label), `${label}.sha256`),
    size,
    version,
  };
}

function parsePackageArchive(
  record: Record<string, unknown>,
  label: string,
): Pick<ProductionPackageEntry, "archiveContentSha1" | "archiveUrl"> {
  const contentSha1 = record.archiveContentSha1;
  const url = record.archiveUrl;
  if (contentSha1 === null && url === null) return { archiveContentSha1: null, archiveUrl: null };
  if (typeof contentSha1 !== "string" || !SHA1_PATTERN.test(contentSha1)) {
    throw new Error(`${label}.archiveContentSha1 must be a lowercase SHA-1 or null`);
  }
  const expectedUrl = `${SNAPSHOT_FILE_ROOT}/${contentSha1}`;
  if (url !== expectedUrl) throw new Error(`${label}.archiveUrl must match archiveContentSha1`);
  return { archiveContentSha1: contentSha1, archiveUrl: expectedUrl };
}

function assertRequiredPackages(packages: readonly ProductionPackageEntry[]): void {
  const names = new Set(packages.map((entry) => entry.name));
  for (const name of REQUIRED_PACKAGES) {
    if (!names.has(name)) throw new Error(`required package ${name} is missing`);
  }
  for (const entry of packages) {
    if (ARCHIVE_REQUIRED_PACKAGES.has(entry.name) && entry.archiveContentSha1 === null) {
      throw new Error(`required package ${entry.name} must pin a Debian Snapshot content SHA-1`);
    }
  }
}
