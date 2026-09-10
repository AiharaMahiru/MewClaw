import { parse } from "yaml";

const CAPABILITY_KEYS = new Set(["filesystem", "network", "credentialRefs", "subprocess"]);

export class SkillMetadataError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SkillMetadataError";
    this.field = field;
  }
}

function frontmatterOf(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) throw new SkillMetadataError("version", "SKILL.md 缺少 YAML frontmatter");
  let parsed;
  try {
    parsed = parse(match[1]);
  } catch {
    throw new SkillMetadataError("version", "SKILL.md frontmatter 不是合法 YAML");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillMetadataError("version", "SKILL.md frontmatter 必须是对象");
  }
  return parsed;
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new SkillMetadataError("capabilities", `${field} 必须是非空字符串数组`);
  }
  const normalized = value.map((item) => item.trim()).sort();
  if (normalized.some((item) => item.includes("*")) || new Set(normalized).size !== normalized.length) {
    throw new SkillMetadataError("capabilities", `${field} 不得含通配符或重复项`);
  }
  return normalized;
}

export function normalizeCapabilities(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillMetadataError("capabilities", "capabilities 必须是对象");
  }
  for (const key of Object.keys(value)) {
    if (!CAPABILITY_KEYS.has(key)) throw new SkillMetadataError("capabilities", `未知能力字段 ${key}`);
  }
  const output = {};
  for (const key of ["filesystem", "network", "credentialRefs"]) {
    if (value[key] !== undefined) {
      const entries = normalizeStringList(value[key], key);
      if (entries.length > 0) output[key] = entries;
    }
  }
  if (value.subprocess !== undefined) {
    if (typeof value.subprocess !== "boolean") {
      throw new SkillMetadataError("capabilities", "subprocess 必须是 boolean");
    }
    output.subprocess = value.subprocess;
  }
  return output;
}

export function parseSkillMetadata(content) {
  const data = frontmatterOf(content);
  const official = officialDshMetadata(data);
  const hasLegacy = Object.hasOwn(data, "version") || Object.hasOwn(data, "capabilities");
  if (official !== undefined && hasLegacy) {
    throw new SkillMetadataError("version", "顶层与 metadata.dsh 不得同时声明版本或能力");
  }
  const source = official ?? data;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new SkillMetadataError("version", "技能元数据必须是对象");
  }
  if (typeof source.version !== "string" || !source.version.trim()) {
    throw new SkillMetadataError("version", "version 必须是非空字符串");
  }
  return {
    version: source.version.trim(),
    capabilities: normalizeCapabilities(source.capabilities),
  };
}

function officialDshMetadata(data) {
  const metadata = data.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  if (!Object.hasOwn(metadata, "dsh")) return undefined;
  return metadata.dsh;
}
