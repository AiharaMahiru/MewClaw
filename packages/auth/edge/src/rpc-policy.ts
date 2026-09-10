import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AuthService, AuthUser } from "dsh-lark-auth";
import { accessPolicy, isPathWithinReal } from "dsh-lark-auth";

export interface RpcPolicyOptions {
  service: AuthService;
  user: AuthUser;
  roots: { user: string; admin: string };
}

export interface RpcDecision {
  body: Record<string, unknown>;
  method: string;
  args: Record<string, unknown>;
  denied?: string;
}

const SESSION_METHODS = new Set(["session.export", "session.history", "session.search", "session.models", "session.prompt", "session.fork", "session.rename", "session.selectModel", "session.attachment", "session.updateQueue", "session.cancel", "session.page", "agentPreset.select", "goal.create", "goal.edit", "goal.pause", "goal.resume", "goal.complete", "goal.clear", "skill.list", "skills.list", "commands.list", "commands.execute", "fileReferences.list", "sessionReferenceResolver.candidates", "messageFeedback.list", "messageFeedback.put", "messageFeedback.delete", "workspace.insertSessionBefore", "workspace.archiveSession", "subagent.list", "subagent.history", "subagent.prompt", "subagent.interrupt", "subagents.list", "subagents.prompt", "subagents.interruptByParent"]);
const REFERENCE_METHODS = new Set(["fileReferences.list", "sessionReferenceResolver.candidates"]);
const SESSION_ID_REQUIRED_METHODS = new Set(["session.page", "skills.list"]);
const WORKSPACE_METHODS = new Set(["workspace.rename", "workspace.delete", "workspace.insertBefore", "workspace.insertSessionBefore"]);
const ADMIN_ONLY_METHODS = new Set(["host.pickDirectory", "host.openPath", "directoryPicker.pick", "settings.describe", "settings.openDocument", "settings.update", "settings.replace", "settings.mutate", "credentials.describe", "credentials.set", "credentials.unset", "llm.providers", "llm.models", "llm.discoverModels", "agentPreset.read", "agentPreset.copy", "agentPreset.openDocument", "agentPreset.remove"]);
// 模型目录和已脱敏的设置/凭据描述是普通用户的只读数据面；写入、探测
// 和宿主路径操作仍严格保留给管理员，避免把全局配置权限带入用户工作区。
const READ_ONLY_CATALOG_METHODS = new Set(["settings.describe", "credentials.describe", "llm.providers", "llm.models"]);
// 官方 0.1.2+ Client 通过这些 slash Remote 做首屏发现和目录加载。
// 目录创建是唯一受控写入：后面会把路径限制在当前用户的 workspace root；
// 会话预设选择另行校验归属；其他 set/mutate/discover/copy/delete 等操作仍拒绝。
const USER_READ_ONLY_TYPERT_METHODS = new Set([
  "agentPresets/list",
  "credentials/describe",
  "fileReferences/list",
  "llm/listConfigurableProviders",
  "llm/listProviders",
  "pluginInventory/list",
  "session/canOpenWorkspacePath",
  "session/list",
  "session/modelCatalog",
  "session/page",
  "session/search",
  "sessionReferenceResolver/candidates",
  "settings/canOpenAgentPresetDirectory",
  "settings/describe",
  "skills/list",
]);
const USER_DIRECTORY_TYPERT_METHODS = new Set(["directoryPicker/list", "directoryPicker/createDirectory"]);
const USER_TYPERT_METHODS = new Set([
  "agentPresets/select",
  "commands/list", "commands/execute", "dsh-web-ui-settings/describe",
  "goals/clear", "goals/complete", "goals/create", "goals/edit", "goals/pause", "goals/resume",
  "messageFeedback/delete", "messageFeedback/list", "messageFeedback/put",
  "llm/providers", "llm/models",
  // 普通用户可对自己拥有的会话执行完整的 UI 生命周期操作；下方
  // SESSION_METHODS 归属检查仍会拒绝他人的会话。
  "session/attachment", "session/cancel", "session/create", "session/fork",
  "session/prompt", "session/rename", "session/selectModel", "session/updateQueue",
  "workspace/archiveSession", "workspace/create", "workspace/insertBefore",
  "workspace/insertSessionBefore", "workspace/rename", "workspace/delete",
  "subagents/list", "subagents/prompt", "subagents/interruptByParent",
  ...USER_READ_ONLY_TYPERT_METHODS, ...USER_DIRECTORY_TYPERT_METHODS,
]);

