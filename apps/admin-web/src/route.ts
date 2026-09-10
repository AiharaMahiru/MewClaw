export type AppRoute = "dashboard" | "users" | "sessions" | "billing" | "conversations" | "knowledge";

const ROUTES: Record<AppRoute, string> = {
  dashboard: "/admin",
  users: "/admin/users",
  sessions: "/admin/sessions",
  billing: "/admin/billing",
  conversations: "/admin/conversations",
  knowledge: "/admin/knowledge",
};

export function pathForRoute(route: AppRoute): string {
  return ROUTES[route];
}

export function routeFromPath(pathname: string): AppRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin/conversations") return "conversations";
  if (path === "/admin/knowledge") return "knowledge";
  if (path === "/admin/users") return "users";
  if (path === "/admin/sessions") return "sessions";
  if (path === "/admin/billing") return "billing";
  return "dashboard";
}
