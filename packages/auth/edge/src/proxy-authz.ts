import type { IncomingMessage } from "node:http";

import { isPathWithinReal } from "dsh-lark-auth";
import type { AuthService, AuthUser } from "dsh-lark-auth";

import { DEFAULT_PROXY_BODY_LIMIT, type AuthEdgeConfig } from "./config.js";
import { isJsonHeader, parseJson } from "./server-helpers.js";
import { readBody } from "./http-utils.js";

export interface ProxyAuthzDeps {
  config: AuthEdgeConfig;
  service: AuthService;
}

const SIDEBAR_PUBLIC_METHODS = new Set(["terminal.deps", "shell.get", "settings.get", "settings.update", "browser.probe"]);

export function isSidebarRequest(pathname: string): boolean { return pathname === "/sidebar" || pathname.startsWith("/sidebar/"); }

export function sidebarHtmlSessionId(pathname: string): string | undefined {
  if (!pathname.startsWith("/sidebar/html/")) return undefined;
  const value = pathname.slice("/sidebar/html/".length).split("/", 1)[0];
  try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
}

export async function authorizeSidebarRequest(deps: ProxyAuthzDeps, req: IncomingMessage, url: URL, user: AuthUser): Promise<{ body?: Buffer; denied?: string }> {
  if (url.pathname.startsWith("/sidebar/bundle")) return {};
  if (url.pathname.startsWith("/sidebar/file")) return sidebarDecision(deps.service, user, url.searchParams.get("sessionId"));
  if (url.pathname.startsWith("/sidebar/html")) return sidebarDecision(deps.service, user, sidebarHtmlSessionId(url.pathname));
  if (!url.pathname.startsWith("/sidebar/api/")) return {};
  if (req.method !== "POST") return { denied: "CAPABILITY_NOT_ALLOWED" };
  const method = url.pathname.slice("/sidebar/api/".length);
  const body = await readBody(req, deps.config.proxyBodyLimit ?? DEFAULT_PROXY_BODY_LIMIT);
  const parsed = parseJson(body);
  if (SIDEBAR_PUBLIC_METHODS.has(method)) return { body };
  // `subagents.live` uses the topology root name rather than the generic
  // sessionId field. It still must be fenced to the same owning session.
  const sessionId = typeof parsed.sessionId === "string"
    ? parsed.sessionId
    : method === "subagents.live" && typeof parsed.rootSessionId === "string"
      ? parsed.rootSessionId
      : undefined;
  const decision = await sidebarDecision(deps.service, user, sessionId);
  return decision.denied ? decision : { body };
}

export async function authorizeGitRequest(deps: ProxyAuthzDeps, req: IncomingMessage, url: URL, user: AuthUser): Promise<{ body?: Buffer; denied?: string }> {
  const bodyLimit = deps.config.proxyBodyLimit ?? DEFAULT_PROXY_BODY_LIMIT;
  if (req.method === "POST" && url.pathname === "/git/config") {
    return { body: await readBody(req, bodyLimit) };
  }
  let body: Buffer | undefined;
  let path: string | null = null;
  if (req.method === "POST" && isJsonHeader(req.headers["content-type"])) {
    body = await readBody(req, bodyLimit);
    const parsed = parseJson(body);
    path = typeof parsed.path === "string" ? parsed.path : null;
  } else if (req.method === "GET" && url.pathname === "/git/events") {
    path = url.searchParams.get("path");
  }
  const forwarded = body ? { body } : {};
  if (!path) return { ...forwarded, denied: "RESOURCE_NOT_ALLOWED" };
  if (user.role === "admin") return forwarded;
  const workspaces = await deps.service.listResources(user.id, "workspace");
  for (const workspace of workspaces) {
    const ownedPath = workspace.resourcePath;
    if (!ownedPath) continue;
    if (await isPathWithinReal(ownedPath, path) && await isPathWithinReal(path, ownedPath)) return forwarded;
  }
  return { ...forwarded, denied: "RESOURCE_NOT_ALLOWED" };
}

export async function sidebarDecision(service: AuthService, user: AuthUser, sessionId: string | null | undefined): Promise<{ denied?: string }> {
  if (!sessionId || user.role === "admin") return user.role === "admin" ? {} : { denied: "RESOURCE_NOT_ALLOWED" };
  const resource = await service.findResource("session", sessionId);
  return resource?.userId === user.id ? {} : { denied: "RESOURCE_NOT_ALLOWED" };
}