export async function authorizeRpc(body: Record<string, unknown>, options: RpcPolicyOptions, routeMethod?: string): Promise<RpcDecision> {
  const declaredMethod = typeof body.method === "string" ? body.method : "";
  const wireMethod = routeMethod ?? declaredMethod;
  const method = canonicalMethod(wireMethod);
  const args = rpcArgs(body);
  const policy = accessPolicy(options.user, options.roots);
  const decision: RpcDecision = { body, method, args };
  if (!wireMethod || !declaredMethod || (routeMethod !== undefined && routeMethod !== declaredMethod)) return { ...decision, denied: "INVALID_RPC" };
  if (options.user.role !== "admin" && wireMethod.includes("/") && !USER_TYPERT_METHODS.has(wireMethod)) return { ...decision, denied: "CAPABILITY_NOT_ALLOWED" };
  if (options.user.role !== "admin" && ADMIN_ONLY_METHODS.has(method) && !READ_ONLY_CATALOG_METHODS.has(method) && !isUserOnboardingMutation(method, args)) return { ...decision, denied: "CAPABILITY_NOT_ALLOWED" };
  if (options.user.role !== "admin" && method.startsWith("dynamicCordisRunner.")) return { ...decision, denied: "CAPABILITY_NOT_ALLOWED" };
  if (method === "host.pickDirectory" && options.user.role !== "admin") return { ...decision, denied: "WORKSPACE_SELECTION_NOT_ALLOWED" };
  if (wireMethod === "agentPresets/select") {
    // 官方 descriptor 使用 agentId，必须检查实际执行对象，不能被额外的
    // sessionId 字段替换；原始参数保持不变，交由上游继续校验契约。
    const agentId = stringValue(args.agentId);
    if (!agentId || !stringValue(args.agentPreset)) return { ...decision, denied: "INVALID_RPC" };
    if (!(await ownsResource(options, "session", agentId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
  }
  if (method === "agentPreset.select") {
    const requested = stringValue(args.agentPreset) ?? stringValue(args.presetId);
    if (requested && !policy.allowedPresets.includes(requested)) return { ...decision, denied: "PRESET_NOT_ALLOWED" };
  }
  if (method === "agentPreset.read") {
    const requested = stringValue(args.agentPreset);
    if (requested && !policy.allowedPresets.includes(requested)) return { ...decision, denied: "PRESET_NOT_ALLOWED" };
  }
  if (method === "session.create") {
    const request = recordValue(args.request);
    const requested = stringValue(request?.agentPreset) ?? stringValue(args.agentPreset);
    if (requested && !policy.allowedPresets.includes(requested)) return { ...decision, denied: "PRESET_NOT_ALLOWED" };
    // 官方 slash Remote 的 session/create descriptor 只接受 request 中声明的
    // 字段；当前线上 descriptor 不包含 agentPreset。即使客户端带来该字段，
    // 也只用于权限校验，不能再回写到嵌套 request，否则网关会返回
    // gateway/arguments-invalid（unexpected "agentPreset"）。
    const nextRequest: Record<string, unknown> = request ? { ...request } : {};
    // 该字段仅用于上面的 preset 白名单校验，不能透传给官方 descriptor。
    if (request) delete nextRequest.agentPreset;
    const nextArgs: Record<string, unknown> = request
      ? { ...args, request: nextRequest }
      : { ...args, agentPreset: requested ?? policy.defaultPreset };
    const sessionId = stringValue(nextRequest.sessionId) ?? stringValue(nextArgs.sessionId);
    if (sessionId && !(await ownsResource(options, "session", sessionId))) {
      const existing = await options.service.findResource("session", sessionId);
      if (existing && existing.userId !== options.user.id) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
    }
    const workspaceId = stringValue(nextRequest.workspaceId) ?? stringValue(nextArgs.workspaceId);
    if (workspaceId && !(await ownsResource(options, "workspace", workspaceId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
    const cwd = stringValue(nextRequest.cwd) ?? stringValue(nextArgs.cwd) ?? policy.workspaceRoot;
    if (options.user.role !== "admin" && !(await isPathWithinReal(policy.workspaceRoot, cwd))) return { ...decision, denied: "WORKSPACE_PATH_NOT_ALLOWED" };
    return { ...decision, body: withArgs(body, nextArgs), args: nextArgs };
  }
  if (method === "host.listDirectory" || method === "directoryPicker.list") {
    const path = stringValue(args.path) ?? policy.workspaceRoot;
    if (options.user.role !== "admin" && !(await isPathWithinReal(policy.workspaceRoot, path))) return { ...decision, denied: "WORKSPACE_PATH_NOT_ALLOWED" };
    const nextArgs = options.user.role === "admin" ? args : { ...args, path };
    return { ...decision, body: withArgs(body, nextArgs), args: nextArgs };
  }
  if (method === "host.createDirectory" || method === "directoryPicker.createDirectory") {
    const path = stringValue(args.path) ?? policy.workspaceRoot;
    const name = stringValue(args.name);
    if (!name || !safeDirectoryName(name)) return { ...decision, denied: "INVALID_REQUEST" };
    if (options.user.role !== "admin" && (!(await isPathWithinReal(policy.workspaceRoot, path)) || !(await isPathWithinReal(policy.workspaceRoot, resolve(path, name))))) return { ...decision, denied: "WORKSPACE_PATH_NOT_ALLOWED" };
    const nextArgs = { ...args, path, name };
    return { ...decision, body: withArgs(body, nextArgs), args: nextArgs };
  }
  if (method === "session.export" && !stringValue(args.sessionId)) return { ...decision, denied: "INVALID_RPC" };
  if (method === "workspace.create") {
    // 新版 Remote 只接受 request，路径校验必须读取同一层级。
    if (wireMethod === "workspace/create") {
      const request = recordValue(args.request);
      const path = stringValue(request?.path);
      if (!path) return { ...decision, denied: "INVALID_REQUEST" };
      if (options.user.role !== "admin" && !(await isPathWithinReal(policy.workspaceRoot, path))) return { ...decision, denied: "WORKSPACE_PATH_NOT_ALLOWED" };
      return decision;
    }
    const path = stringValue(args.path) ?? policy.workspaceRoot;
    if (options.user.role !== "admin" && !(await isPathWithinReal(policy.workspaceRoot, path))) return { ...decision, denied: "WORKSPACE_PATH_NOT_ALLOWED" };
    return { ...decision, body: withArgs(body, { ...args, path }), args: { ...args, path } };
  }
  if (REFERENCE_METHODS.has(method) && !stringValue(args.agentId)) return { ...decision, denied: "INVALID_RPC" };
  if (SESSION_ID_REQUIRED_METHODS.has(method) && sessionIds(method, args).length === 0) return { ...decision, denied: "INVALID_RPC" };
  if (SESSION_METHODS.has(method)) {
    for (const sessionId of sessionIds(method, args)) {
      if (!(await ownsResource(options, "session", sessionId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
    }
  }
  if (WORKSPACE_METHODS.has(method)) {
    const workspaceId = stringValue(args.workspaceId);
    if (workspaceId && !(await ownsResource(options, "workspace", workspaceId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
    const beforeWorkspaceId = stringValue(args.beforeWorkspaceId);
    if (method === "workspace.insertBefore" && beforeWorkspaceId && !(await ownsResource(options, "workspace", beforeWorkspaceId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
    const beforeSessionId = stringValue(args.beforeSessionId);
    if (method === "workspace.insertSessionBefore" && beforeSessionId && !(await ownsResource(options, "session", beforeSessionId))) return { ...decision, denied: "RESOURCE_NOT_ALLOWED" };
  }
  return decision;
}

export async function filterRpcResponse(body: Record<string, unknown>, decision: RpcDecision, options: RpcPolicyOptions): Promise<Record<string, unknown>> {
  if (decision.method === "dsh-web-ui-settings.describe" && options.user.role !== "admin" && body.ok === true) {
    const value = body.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...body, value: { ...(value as Record<string, unknown>), writable: false } };
    }
  }
  const result = body.result;
  if (!result || typeof result !== "object") return body;
  const value = (result as Record<string, unknown>).value;
  const policy = accessPolicy(options.user, options.roots);
  if (Array.isArray(value)) {
    if (decision.method !== "sessionReferenceResolver.candidates" || options.user.role === "admin") return body;
    const filtered = await filterItems(value, "session", options, (item) => stringValue(item.sessionId));
    const sanitized = filtered.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const item = { ...(candidate as Record<string, unknown>) };
      const cwd = stringValue(item.cwd);
      if (!cwd) return item;
      const display = publicWorkspacePath(cwd, policy.workspaceRoot);
      if (display) item.cwd = display;
      else delete item.cwd;
      return item;
    });
    return { ...body, result: { ...(result as Record<string, unknown>), value: sanitized } };
  }
  // RPC values may be arrays (for example dynamicCordisRunner.inventory).
  // Only object-shaped API values can be policy-filtered without changing the
  // wire contract expected by the generated Typert codec.
  if (!value || typeof value !== "object" || Array.isArray(value)) return body;
  const nextValue = { ...(value as Record<string, unknown>) };
  if (decision.method === "settings.describe" && options.user.role !== "admin") {
    // 浏览器需要 settings mirror 才能把模型目录与配置地址合并；普通用户
    // 只拿到脱敏值，并明确收到只读状态，写 RPC 仍在 authorizeRpc 处拒绝。
    nextValue.writable = false;
    if (Array.isArray(nextValue.namespaces)) {
      nextValue.namespaces = nextValue.namespaces.filter((namespace) => {
        if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) return false;
        const ns = stringValue((namespace as Record<string, unknown>).ns) ?? "";
        return ns === "agent-default-model" || ns === "ui-onboarding" || ns.startsWith("llm-");
      });
    }
  }
  if (decision.method === "credentials.describe" && options.user.role !== "admin") {
    const credentials = nextValue.credentials;
    if (credentials && typeof credentials === "object" && !Array.isArray(credentials)) {
      nextValue.credentials = Object.fromEntries(Object.entries(credentials).map(([ref, entry]) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [ref, entry];
        return [ref, { ...(entry as Record<string, unknown>), writable: false }];
      }));
    }
  }
  if (decision.method === "host.describe" && options.user.role !== "admin") {
    const version = stringValue(nextValue.version) ?? "unknown";
    return { ...body, result: { ...(result as Record<string, unknown>), value: {
      version,
      cwd: policy.workspaceRoot,
      home: policy.workspaceRoot,
      attachedSessions: 0,
      canOpenPath: false,
    } } };
  }
  if ((decision.method === "host.listDirectory" || decision.method === "directoryPicker.list") && options.user.role !== "admin") await sanitizeDirectoryListing(nextValue, policy.workspaceRoot);
  if ((decision.method === "host.createDirectory" || decision.method === "directoryPicker.createDirectory") && options.user.role !== "admin") await sanitizeCreatedDirectory(nextValue, policy.workspaceRoot);
  if (decision.method === "agentPreset.list" || decision.method === "agentPresets.list") {
    const key = Array.isArray(nextValue.presets) ? "presets" : Array.isArray(nextValue.items) ? "items" : undefined;
    if (key) nextValue[key] = (nextValue[key] as unknown[]).filter((item) => item && typeof item === "object" && policy.allowedPresets.includes(stringValue((item as Record<string, unknown>).id) ?? ""));
  }
  if (decision.method === "session.list" && Array.isArray(nextValue.items)) {
    nextValue.items = await filterSessionItems(nextValue.items, options, (item) => stringValue(item.sessionId));
  }
  if (decision.method === "session.search" && Array.isArray(nextValue.items)) {
    nextValue.items = await filterItems(nextValue.items, "session", options, (item) => stringValue(item.sessionId));
  }
  if (decision.method === "workspace.list") {
    if (Array.isArray(nextValue.items)) {
      nextValue.items = await filterWorkspaceItems(nextValue.items, options);
    }
    if (Array.isArray(nextValue.archivedSessionIds)) {
      nextValue.archivedSessionIds = await filterOwnedIds(nextValue.archivedSessionIds, options, "session");
    }
  }
  if (nextValue.workspace && typeof nextValue.workspace === "object" && !Array.isArray(nextValue.workspace)) {
    const workspace = await sanitizeWorkspace(nextValue.workspace, options);
    if (workspace) nextValue.workspace = workspace;
    else delete nextValue.workspace;
  }
  const session = stringValue(nextValue.sessionId);
  if ((decision.method === "session.create" || decision.method === "session.fork") && session) {
    const request = recordValue(decision.args.request);
    const inheritedPath = stringValue(request?.cwd)
      ?? stringValue(decision.args.cwd)
      ?? (decision.method === "session.fork" ? (await resourcePath(options, "session", stringValue(request?.sessionId) ?? stringValue(decision.args.sessionId))) : undefined)
      ?? policy.workspaceRoot;
    if (await isPathWithinReal(policy.workspaceRoot, inheritedPath) || options.user.role === "admin") await options.service.saveResource({ resourceType: "session", resourceId: session, userId: options.user.id, resourcePath: inheritedPath, createdAt: new Date().toISOString() });
  }
  const workspace = nextValue.workspace;
  if (decision.method === "workspace.create" && workspace && typeof workspace === "object") {
    const workspaceRecord = workspace as Record<string, unknown>;
    const workspaceId = stringValue(workspaceRecord.workspaceId);
    const path = stringValue(workspaceRecord.path);
    if (workspaceId && (!path || await isPathWithinReal(policy.workspaceRoot, path) || options.user.role === "admin")) await options.service.saveResource({ resourceType: "workspace", resourceId: workspaceId, userId: options.user.id, resourcePath: path ?? null, createdAt: new Date().toISOString() });
  }
  return { ...body, result: { ...(result as Record<string, unknown>), value: nextValue } };
}

function isUserOnboardingMutation(method: string, args: Record<string, unknown>): boolean {
  if (method !== "settings.mutate" || args.ns !== "ui-onboarding" || !Array.isArray(args.ops) || args.ops.length !== 1) return false;
  const op = args.ops[0];
  if (!op || typeof op !== "object" || Array.isArray(op)) return false;
  const record = op as Record<string, unknown>;
  return record.op === "set"
    && Array.isArray(record.path)
    && record.path.length === 1
    && record.path[0] === "welcomeNoticeVersion"
    && typeof record.value === "string"
    && /^\d{4}-\d{2}-\d{2}\.\d+$/u.test(record.value);
}

async function filterSessionItems(items: unknown[], options: RpcPolicyOptions, idOf: (item: Record<string, unknown>) => string | undefined): Promise<unknown[]> {
  const visible = await filterItems(items, "session", options, idOf);
  const output: unknown[] = [];
  for (const candidate of visible) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = { ...(candidate as Record<string, unknown>) };
    const parentSessionId = stringValue(item.parentSessionId);
    if (parentSessionId && !(await ownsResource(options, "session", parentSessionId))) delete item.parentSessionId;
    output.push(item);
  }
  return output;
}

async function filterWorkspaceItems(items: unknown[], options: RpcPolicyOptions): Promise<unknown[]> {
  const visible = await filterItems(items, "workspace", options, (item) => stringValue(item.workspaceId), (item) => stringValue(item.path));
  const output: unknown[] = [];
  for (const candidate of visible) {
    const workspace = await sanitizeWorkspace(candidate, options);
    if (workspace) output.push(workspace);
  }
  return output;
}

async function sanitizeWorkspace(value: unknown, options: RpcPolicyOptions): Promise<Record<string, unknown> | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const workspace = value as Record<string, unknown>;
  const workspaceId = stringValue(workspace.workspaceId);
  if (!workspaceId || !(await visibleWorkspace(options, workspaceId, stringValue(workspace.path)))) return undefined;
  const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
  return { ...workspace, sessionIds: await filterOwnedIds(sessionIds, options, "session") };
}

async function filterOwnedIds(values: unknown[], options: RpcPolicyOptions, type: "session" | "workspace"): Promise<string[]> {
  const output: string[] = [];
  for (const value of values) if (typeof value === "string" && await ownsResource(options, type, value)) output.push(value);
  return output;
}

async function filterItems(items: unknown[], type: "session" | "workspace", options: RpcPolicyOptions, idOf: (item: Record<string, unknown>) => string | undefined, pathOf?: (item: Record<string, unknown>) => string | undefined): Promise<unknown[]> {
  const policy = accessPolicy(options.user, options.roots);
  const output: unknown[] = [];
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = idOf(item);
    if (!id) continue;
    if (options.user.role === "admin") { output.push(candidate); continue; }
    const path = pathOf?.(item) ?? stringValue(item.cwd);
    const resource = await options.service.findResource(type, id);
    if (resource) {
      if (resource.userId === options.user.id) output.push(candidate);
      continue;
    }
    if (path && await isPathWithinReal(policy.workspaceRoot, path)) {
      output.push(candidate);
      await options.service.saveResource({ resourceType: type, resourceId: id, userId: options.user.id, resourcePath: path, createdAt: new Date().toISOString() });
    }
  }
  return output;
}

async function visibleWorkspace(options: RpcPolicyOptions, id: string, path: string | undefined): Promise<boolean> {
  if (options.user.role === "admin") return true;
  const resource = await options.service.findResource("workspace", id);
  if (resource) return resource.userId === options.user.id;
  const policy = accessPolicy(options.user, options.roots);
  return Boolean(path && await isPathWithinReal(policy.workspaceRoot, path));
}

async function ownsResource(options: RpcPolicyOptions, type: "session" | "workspace", id: string): Promise<boolean> {
  if (options.user.role === "admin") return true;
  const resource = await options.service.findResource(type, id);
  return resource?.userId === options.user.id;
}

async function resourcePath(options: RpcPolicyOptions, type: "session" | "workspace", id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  return (await options.service.findResource(type, id))?.resourcePath ?? undefined;
}

function rpcArgs(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload;
  if (!payload || typeof payload !== "object") return {};
  const args = (payload as Record<string, unknown>).args;
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : payload as Record<string, unknown>;
}

function withArgs(body: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload;
  if (!payload || typeof payload !== "object") return body;
  const payloadRecord = payload as Record<string, unknown>;
  const nextPayload = Object.hasOwn(payloadRecord, "args") ? { ...payloadRecord, args } : { ...payloadRecord, ...args };
  return { ...body, payload: nextPayload };
}

function sessionIds(method: string, args: Record<string, unknown>): string[] {
  if (method.startsWith("messageFeedback.")) {
    const request = recordValue(args.request);
    const sessionId = stringValue(request?.sessionId);
    return sessionId ? [sessionId] : [];
  }
  if (method.startsWith("subagent.") || method.startsWith("subagents.")) {
    const request = recordValue(args.request);
    return [
      stringValue(args.parentSessionId), stringValue(args.childSessionId),
      stringValue(request?.parentSessionId), stringValue(request?.childSessionId),
    ].filter((value): value is string => value !== undefined);
  }
  const request = recordValue(args.request);
  const sessionId = stringValue(args.sessionId) ?? stringValue(args.agentId) ?? stringValue(request?.sessionId);
  return sessionId ? [sessionId] : [];
}

function canonicalMethod(method: string): string {
  if (method === "agentPresets/select") return "agentPreset.select";
  const slash = method.indexOf("/");
  if (slash < 0) return method;
  const namespace = method.slice(0, slash) === "goals" ? "goal" : method.slice(0, slash);
  return `${namespace}.${method.slice(slash + 1)}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

function publicWorkspacePath(path: string, root: string): string | undefined {
  const nested = relative(root, path);
  if (nested === "") return "~";
  if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) return undefined;
  return `~/${nested.split(sep).join("/")}`;
}

function safeDirectoryName(value: string): boolean {
  return value !== "." && value !== ".." && value.trim().length > 0 && !/[\\/\u0000]/u.test(value);
}

async function sanitizeDirectoryListing(value: Record<string, unknown>, root: string): Promise<void> {
  const path = stringValue(value.path);
  if (!path || !(await isPathWithinReal(root, path))) {
    value.path = root;
    value.crumbs = [];
    value.entries = [];
    value.truncated = false;
    value.home = root;
    return;
  }
  value.home = root;
  value.crumbs = await filterDirectoryEntries(value.crumbs, root);
  value.entries = await filterDirectoryEntries(value.entries, root);
}

async function filterDirectoryEntries(value: unknown, root: string): Promise<unknown[]> {
  if (!Array.isArray(value)) return [];
  const result: unknown[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const path = stringValue((item as Record<string, unknown>).path);
    if (path && await isPathWithinReal(root, path)) result.push(item);
  }
  return result;
}

async function sanitizeCreatedDirectory(value: Record<string, unknown>, root: string): Promise<void> {
  const path = stringValue(value.path);
  if (!path) return;
  if (!(await isPathWithinReal(root, path))) delete value.path;
}

export function authorizeClientResponse(body: Record<string, unknown>): RpcDecision {
  const decision: RpcDecision = { body, method: "client-response", args: {} };
  if (body.type !== "client-response" || !stringValue(body.rpcId) || !recordValue(body.result)) return { ...decision, denied: "INVALID_RPC" };
  return decision;
}
