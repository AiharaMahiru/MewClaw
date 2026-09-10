import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Scope } from "dsh-lark-contracts";

import { PreviewAppError } from "./errors.js";

/**
 * 普通工作区必须位于 workspaceRoot/users/<userId>/ 内；管理员只允许 Worker
 * 传入精确的 workspaceRoot/admin。词法路径和 realpath 均不得逃逸。
 */
export async function authorizeWorkspace(rootInput: string, workspaceInput: string, scope: Scope): Promise<string> {
  if (!isAbsolute(rootInput) || !isAbsolute(workspaceInput)) forbidden();
  const root = await realpath(resolve(rootInput)).catch(forbidden);
  const adminRoot = resolve(root, "admin");
  const lexicalWorkspace = resolve(workspaceInput);
  if (lexicalWorkspace === adminRoot) {
    const realAdminRoot = await realpath(adminRoot).catch(forbidden);
    if (realAdminRoot !== adminRoot || !contained(root, realAdminRoot)) forbidden();
    return realAdminRoot;
  }
  const expectedUserRoot = resolve(root, "users", scope.userId);
  if (!contained(root, expectedUserRoot)) forbidden();
  const userRoot = await realpath(expectedUserRoot).catch(forbidden);
  if (!contained(userRoot, lexicalWorkspace)) forbidden();
  const workspace = await realpath(lexicalWorkspace).catch(forbidden);
  if (!contained(userRoot, workspace)) forbidden();
  return workspace;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function forbidden(): never {
  throw new PreviewAppError("PREVIEW_FORBIDDEN", "工作区不属于当前用户");
}
