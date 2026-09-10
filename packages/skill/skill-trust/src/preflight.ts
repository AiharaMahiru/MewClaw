/**
 * 技能信任预检核心（SPEC skill-trust.md）。
 *
 * 安全不变量：
 * - 摘要算法固定 SHA-256（不可配）；
 * - 缺失条目 / 摘要不符 / 版本不符 / 能力声明不符 / 通配路径 / 路径逃逸 /
 *   符号链接 = 一律拒绝（无"警告放行"档位）；
 * - manifest 缺失 fail loud（启动或首次预检）。
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  normalizeCapabilities,
  parseSkillMetadata,
  SkillMetadataError,
  type SkillCapabilities,
} from "../metadata.mjs";

/** manifest 顶层结构（version=1）。 */
export interface TrustManifest {
  version: 1;
  skills: Record<string, SkillTrustEntry>;
}

export interface SkillTrustEntry {
  /** 技能版本（与 SKILL.md 的 version 字段一致）。 */
  version: string;
  /** 目录 SHA-256 摘要（十六进制）。 */
  digest: string;
  /** 能力声明（M1/M2 仅记录并核对存在性；运行时执行归 sandbox）。 */
  capabilities: SkillCapabilities;
}

export interface TrustFailure {
  /** 技能名（拒绝原因不含目录内容细节，防定向探测）。 */
  name: string;
  reasonCode: "missing-entry" | "digest-mismatch" | "version-mismatch" | "capability-mismatch" | "symlink" | "path-escape" | "manifest-missing" | "io-error";
}

export interface TrustReport {
  ok: boolean;
  failures: TrustFailure[];
}

export class SkillTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillTrustError";
  }
}

/** 目录内文件是否全为普通文件且无符号链接；相对路径不得逃逸。 */
function safeRelative(root: string, path: string): string | null {
  const local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`) || local.startsWith(`${sep}`)) return null;
  return local;
}

/** 递归收集目录内全部普通文件（相对路径 → 绝对路径）；遇符号链接返回 null。 */
async function collectFiles(root: string): Promise<Map<string, string> | null> {
  const files = new Map<string, string>();
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) break;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const local = safeRelative(root, path);
      if (local === null) return null;
      if (entry.isSymbolicLink()) return null;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isFile()) files.set(local, path);
    }
  }
  return files;
}

/** 目录摘要：按相对路径排序，逐文件 SHA-256(相对路径 + NUL + 内容)。 */
async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await collectFiles(root);
  if (files === null) throw new SkillTrustError("目录含符号链接或逃逸路径");
  for (const local of [...files.keys()].sort()) {
    hash.update(local);
    hash.update("\0");
    hash.update(await readFile(files.get(local)!));
  }
  return hash.digest("hex");
}

export interface PreflightOptions {
  manifestPath: string;
  skillsRoot: string;
}

type FailureReason = TrustFailure["reasonCode"];
type SkillMetadata = ReturnType<typeof parseSkillMetadata>;

async function loadManifest(path: string): Promise<TrustManifest> {
  let manifest: TrustManifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as TrustManifest;
  } catch {
    throw new SkillTrustError(`信任清单不可读（${path}）——请先复核并生成 manifest`);
  }
  if (manifest.version !== 1) throw new SkillTrustError("信任清单版本不受支持");
  return manifest;
}

async function verifyDigest(root: string, name: string, declared: SkillTrustEntry): Promise<FailureReason | undefined> {
  try {
    const digest = await digestDirectory(join(root, name));
    return digest === declared.digest ? undefined : "digest-mismatch";
  } catch (error) {
    return error instanceof SkillTrustError ? "symlink" : "io-error";
  }
}

async function readSkillMetadata(root: string, name: string): Promise<SkillMetadata | FailureReason> {
  try {
    return parseSkillMetadata(await readFile(join(root, name, "SKILL.md"), "utf8"));
  } catch (error) {
    return error instanceof SkillMetadataError && error.field === "capabilities"
      ? "capability-mismatch"
      : "version-mismatch";
  }
}

function verifyMetadata(declared: SkillTrustEntry, metadata: SkillMetadata): FailureReason | undefined {
  if (typeof declared.version !== "string" || declared.version !== metadata.version) {
    return "version-mismatch";
  }
  let capabilities: SkillCapabilities;
  try {
    capabilities = normalizeCapabilities(declared.capabilities);
  } catch {
    return "capability-mismatch";
  }
  return JSON.stringify(capabilities) === JSON.stringify(metadata.capabilities)
    ? undefined
    : "capability-mismatch";
}

interface SkillCheckInput {
  root: string;
  name: string;
  declared: SkillTrustEntry | undefined;
}

async function checkSkill(input: SkillCheckInput): Promise<FailureReason | undefined> {
  if (!input.declared) return "missing-entry";
  const digestFailure = await verifyDigest(input.root, input.name, input.declared);
  if (digestFailure) return digestFailure;
  const metadata = await readSkillMetadata(input.root, input.name);
  if (typeof metadata === "string") return metadata;
  return verifyMetadata(input.declared, metadata);
}

/**
 * 全量预检：manifest 与 skillsRoot 逐技能核对。
 * manifest 缺失/损坏 → 抛 SkillTrustError（fail loud）；技能不匹配 → 报告拒绝。
 */
export async function preflightSkills(options: PreflightOptions): Promise<TrustReport> {
  const manifest = await loadManifest(options.manifestPath);
  const failures: TrustFailure[] = [];
  const root = resolve(options.skillsRoot);
  const names = await readdir(root, { withFileTypes: true });
  for (const entry of names) {
    if (entry.isSymbolicLink()) {
      failures.push({ name: entry.name, reasonCode: "symlink" });
      continue;
    }
    if (!entry.isDirectory()) continue; // 非目录（manifest 等）不预检。
    const name = entry.name;
    const reasonCode = await checkSkill({ root, name, declared: manifest.skills[name] });
    if (reasonCode) failures.push({ name, reasonCode });
  }
  return { ok: failures.length === 0, failures };
}
