import { posix } from "node:path";

import type {
  EnvironmentFileMetadata,
  RuntimePaths,
  RuntimePorts,
  SourceFileMetadata,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._/@:+-]+$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._/@:+-]+$/;
const MAX_ENV_BYTES = 4 * 1024 * 1024;

interface TargetEnvironmentMetadataInput {
  bytes: number;
  group: string;
  mode: string;
  owner: string;
  path: string;
  sha256: string;
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

export function readString(record: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

export function readInteger(record: Readonly<Record<string, unknown>>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new Error(`${label}.${key} must be a safe integer`);
  return value as number;
}

export function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

export function assertIsoTimestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function assertSafeAbsolutePath(value: string, label: string): string {
  if (!posix.isAbsolute(value)) throw new Error(`${label} must be an absolute POSIX path`);
  if (value === "/") throw new Error(`${label} cannot be the filesystem root`);
  if (posix.normalize(value) !== value) throw new Error(`${label} must be normalized`);
  if (!SAFE_ABSOLUTE_PATH_PATTERN.test(value)) throw new Error(`${label} must be a safe absolute path`);
  return value;
}

export function assertSafeToken(value: string, label: string): string {
  if (!SAFE_TOKEN_PATTERN.test(value)) throw new Error(`${label} contains an unsafe argument`);
  return value;
}

export function assertPort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer in 1..65535`);
  }
  return value;
}

export function isPathWithin(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

export function validateRuntimePaths(paths: RuntimePaths): RuntimePaths {
  const parsed = Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [key, assertSafeAbsolutePath(value, `paths.${key}`)]),
  ) as unknown as RuntimePaths;
  for (const key of ["backupsRoot", "sessionsRoot", "uploadsRoot", "workspacesRoot"] as const) {
    if (!isPathWithin(parsed[key], parsed.stateRoot)) throw new Error(`paths.${key} must stay under stateRoot`);
  }
  if (posix.dirname(parsed.currentLink) !== posix.dirname(parsed.releasesRoot)) {
    throw new Error("currentLink and releasesRoot must share a deployment root");
  }
  return parsed;
}

export function validateRuntimePorts(ports: RuntimePorts): RuntimePorts {
  const parsed = Object.fromEntries(
    Object.entries(ports).map(([key, value]) => [key, assertPort(value, `ports.${key}`)]),
  ) as unknown as RuntimePorts;
  if (new Set(Object.values(parsed)).size !== Object.keys(parsed).length) {
    throw new Error("runtime ports must be unique");
  }
  return parsed;
}

export function validateEnvironmentReplica(
  source: SourceFileMetadata,
  target: TargetEnvironmentMetadataInput,
  expectedTargetPath: string,
): EnvironmentFileMetadata {
  validateFileSize(source.bytes, "source env");
  assertSha256(source.sha256, "source env digest");
  validateTargetEnvironmentMetadata(target);
  if (target.path !== expectedTargetPath) throw new Error("target env path does not match the manifest");
  if (source.bytes !== target.bytes) throw new Error("env byte count mismatch");
  if (source.sha256 !== target.sha256) throw new Error("env digest mismatch");
  return toEnvironmentMetadata(target);
}

export function validateTargetEnvironmentMetadata(target: TargetEnvironmentMetadataInput): EnvironmentFileMetadata {
  validateFileSize(target.bytes, "target env");
  assertSha256(target.sha256, "target env digest");
  assertSafeAbsolutePath(target.path, "target env path");
  if (target.owner !== "dsh" || target.group !== "dsh") throw new Error("target env owner and group must be dsh");
  if (target.mode !== "0600") throw new Error("target env mode must be 0600");
  return toEnvironmentMetadata(target);
}

function toEnvironmentMetadata(target: TargetEnvironmentMetadataInput): EnvironmentFileMetadata {
  return {
    bytes: target.bytes,
    group: target.group,
    mode: "0600",
    owner: target.owner,
    path: target.path,
    sha256: target.sha256,
  };
}

function validateFileSize(bytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ENV_BYTES) {
    throw new Error(`${label} byte count is outside the allowed range`);
  }
}
