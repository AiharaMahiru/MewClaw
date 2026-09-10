import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

import type { AuthMode, AuthRole, AuthUser } from "./types.js";

export interface AuthAccessPolicy {
  role: AuthRole;
  mode: AuthMode;
  defaultPreset: "lark-standard" | "lark-lightweight";
  allowedPresets: readonly string[];
  workspaceRoot: string;
}

const FULL_PRESETS = ["lark-standard", "liangshen", "standard", "ptc", "minimal", "cordis"] as const;
const LIGHTWEIGHT_PRESETS = ["lark-lightweight"] as const;
// 普通用户仍以轻量模式启动，但可以选择当前 Worker 暴露的全部系统 preset。
// 工作区、资源归属和执行 profile 仍由 Auth Edge 与 Worker 各自的边界控制。
const USER_PRESETS = [...LIGHTWEIGHT_PRESETS, ...FULL_PRESETS] as const;

export function accessPolicy(user: AuthUser, roots: { user: string; admin: string }): AuthAccessPolicy {
  const admin = user.role === "admin";
  return {
    role: user.role,
    mode: admin ? "full" : "lightweight",
    defaultPreset: admin ? "lark-standard" : "lark-lightweight",
    allowedPresets: admin ? FULL_PRESETS : USER_PRESETS,
    workspaceRoot: resolve(admin ? roots.admin : roots.user, user.id),
  };
}

export function isPathWithin(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const base = resolve(root);
  const target = resolve(candidate);
  const rest = relative(base, target);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** 对已存在的路径解析符号链接；不存在的尾部仍基于最近真实父目录校验。 */
export async function isPathWithinReal(root: string, candidate: string): Promise<boolean> {
  const [base, target] = await Promise.all([canonicalPath(root), canonicalPath(candidate)]);
  return isPathWithin(base, target);
}

async function canonicalPath(value: string): Promise<string> {
  try { return await realpath(value); } catch { /* 继续解析最近存在的父目录。 */ }
  let current = resolve(value);
  const tail: string[] = [];
  while (true) {
    const parent = dirname(current);
    if (parent === current) return resolve(value);
    tail.unshift(basename(current));
    current = parent;
    try { return resolve(await realpath(current), ...tail); } catch { /* 父目录仍不存在。 */ }
  }
}

export function normalizeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
