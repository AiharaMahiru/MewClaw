/**
 * dsh-lark-admin 插件入口（SPEC admin.md）。
 *
 * 管理面宿主插件：向 webServer 注册知识管理 API（快照/文档/摄入任务/
 * 生命周期）与 admin-web 静态面。admin 身份 Scope 来自配置（浏览器
 * Scope 仅在此创建），一切数据访问经 ctx.knowledge 的 ACL 谓词——
 * admin 不绕过查询 ACL。
 *
 * 鉴权语义：无论监听地址如何，adminTokenEnv 都必须配置；缺失时装载
 * 失败。Bearer 比较恒定时间，令牌值绝不出现在日志或响应。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
// webServer 服务的 Context 增强（dsh-host-webserver 声明合并随本导入生效）。
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "dsh-lark-billing";
import {
  parseBotId,
  parseDeploymentId,
  parseTenantId,
  parseUserId,
  type Scope,
} from "dsh-lark-contracts";
import {
  parseDocumentId,
  type DocumentId,
  type KnowledgeCategory,
  type KnowledgeDocument,
  type KnowledgeVisibility,
} from "dsh-knowledge";
import { parseCubeId, parseMemoryCommand, parseMemoryId, type MemoryService } from "dsh-memory";

import {
  Config as ConfigSchema,
  parseIngestionRunLimit,
  resolveAdminLimits,
  type Config as AdminConfig,
} from "./config.js";
import { ControlPlaneError, createControlPlane } from "./control-plane.js";
import { registerControlRoutes } from "./control-routes.js";
import { registerBillingRoutes } from "./billing-routes.js";
import {
  constantTimeEqual,
  HttpInputError,
  pathnameOf,
  queryParams,
  readJsonBody,
  readRawBody,
  sendError,
  sendJson,
  sendNoContent,
  serveStatic,
} from "./http.js";
import { registerUserBillingRoutes } from "./user-billing-routes.js";
import { saveUpload } from "./upload.js";

export const name = "lark-admin";

export const inject = ["credentials", "knowledge", "memory", "billing", "webServer"];

export const Config = ConfigSchema;
export type Config = AdminConfig;

const ADMIN_CONVERSATION = "admin-console";
const CATEGORIES: readonly KnowledgeCategory[] = [
  "general", "product_manual", "technical_spec", "project_document", "policy_process", "faq",
];
const MAX_TAGS = 8;
const MAX_ACTION_BODY_BYTES = 16 * 1024;

/** admin 身份 → 完整 Scope（ID 形态非法 fail loud at load）。 */
export function resolveAdminScope(config: AdminConfig["identity"]): Scope {
  const tenant = parseTenantId(config.tenantId);
  const bot = parseBotId(config.botId);
  const deployment = parseDeploymentId(config.deploymentId);
  const user = parseUserId(config.adminUserId);
  if (!tenant.ok || !bot.ok || !deployment.ok || !user.ok) {
    throw new Error("lark-admin: identity 配置包含非法 ID 形态（tenant/bot/deployment/user 须为品牌化形态）");
  }
  return {
    tenantId: tenant.value,
    botId: bot.value,
    deploymentId: deployment.value,
    userId: user.value,
    conversationId: ADMIN_CONVERSATION as Scope["conversationId"],
  };
}

