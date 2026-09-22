import { RemoteClientError } from './errors.js';
import type { ModelCatalog, ModelProfile, QuotaSnapshot, RemoteUser, SessionSummary, WorkspaceEntry } from './types.js';

export function parseUser(value: unknown): RemoteUser {
  const record = object(value);
  const user = object(record.user ?? record);
  const id = string(user.id);
  const email = string(user.email);
  const displayName = string(user.displayName);
  if (!id || !email || !displayName || (user.role !== 'admin' && user.role !== 'user')) throw invalidResponse();
  const defaultMode = user.defaultMode === 'lightweight' ? 'lightweight' : 'full';
  return { id, email, displayName, role: user.role, defaultMode };
}

export function parseModels(value: unknown): ModelCatalog {
  const record = object(value);
  const profiles = array(record.profiles).map(parseModelProfile);
  const shared = array(record.sharedModels).filter(isObject).map(item => ({ ...item }));
  const defaultProfileId = typeof record.defaultProfileId === 'string' ? record.defaultProfileId : undefined;
  return { profiles, sharedModels: shared, ...(defaultProfileId ? { defaultProfileId } : {}), raw: value };
}

export function parseQuota(value: unknown): QuotaSnapshot {
  const record = object(value);
  const quota = objectOrUndefined(record.quota);
  const totals = objectOrUndefined(record.totals);
  const monthlyLimitUsd = numberAt(quota, ['monthlyLimitUsd', 'monthly_limit_usd', 'monthlyLimit']);
  const monthlyUsedUsd = numberAt(quota, ['monthlyUsedUsd', 'monthly_used_usd', 'monthlyUsed'])
    ?? numberAt(totals, ['monthlyUsedUsd', 'monthly_used_usd', 'monthlyUsed']);
  const remainingUsd = numberAt(quota, ['remainingUsd', 'remaining_usd', 'remaining']);
  const available = booleanAt(record, ['available', 'isAvailable', 'is_available'])
    ?? (remainingUsd !== undefined ? remainingUsd > 0 : undefined);
  const currency = stringAt(quota, ['currency']) ?? stringAt(record, ['currency']);
  return { raw: value, ...(available === undefined ? {} : { available }), ...(monthlyLimitUsd === undefined ? {} : { monthlyLimitUsd }), ...(monthlyUsedUsd === undefined ? {} : { monthlyUsedUsd }), ...(remainingUsd === undefined ? {} : { remainingUsd }), ...(currency ? { currency } : {}) };
}

export function parseSessions(value: unknown): { items: SessionSummary[]; nextCursor?: string; raw: unknown } {
  const unwrapped = unwrapValue(value);
  const record = objectOrUndefined(unwrapped);
  const source = Array.isArray(unwrapped) ? unwrapped : array(record?.items ?? record?.sessions);
  const items = source.map(parseSession).filter((item): item is SessionSummary => item !== undefined);
  const nextCursor = stringAt(record, ['nextCursor', 'next_cursor', 'cursor']);
  return { items, ...(nextCursor ? { nextCursor } : {}), raw: value };
}

export function parseSession(value: unknown): SessionSummary | undefined {
  if (!isObject(value)) return undefined;
  const id = stringAt(value, ['sessionId', 'id']);
  if (!id) return undefined;
  const title = stringAt(value, ['title', 'name']);
  const cwd = stringAt(value, ['cwd', 'path']);
  const createdAt = scalarAt(value, ['createdAt', 'created_at']);
  const updatedAt = scalarAt(value, ['updatedAt', 'updated_at', 'lastActivityAt']);
  const model = stringAt(value, ['model', 'modelId']);
  const workspaceId = stringAt(value, ['workspaceId', 'workspace_id']);
  const kind = stringAt(value, ['kind', 'type']);
  return { id, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(createdAt !== undefined ? { createdAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), ...(model ? { model } : {}), ...(workspaceId ? { workspaceId } : {}), ...(kind ? { kind } : {}), raw: { ...value } };
}

export function parseWorkspaces(value: unknown): { items: WorkspaceEntry[]; raw: unknown } {
  const unwrapped = unwrapValue(value);
  const record = objectOrUndefined(unwrapped);
  const source = Array.isArray(unwrapped) ? unwrapped : array(record?.items ?? record?.workspaces);
  const items = source.map((item): WorkspaceEntry | undefined => {
    if (!isObject(item)) return undefined;
    const workspaceId = stringAt(item, ['workspaceId', 'id']);
    if (!workspaceId) return undefined;
    const path = stringAt(item, ['path', 'cwd']);
    const title = stringAt(item, ['title', 'name']);
    const sessionIds: readonly string[] | undefined = Array.isArray(item.sessionIds) ? item.sessionIds.filter((id): id is string => typeof id === 'string') : undefined;
    return { workspaceId, ...(path ? { path } : {}), ...(title ? { title } : {}), ...(sessionIds ? { sessionIds } : {}), raw: { ...item } } satisfies WorkspaceEntry;
  }).filter((item): item is WorkspaceEntry => item !== undefined);
  return { items, raw: value };
}

export function unwrapValue(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (value.type === 'server-response' && isObject(value.result)) {
    const result = value.result;
    if (result.ok === false) throw new RemoteClientError('REMOTE_UNAVAILABLE');
    if (result.ok === true && Object.hasOwn(result, 'value')) return result.value;
  }
  if (isObject(value.result) && Object.hasOwn(value.result, 'value')) return value.result.value;
  if (Object.hasOwn(value, 'value') && Object.keys(value).every(key => key === 'value' || key === 'ok')) return value.value;
  return value;
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw invalidResponse();
  return value;
}

function parseModelProfile(value: unknown): ModelProfile {
  const item = object(value);
  const id = string(item.id);
  if (!id) throw invalidResponse();
  const modelIds = array(item.modelIds).filter((model): model is string => typeof model === 'string');
  return {
    ...item,
    id,
    displayName: string(item.displayName) || id,
    baseUrl: string(item.baseUrl),
    modelIds,
    defaultModel: string(item.defaultModel),
    keyConfigured: item.keyConfigured === true,
    revision: typeof item.revision === 'number' && Number.isSafeInteger(item.revision) ? item.revision : 0,
    ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
  };
}

function invalidResponse(): RemoteClientError { return new RemoteClientError('INVALID_RESPONSE'); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function objectOrUndefined(value: unknown): Record<string, unknown> | undefined { return isObject(value) ? value : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringAt(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined { for (const key of keys) if (typeof record?.[key] === 'string' && record[key]) return record[key] as string; return undefined; }
function scalarAt(record: Record<string, unknown>, keys: readonly string[]): string | number | undefined { for (const key of keys) if (typeof record[key] === 'string' || typeof record[key] === 'number') return record[key] as string | number; return undefined; }
function numberAt(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}
function booleanAt(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined { for (const key of keys) if (typeof record[key] === 'boolean') return record[key] as boolean; return undefined; }
