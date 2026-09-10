import type { AdminSessionSummary, AdminUserSummary, BillingAggregate } from "./api.js";

export type UserFilter = "all" | AdminUserSummary["status"];
export type SessionFilter = "all" | "active" | "inactive";

export interface ActivityPoint {
  key: string;
  label: string;
  value: number;
}

export interface BillingTotals {
  calls: number;
  tokens: number;
  totalUsd: number;
  models: number;
}

function searchable(...values: string[]): string {
  return values.join(" ").toLocaleLowerCase("zh-CN");
}

function localDayKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

export function isActiveSession(session: AdminSessionSummary, now = Date.now()): boolean {
  return !session.revokedAt && Date.parse(session.expiresAt) > now;
}

export function filterUsers(
  users: AdminUserSummary[],
  query: string,
  filter: UserFilter,
): AdminUserSummary[] {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  return users.filter((user) => {
    if (filter !== "all" && user.status !== filter) return false;
    return !term || searchable(user.displayName, user.email).includes(term);
  });
}

export function filterSessions(
  sessions: AdminSessionSummary[],
  query: string,
  filter: SessionFilter,
  now = Date.now(),
): AdminSessionSummary[] {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  return sessions.filter((session) => {
    const active = isActiveSession(session, now);
    if (filter === "active" && !active) return false;
    if (filter === "inactive" && active) return false;
    return !term || searchable(session.displayName, session.email).includes(term);
  });
}

export function sessionActivityPoints(
  sessions: AdminSessionSummary[],
  now = new Date(),
): ActivityPoint[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const points = Array.from({ length: 7 }, (_, index) => {
    const value = new Date(today);
    value.setDate(today.getDate() - (6 - index));
    return { key: localDayKey(value), label: `${value.getMonth() + 1}/${value.getDate()}`, value: 0 };
  });
  const totals = new Map(points.map((point) => [point.key, 0]));
  for (const session of sessions) {
    const created = new Date(session.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    const key = localDayKey(created);
    if (totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return points.map((point) => ({ ...point, value: totals.get(point.key) ?? 0 }));
}

export function billingTotals(rows: BillingAggregate[]): BillingTotals {
  const models = new Set<string>();
  return rows.reduce<BillingTotals>((total, row) => {
    models.add(`${row.provider}/${row.model}`);
    total.calls += row.calls;
    total.tokens += row.inputTokens + row.outputTokens + row.reasoningTokens;
    total.totalUsd += row.totalUsd;
    total.models = models.size;
    return total;
  }, { calls: 0, tokens: 0, totalUsd: 0, models: 0 });
}