export async function apply(ctx: Context, config: AdminConfig): Promise<void> {
  const webServer = ctx.webServer!;
  const knowledge = ctx.knowledge!;
  const memory = ctx.memory as MemoryService | undefined;
  const billing = ctx.billing;

  const scope = resolveAdminScope(config.identity);
  const { maxUploadBytes, defaultRunLimit } = resolveAdminLimits(config);
  const webRoot = config.webRoot || "apps/admin-web/dist";

  /** 令牌装载：缺失时让 Cordis 拒绝当前插件启动。 */
  const resolved = await ctx.credentials!.resolve(config.adminTokenEnv as CredentialRef);
  if (!resolved?.value) {
    throw new Error(`lark-admin: 凭证引用未配置（${config.adminTokenEnv}）`);
  }
  const token = resolved.value;
  const control = config.controlPlane
    ? await createControlPlane(config.controlPlane, ctx.credentials!)
    : undefined;

  /** 鉴权守卫：Bearer 恒定时间比较（无令牌配置时不放行——fail closed）。 */
  const authorized = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const header = req.headers.authorization || "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (provided && constantTimeEqual(provided, token)) return true;
    sendError(res, 401, "UNAUTHORIZED");
    return false;
  };

  /** 统一异常信封：业务/输入错误 → 对应状态码；未知 → 500。 */
  const guard = async (req: IncomingMessage, res: ServerResponse, handler: () => Promise<void>): Promise<void> => {
    try {
      await handler();
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendError(res, error.status, error.errorCode);
        return;
      }
      if (error instanceof ControlPlaneError) {
        sendError(res, error.status, error.code);
        return;
      }
      ctx.logger.error(`lark-admin: 请求失败：${error instanceof Error ? error.message : "unknown error"}`);
      sendError(res, 500, "INTERNAL_ERROR");
    }
  };

  /** 摄入上传：原始字节体 + 查询参数元数据（自研零依赖 wire 格式）。 */
  const handleUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = queryParams(req);
    const name = (params.get("name") || "").trim();
    const mime = (params.get("mime") || "application/octet-stream").trim();
    const visibility = params.get("visibility") === "bot_shared" ? "bot_shared" : "user_private";
    const category = params.get("category") || "general";
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(params.get("tags") || "[]");
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string").slice(0, MAX_TAGS);
    } catch {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (!name || !CATEGORIES.includes(category as KnowledgeCategory)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const content = await readRawBody(req, maxUploadBytes);
    const sourcePath = await saveUpload(config.uploadsRoot, scope, name, content);
    const run = await knowledge.ingest(scope, {
      sourcePath,
      sourceName: name,
      sourceMime: mime,
      category: category as KnowledgeCategory,
      tags,
    }, visibility as KnowledgeVisibility);
    sendJson(res, 202, run);
  };

  /** 文档生命周期动作：archive/restore/set_visibility/reindex（404 不泄露存在性）。 */
  const handleAction = async (req: IncomingMessage, res: ServerResponse, docId: DocumentId): Promise<void> => {
    const body = await readJsonBody(req, MAX_ACTION_BODY_BYTES);
    let document: KnowledgeDocument | undefined;
    if (body.action === "archive") document = await knowledge.archive(scope, docId);
    else if (body.action === "restore") document = await knowledge.restore(scope, docId);
    else if (body.action === "set_visibility") {
      if (body.visibility !== "user_private" && body.visibility !== "bot_shared") {
        sendError(res, 400, "INVALID_REQUEST");
        return;
      }
      document = await knowledge.moveVisibility(scope, docId, body.visibility);
    } else if (body.action === "reindex") document = await knowledge.reindex(scope, docId, { force: true });
    else { sendError(res, 400, "INVALID_REQUEST"); return; }
    if (!document) { sendError(res, 404, "NOT_FOUND"); return; }
    sendJson(res, 200, document);
  };

  // ── 知识管理 API ─────────────────────────────────────────────
  // 路由注册经 ctx.effect 可逆（host-webserver 的 register 是裸 Map 插入，
  // 不绑定调用方上下文——不包 effect 则插件卸载后路由残留）。
  ctx.effect(() => webServer.register({
    kind: "prefix",
    path: "/api/admin/knowledge",
    handler: (req, res) => {
      void guard(req, res, async () => {
        if (!await authorized(req, res)) return;
        const pathname = pathnameOf(req).slice("/api/admin/knowledge".length) || "/";
        if (req.method === "GET" && pathname === "/") {
          sendJson(res, 200, await knowledge.snapshot(scope));
          return;
        }
        if (req.method === "GET" && pathname === "/uploads") {
          const runs = await knowledge.ingestionRuns(
            scope,
            parseIngestionRunLimit(queryParams(req).get("limit"), defaultRunLimit),
          );
          sendJson(res, 200, { runs });
          return;
        }
        const uploadMatch = /^\/uploads\/([0-9a-f-]{36})$/.exec(pathname);
        if (req.method === "GET" && uploadMatch) {
          const run = await knowledge.ingestionRun(scope, uploadMatch[1]!);
          if (!run) { sendError(res, 404, "NOT_FOUND"); return; }
          sendJson(res, 200, run);
          return;
        }
        if (req.method === "POST" && pathname === "/uploads") {
          await handleUpload(req, res);
          return;
        }
        const actionMatch = /^\/documents\/([0-9a-f-]{36})\/action$/.exec(pathname);
        if (req.method === "POST" && actionMatch) {
          const parsed = parseDocumentId(actionMatch[1]);
          if (!parsed.ok) { sendError(res, 404, "NOT_FOUND"); return; }
          await handleAction(req, res, parsed.value);
          return;
        }
        const documentGet = /^\/documents\/([0-9a-f-]{36})$/.exec(pathname);
        if (req.method === "GET" && documentGet) {
          const document = await knowledge.getDocument(scope, documentGet[1] as DocumentId);
          if (!document) { sendError(res, 404, "NOT_FOUND"); return; }
          sendJson(res, 200, document);
          return;
        }
        sendError(res, 404, "NOT_FOUND");
      });
    },
  }));

  // ── 图记忆管理 API：同一 admin 身份仍经过 ctx.memory 的 Scope ACL ─────
  if (memory) ctx.effect(() => webServer.register({
    kind: "prefix",
    path: "/api/admin/memory",
    handler: (req, res) => {
      void guard(req, res, async () => {
        if (!await authorized(req, res)) return;
        const pathname = pathnameOf(req).slice("/api/admin/memory".length) || "/";
        if (req.method === "GET" && pathname === "/") {
          sendJson(res, 200, await memory.execute(scope, { op: "cube_list" }));
          return;
        }
        if (req.method === "GET" && pathname === "/search") {
          const query = queryParams(req).get("q")?.trim();
          if (!query) { sendError(res, 400, "INVALID_REQUEST"); return; }
          sendJson(res, 200, await memory.execute(scope, { op: "search", query, limit: 50 }));
          return;
        }
        if (req.method === "POST" && pathname === "/command") {
          const parsed = parseMemoryCommand(await readJsonBody(req, MAX_ACTION_BODY_BYTES));
          if (!parsed.ok) { sendError(res, 400, "INVALID_REQUEST"); return; }
          sendJson(res, 200, await memory.execute(scope, parsed.value));
          return;
        }
        if (req.method === "POST" && pathname === "/compose") {
          const body = await readJsonBody(req, MAX_ACTION_BODY_BYTES);
          const parsed = parseMemoryCommand({ op: "compose", cubeIds: body.cubeIds, name: body.name });
          if (!parsed.ok) { sendError(res, 400, "INVALID_REQUEST"); return; }
          sendJson(res, 200, await memory.execute(scope, parsed.value));
          return;
        }
        if (req.method === "GET" && pathname === "/cubes") {
          sendJson(res, 200, await memory.execute(scope, { op: "cube_list" }));
          return;
        }
        const cubeMatch = /^\/cubes\/([0-9a-f-]{36})$/.exec(pathname);
        if (cubeMatch) {
          const id = parseCubeId(cubeMatch[1]);
          if (!id) { sendError(res, 404, "NOT_FOUND"); return; }
          if (req.method === "GET") {
            sendJson(res, 200, await memory.execute(scope, { op: "cube_read", id }));
            return;
          }
          if (req.method === "PATCH") {
            const body = await readJsonBody(req, MAX_ACTION_BODY_BYTES);
            const parsed = parseMemoryCommand({ op: "cube_update", id, patch: body.patch, expectedRevision: body.expectedRevision });
            if (!parsed.ok) { sendError(res, 400, "INVALID_REQUEST"); return; }
            sendJson(res, 200, await memory.execute(scope, parsed.value));
            return;
          }
          if (req.method === "DELETE") {
            sendJson(res, 200, await memory.execute(scope, { op: "cube_delete", id }));
            return;
          }
        }
        const nodeMatch = /^\/nodes\/([0-9a-f-]{36})$/.exec(pathname);
        if (req.method === "GET" && nodeMatch) {
          const id = parseMemoryId(nodeMatch[1]);
          if (!id) { sendError(res, 404, "NOT_FOUND"); return; }
          sendJson(res, 200, await memory.execute(scope, { op: "read", id, includeEdges: true }));
          return;
        }
        sendError(res, 404, "NOT_FOUND");
      });
    },
  }));

  // 控制面仅读取固定 worker 端点；独立 effect 让两条路由一起可逆撤销。
  ctx.effect(() => registerControlRoutes(webServer, control, async (req, res, handler) => {
    await guard(req, res, async () => {
      if (!await authorized(req, res)) return;
      await handler();
    });
  }));

  // 计费管理 API 与知识/控制面共用 admin Bearer；旧版无 Provider 时保留既有管理面。
  if (billing) {
    const protectBilling = async (req: IncomingMessage, res: ServerResponse, handler: () => Promise<void>): Promise<void> => {
      await guard(req, res, async () => {
        if (!await authorized(req, res)) return;
        await handler();
      });
    };
    ctx.effect(() => registerBillingRoutes(webServer, billing, scope, protectBilling));
    ctx.effect(() => registerUserBillingRoutes(webServer, billing, scope, protectBilling));
  }

  // ── 健康检查 ─────────────────────────────────────────────────
  ctx.effect(() => webServer.register({
    kind: "prefix",
    path: "/api/admin/healthz",
    handler: (req, res) => {
      void guard(req, res, async () => {
        if (!await authorized(req, res)) return;
        if (req.method !== "GET") { sendNoContent(res, 405); return; }
        try {
          await knowledge.ingestionRuns(scope, 1);
          sendJson(res, 200, { ok: true });
        } catch (error) {
          ctx.logger.error(`lark-admin: 数据库探活失败：${error instanceof Error ? error.message : "unknown error"}`);
          sendJson(res, 503, { ok: false });
        }
      });
    },
  }));

  // ── admin-web 静态面 ─────────────────────────────────────────
  ctx.effect(() => webServer.register({
    kind: "prefix",
    path: "/admin",
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") { sendNoContent(res, 405); return; }
      void serveStatic(req, res, webRoot, pathnameOf(req).slice("/admin".length));
    },
  }));
}
