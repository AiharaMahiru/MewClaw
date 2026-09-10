import { createHash } from "node:crypto";

import { DoorAgentMigrationError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) throw new DoorAgentMigrationError("IMPORT_INPUT_INVALID");
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
