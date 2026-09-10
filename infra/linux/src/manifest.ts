import { createHash } from "node:crypto";

import type {
  EnvironmentFileMetadata,
  ProductionRuntimeManifest,
  RuntimePaths,
  RuntimePorts,
  UnitManifest,
} from "./types.js";
import {
  asRecord,
  assertExactKeys,
  assertIsoTimestamp,
  assertSafeAbsolutePath,
  assertSha256,
  readInteger,
  readString,
  validateRuntimePaths,
  validateRuntimePorts,
  validateTargetEnvironmentMetadata,
} from "./validation.js";

const ROOT_KEYS = ["schemaVersion", "createdAt", "host", "release", "paths", "ports", "database", "sandbox", "units", "environment"];

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function runtimeManifestDigest(value: unknown): string {
  return digestJson(parseProductionRuntimeManifest(value));
}

export function parseProductionRuntimeManifest(value: unknown): ProductionRuntimeManifest {
  const root = asRecord(value, "runtime manifest");
  assertExactKeys(root, ROOT_KEYS, "runtime manifest");
  if (root.schemaVersion !== 1) throw new Error("runtime manifest schemaVersion must be 1");
  const paths = parsePaths(root.paths);
  const environment = parseEnvironment(root.environment);
  if (environment.path !== paths.environmentFile) throw new Error("environment path must match paths.environmentFile");
  return {
    schemaVersion: 1,
    createdAt: assertIsoTimestamp(readString(root, "createdAt", "runtime manifest"), "createdAt"),
    host: parseHost(root.host),
    release: parseRelease(root.release),
    paths,
    ports: parsePorts(root.ports),
    database: parseDatabase(root.database),
    sandbox: parseSandbox(root.sandbox),
    units: parseUnits(root.units),
    environment,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("value must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().map((key) => {
    if (record[key] === undefined) throw new Error("value must be JSON-compatible");
    return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
  });
  return `{${fields.join(",")}}`;
}

function parseHost(value: unknown): ProductionRuntimeManifest["host"] {
  const record = asRecord(value, "host");
  assertExactKeys(record, ["architecture", "bootId", "hostname", "osRelease"], "host");
  return {
    architecture: readString(record, "architecture", "host"),
    bootId: readString(record, "bootId", "host"),
    hostname: readString(record, "hostname", "host"),
    osRelease: readString(record, "osRelease", "host"),
  };
}

function parseRelease(value: unknown): ProductionRuntimeManifest["release"] {
  const record = asRecord(value, "release");
  assertExactKeys(record, ["artifactSha256", "gitCommit", "lockfileSha256", "productionLockSha256"], "release");
  const gitCommit = readString(record, "gitCommit", "release");
  if (!/^[a-f0-9]{7,64}$/.test(gitCommit)) throw new Error("release.gitCommit must be a lowercase Git object id");
  return {
    artifactSha256: assertSha256(readString(record, "artifactSha256", "release"), "release.artifactSha256"),
    gitCommit,
    lockfileSha256: assertSha256(readString(record, "lockfileSha256", "release"), "release.lockfileSha256"),
    productionLockSha256: assertSha256(
      readString(record, "productionLockSha256", "release"),
      "release.productionLockSha256",
    ),
  };
}

function parsePaths(value: unknown): RuntimePaths {
  const record = asRecord(value, "paths");
  const keys = ["backupsRoot", "currentLink", "environmentFile", "releasesRoot", "sessionsRoot", "stateRoot", "uploadsRoot", "workspacesRoot"];
  assertExactKeys(record, keys, "paths");
  return validateRuntimePaths(Object.fromEntries(keys.map((key) => [key, readString(record, key, "paths")])) as unknown as RuntimePaths);
}

function parsePorts(value: unknown): RuntimePorts {
  const record = asRecord(value, "ports");
  const keys = ["admin", "authEdge", "browser", "preview", "postgres", "workerRun", "workerWeb"];
  assertExactKeys(record, keys, "ports");
  return validateRuntimePorts(Object.fromEntries(keys.map((key) => [key, readInteger(record, key, "ports")])) as unknown as RuntimePorts);
}

function parseDatabase(value: unknown): ProductionRuntimeManifest["database"] {
  const record = asRecord(value, "database");
  assertExactKeys(record, ["bindHost", "cluster", "vectorVersion", "version"], "database");
  if (record.bindHost !== "127.0.0.1") throw new Error("database.bindHost must be 127.0.0.1");
  return {
    bindHost: "127.0.0.1",
    cluster: readString(record, "cluster", "database"),
    vectorVersion: readString(record, "vectorVersion", "database"),
    version: readString(record, "version", "database"),
  };
}

function parseSandbox(value: unknown): ProductionRuntimeManifest["sandbox"] {
  const record = asRecord(value, "sandbox");
  assertExactKeys(record, ["imageDigest", "network", "rootless"], "sandbox");
  const imageDigest = readString(record, "imageDigest", "sandbox");
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("sandbox.imageDigest must pin a SHA-256 digest");
  if (record.network !== "none" || record.rootless !== true) throw new Error("sandbox must be rootless with network none");
  return { imageDigest, network: "none", rootless: true };
}

function parseUnits(value: unknown): readonly UnitManifest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("units must be a non-empty array");
  return value.map((entry, index) => {
    const record = asRecord(entry, `units[${index}]`);
    assertExactKeys(record, ["configSha256", "entrypoint", "name"], `units[${index}]`);
    const name = readString(record, "name", `units[${index}]`);
    if (!/^[a-z0-9@_.-]+\.service$/.test(name)) throw new Error(`units[${index}].name must be a service unit`);
    return {
      configSha256: assertSha256(readString(record, "configSha256", `units[${index}]`), `units[${index}].configSha256`),
      entrypoint: assertSafeAbsolutePath(readString(record, "entrypoint", `units[${index}]`), `units[${index}].entrypoint`),
      name,
    };
  });
}

function parseEnvironment(value: unknown): EnvironmentFileMetadata {
  const record = asRecord(value, "environment");
  assertExactKeys(record, ["bytes", "group", "mode", "owner", "path", "sha256"], "environment");
  if (record.mode !== "0600") throw new Error("environment.mode must be 0600");
  return validateTargetEnvironmentMetadata({
    bytes: readInteger(record, "bytes", "environment"),
    group: readString(record, "group", "environment"),
    mode: "0600",
    owner: readString(record, "owner", "environment"),
    path: readString(record, "path", "environment"),
    sha256: readString(record, "sha256", "environment"),
  });
}
