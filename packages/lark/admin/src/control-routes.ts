import type { IncomingMessage, ServerResponse } from "node:http";

import {
  isControlTargetId,
  parseControlGeneration,
  type AdminControlPlane,
} from "./control-plane.js";
import { pathnameOf, queryParams, sendError, sendJson, sendNoContent } from "./http.js";

const CONVERSATIONS_PATH = "/api/admin/control/conversations";
const DASHBOARD_PATH = "/api/admin/dashboard";

interface RouteRegistrar {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void;
  }): () => void;
}

type ProtectedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  handler: () => Promise<void>,
) => Promise<void>;

function requireControl(control: AdminControlPlane | undefined): AdminControlPlane | undefined {
  return control;
}

async function dashboard(control: AdminControlPlane | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") return sendNoContent(response, 405);
  const active = requireControl(control);
  if (!active) return sendError(response, 409, "CONTROL_PLANE_DISABLED");
  sendJson(response, 200, await active.dashboard());
}

async function conversation(control: AdminControlPlane | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") return sendNoContent(response, 405);
  const targetId = pathnameOf(request).slice(CONVERSATIONS_PATH.length + 1);
  if (!isControlTargetId(targetId)) return sendError(response, 400, "INVALID_REQUEST");
  const active = requireControl(control);
  if (!active) return sendError(response, 409, "CONTROL_PLANE_DISABLED");
  sendJson(response, 200, await active.conversation(targetId, parseControlGeneration(queryParams(request).get("generation"))));
}

function protectedHandler(
  protect: ProtectedRoute,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => { void protect(request, response, () => handler(request, response)); };
}

/** 注册只读控制面，disposer 同时撤销 dashboard 与 conversations 两条路由。 */
export function registerControlRoutes(
  webServer: RouteRegistrar,
  control: AdminControlPlane | undefined,
  protect: ProtectedRoute,
): () => void {
  const removeDashboard = webServer.register({
    kind: "prefix",
    path: DASHBOARD_PATH,
    handler: protectedHandler(protect, (request, response) => dashboard(control, request, response)),
  });
  const removeConversations = webServer.register({
    kind: "prefix",
    path: CONVERSATIONS_PATH,
    handler: protectedHandler(protect, (request, response) => conversation(control, request, response)),
  });
  return () => {
    removeConversations();
    removeDashboard();
  };
}
