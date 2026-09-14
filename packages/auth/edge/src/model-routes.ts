import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { constantTimeEqual } from "dsh-lark-auth";
import type { AuthService } from "dsh-lark-auth";

import type { AuthEdgeConfig } from "./config.js";
import { readJson, sendError, sendJson } from "./http-utils.js";
import {
  assertPublicUserModelUrl,
  isLoopbackAddress,
  parsePositiveInteger,
  requireOnlyKeys,
  userModelProfileId,
} from "./server-helpers.js";
import { httpError } from "./http-utils.js";

export const INTERNAL_MODEL_RESOLVE_PATH = "/internal/models/resolve";
const MODEL_ROUTE_CAPABILITY_TTL_MS = 5 * 60_000;
const MAX_MODEL_ROUTE_CAPABILITIES = 10_000;

export interface ModelRouteCapability {
  userId: string;
  sessionId: string;
  rpcId: string;
  profileId: string;
  revision: number;
  model: string;
  expiresAt: number;
}

interface InternalModelRouteRequest {
  sessionId: string;
  rpcId: string;
  capability: string;
  profileId: string;
  revision: number;
  model: string;
}

export interface ModelRouteDeps {
  config: AuthEdgeConfig;
  service: AuthService;
}

function parseInternalModelRouteRequest(body: Record<string, unknown>): InternalModelRouteRequest {
  requireOnlyKeys(body, ["sessionId", "rpcId", "capability", "profileId", "revision", "model"]);
  if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256
    || typeof body.rpcId !== "string" || !body.rpcId || body.rpcId.length > 256
    || typeof body.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.capability)
    || typeof body.profileId !== "string" || !userModelProfileId(`/auth/models/${body.profileId}`)
    || typeof body.model !== "string" || !body.model || body.model.length > 256) {
    throw httpError(400, "INVALID_REQUEST");
  }
  return {
    sessionId: body.sessionId,
    rpcId: body.rpcId,
    capability: body.capability,
    profileId: body.profileId.toLowerCase(),
    revision: parsePositiveInteger(body.revision),
    model: body.model,
  };
}

/** Worker 私有模型路由：短期一次性能力签发、内部解析与 scope 绑定。 */
export class ModelRouteBridge {
  /** Worker 解析私有路由必须同时出示的短期、一次性能力。 */
  readonly #capabilities = new Map<string, ModelRouteCapability>();

  constructor(private readonly deps: ModelRouteDeps) {}

  issue(input: Omit<ModelRouteCapability, "expiresAt">): string {
    this.#prune();
    while (this.#capabilities.size >= MAX_MODEL_ROUTE_CAPABILITIES) {
      const oldest = this.#capabilities.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#capabilities.delete(oldest);
    }
    const capability = randomBytes(32).toString("base64url");
    this.#capabilities.set(capability, { ...input, expiresAt: Date.now() + MODEL_ROUTE_CAPABILITY_TTL_MS });
    return capability;
  }

  /**
   * Worker 仅能经 loopback + WORKER_TOKEN 换取一条短生命周期路由。此接口不
   * 接受浏览器 Cookie，且 scope 中的无密钥 routeRef 与当前 Profile 版本必须一致。
   */
  async resolveInternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, service } = this.deps;
    const token = config.workerToken;
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!isLoopbackAddress(req.socket.remoteAddress)) { sendError(res, 403, "LOOPBACK_REQUIRED"); return; }
    if (!token) { sendError(res, 503, "MODEL_ROUTE_NOT_CONFIGURED"); return; }
    if (!authorization.startsWith("Bearer ") || !constantTimeEqual(authorization.slice(7), token)) { sendError(res, 401, "UNAUTHORIZED"); return; }
    const input = parseInternalModelRouteRequest(await readJson(req, config.requestBodyLimit));
    const capability = this.#consume(input);
    if (!capability) { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    const route = await service.resolveMyModelRoute(capability.userId, input.profileId, input.revision, input.model);
    if (!route) { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    // 每次实际出站前重新解析，不能只依赖保存配置时的 DNS 结果。
    try { await assertPublicUserModelUrl(route.baseUrl); } catch { sendError(res, 404, "MODEL_ROUTE_NOT_AVAILABLE"); return; }
    // 此响应仅送往 Worker loopback；不写审计/日志，调用方必须在 stream 结束后释放。
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, { route });
  }

  async bindScope(binding: unknown): Promise<void> {
    const { config } = this.deps;
    if (!config.workerToken) throw new Error("WORKER_AUTH_BRIDGE_UNAVAILABLE");
    const response = await fetch(new URL("/internal/web-auth/scope", config.workerBaseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${config.workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(binding),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("WORKER_SCOPE_BRIDGE_UNAVAILABLE");
  }

  #consume(input: InternalModelRouteRequest): ModelRouteCapability | undefined {
    this.#prune();
    const hit = this.#capabilities.get(input.capability);
    if (!hit || hit.expiresAt < Date.now()
      || hit.sessionId !== input.sessionId || hit.rpcId !== input.rpcId
      || hit.profileId !== input.profileId || hit.revision !== input.revision || hit.model !== input.model) return undefined;
    // 首次解析后立即消费；工具续轮由同一 Worker stream 保持临时路由，绝不再取 Key。
    this.#capabilities.delete(input.capability);
    return hit;
  }

  #prune(now = Date.now()): void {
    for (const [capability, entry] of this.#capabilities) if (entry.expiresAt < now) this.#capabilities.delete(capability);
  }
}
