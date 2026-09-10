import { createHash } from "node:crypto";

import type { Preset } from "./index.js";

const PRESET_KEYS = new Set([
  "name",
  "version",
  "revision",
  "identity",
  "profile",
  "tools",
  "skills",
  "retrieval",
  "persona",
]);
const PROFILE_VALUES = new Set(["quick", "standard", "long"]);
const RETRIEVAL_VALUES = new Set(["auto", "off"]);
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

type PresetValidation = { preset: Preset } | { error: string };
type Validator = (record: Record<string, unknown>) => string | undefined;

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function validateKeys(record: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(record).find((key) => !PRESET_KEYS.has(key));
  return unknown ? `未知字段 ${unknown}` : undefined;
}

function validateCore(record: Record<string, unknown>): string | undefined {
  if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name)) {
    return "preset.name 非法（kebab-case）";
  }
  if (typeof record.version !== "string" || !record.version.trim()) return "preset.version 缺失";
  if (typeof record.revision !== "string" || !/^[a-f0-9]{64}$/.test(record.revision)) {
    return "preset.revision 非法（SHA-256 hex）";
  }
  return undefined;
}

function validateIdentity(record: Record<string, unknown>): string | undefined {
  if (record.identity === undefined) return undefined;
  const identity = asRecord(record.identity);
  if (!identity) return "preset.identity 非法";
  for (const key of Object.keys(identity)) {
    if (!["tenantId", "botId", "deploymentId"].includes(key)) return `identity 未知字段 ${key}`;
    if (typeof identity[key] !== "string" || !identity[key].trim()) return `identity.${key} 非法`;
  }
  return undefined;
}

function validateTools(record: Record<string, unknown>): string | undefined {
  if (record.tools === undefined) return undefined;
  const tools = asRecord(record.tools);
  if (!tools) return "preset.tools 非法";
  if (tools.deny !== undefined && (!Array.isArray(tools.deny) || tools.deny.some((item) => typeof item !== "string"))) {
    return "preset.tools 非法";
  }
  const unknown = Object.keys(tools).find((key) => key !== "deny");
  return unknown ? `tools 未知字段 ${unknown}` : undefined;
}

function validateSkills(record: Record<string, unknown>): string | undefined {
  if (record.skills === undefined) return undefined;
  if (!Array.isArray(record.skills) || record.skills.some((item) => typeof item !== "string")) {
    return "preset.skills 非法";
  }
  return undefined;
}

function validateOptionalScalars(record: Record<string, unknown>): string | undefined {
  if (record.profile !== undefined
    && (typeof record.profile !== "string" || !PROFILE_VALUES.has(record.profile))) {
    return "preset.profile 非法";
  }
  if (record.retrieval !== undefined
    && (typeof record.retrieval !== "string" || !RETRIEVAL_VALUES.has(record.retrieval))) {
    return "preset.retrieval 非法";
  }
  if (record.persona !== undefined && typeof record.persona !== "string") return "preset.persona 非法";
  return undefined;
}

const VALIDATORS: Validator[] = [
  validateKeys,
  validateCore,
  validateIdentity,
  validateTools,
  validateSkills,
  validateOptionalScalars,
];

function buildPreset(record: Record<string, unknown>): Preset {
  return {
    name: record.name as string,
    version: record.version as string,
    revision: record.revision as string,
    ...(record.identity ? { identity: record.identity as NonNullable<Preset["identity"]> } : {}),
    ...(record.profile ? { profile: record.profile as NonNullable<Preset["profile"]> } : {}),
    ...(record.tools ? { tools: { deny: (record.tools as { deny?: string[] }).deny ?? [] } } : {}),
    ...(record.skills ? { skills: record.skills as string[] } : {}),
    ...(record.retrieval ? { retrieval: record.retrieval as NonNullable<Preset["retrieval"]> } : {}),
    ...(record.persona !== undefined ? { persona: record.persona as string } : {}),
  };
}

/** 修订号排除 revision 字段后计算规范 SHA-256。 */
export function revisionOf(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const { revision: _revision, ...canonical } = parsed;
  void _revision;
  return createHash("sha256").update(`${JSON.stringify(canonical, null, 2)}\n`).digest("hex");
}

export function validatePreset(input: unknown, expectedRevision: string | undefined): PresetValidation {
  const record = asRecord(input);
  if (!record) return { error: "preset 必须是非空对象" };
  for (const validate of VALIDATORS) {
    const error = validate(record);
    if (error) return { error };
  }
  if (expectedRevision && record.revision !== expectedRevision) {
    return { error: "preset.revision 与内容不符（变更后需重算修订号）" };
  }
  return { preset: buildPreset(record) };
}
