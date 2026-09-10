export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  defaultMode: "full" | "lightweight";
}

function decodeCurrentUser(value: unknown): CurrentUser {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid current user");
  const user = (value as Record<string, unknown>).user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) throw new Error("invalid current user");
  const row = user as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.email !== "string" ||
      typeof row.displayName !== "string" || !["admin", "user"].includes(String(row.role)) ||
      !["full", "lightweight"].includes(String(row.defaultMode))) {
    throw new Error("invalid current user");
  }
  return row as unknown as CurrentUser;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const response = await fetch("/auth/me", { credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 401 ? "UNAUTHORIZED" : "CURRENT_USER_UNAVAILABLE");
  return decodeCurrentUser(await response.json());
}
