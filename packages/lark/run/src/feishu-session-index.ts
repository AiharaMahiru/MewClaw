import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { fallbackSessionTitle, normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import type { ProjectionSnapshot } from "@deepseek-ai/dsh-session-projection";

const FEISHU_SESSION_ID = /^session-[0-9a-f]{64}(?::[0-9]+)?$/;
// Keep these values aligned with the official dsh-base session-title config.
const FEISHU_FALLBACK_MAX_WORDS = 5;
const FEISHU_FALLBACK_MAX_BYTES = 40;
const FEISHU_MAX_TITLE_BYTES = 80;
const FEISHU_DEFAULT_TITLE = "飞书会话";

export interface WorkspaceRegistration {
  readonly title?: string;
  setTitle?(title: string): Promise<void>;
  attachSession(sessionId: SessionId): Promise<void>;
}

export interface WorkspaceRegistryPort {
  create(path: string, title?: string): Promise<WorkspaceRegistration>;
}

export interface ProjectionCachePort {
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot;
  write(session: Session): Promise<void>;
}

export interface SessionHeaderSource {
  list(): Promise<readonly SessionHeader[]>;
  inspect?(sessionId: SessionId): Promise<SessionInspection>;
}

export interface FeishuSessionIndexInput {
  persistence: SessionHeaderSource;
  registry: WorkspaceRegistryPort;
  projectionCache?: ProjectionCachePort;
  workspaceRoot: string;
  onCacheError?: (sessionId: SessionId, error: unknown) => void;
}

export interface FeishuSessionIndexResult {
  candidates: number;
  indexed: number;
  prewarmed: number;
  cacheFailures: number;
}

export function isFeishuSessionId(sessionId: string): boolean {
  return FEISHU_SESSION_ID.test(sessionId);
}

export function shortFeishuSessionKey(sessionId: string): string {
  const key = sessionId.slice("session-".length).split(":", 1)[0] ?? sessionId;
  return key.slice(0, 8);
}

/** Derive the same immediate, deterministic title used by dsh-session-title. */
export function feishuPromptTitle(prompt: string): string {
  const title = fallbackSessionTitle(prompt, FEISHU_FALLBACK_MAX_WORDS, FEISHU_FALLBACK_MAX_BYTES);
  return title || FEISHU_DEFAULT_TITLE;
}

export function feishuWorkspaceTitle(sessionId: string, title?: string): string {
  const normalized = title === undefined ? "" : normalizeSessionTitle(title, FEISHU_MAX_TITLE_BYTES);
  return `飞书 · ${normalized || shortFeishuSessionKey(sessionId)}`;
}

function isNestedPath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

async function canonicalNestedPath(root: string, candidate: string): Promise<string | undefined> {
  if (!isAbsolute(candidate)) return undefined;
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    return isNestedPath(canonicalRoot, canonicalCandidate) ? canonicalCandidate : undefined;
  } catch {
    return undefined;
  }
}

export async function attachFeishuSession(input: {
  registry: WorkspaceRegistryPort;
  workspacePath: string;
  sessionId: SessionId;
  title?: string;
}): Promise<WorkspaceRegistration | undefined> {
  if (!isFeishuSessionId(String(input.sessionId))) return undefined;
  const readableTitle = input.title === undefined
    ? undefined
    : normalizeSessionTitle(input.title, FEISHU_MAX_TITLE_BYTES) || FEISHU_DEFAULT_TITLE;
  const legacyTitles = generatedWorkspaceTitles(String(input.sessionId), readableTitle);
  const workspace = await input.registry.create(
    input.workspacePath,
    feishuWorkspaceTitle(String(input.sessionId), readableTitle),
  );
  if (readableTitle && legacyTitles.has(workspace.title ?? "")) {
    await workspace.setTitle?.(feishuWorkspaceTitle(String(input.sessionId), readableTitle));
  }
  await workspace.attachSession(input.sessionId);
  return workspace;
}

/** Update only our generated title; a user's explicit workspace rename wins. */
export async function updateFeishuWorkspaceTitle(input: {
  workspace: WorkspaceRegistration;
  sessionId: SessionId;
  provisionalTitle: string;
  title: string;
}): Promise<void> {
  if (!input.workspace.setTitle) return;
  const current = input.workspace.title;
  const generatedTitles = generatedWorkspaceTitles(String(input.sessionId), input.provisionalTitle);
  if (!generatedTitles.has(current ?? "")) return;
  const next = feishuWorkspaceTitle(String(input.sessionId), input.title);
  if (current === next) return;
  await input.workspace.setTitle(next);
}

/** 兼容早期 registry 直接使用 hash/session id 作为标题的工作区。 */
function generatedWorkspaceTitles(sessionId: string, provisionalTitle?: string): Set<string> {
  const hash = sessionId.startsWith("session-")
    ? (sessionId.slice("session-".length).split(":", 1)[0] ?? sessionId)
    : sessionId;
  const shortKey = shortFeishuSessionKey(sessionId);
  return new Set([
    feishuWorkspaceTitle(sessionId),
    ...(provisionalTitle ? [feishuWorkspaceTitle(sessionId, provisionalTitle)] : []),
    sessionId,
    hash,
    shortKey,
    `飞书 ${shortKey}`,
  ]);
}

function projectionTitle(values: ProjectionSnapshot["values"]): string | undefined {
  if (typeof values.title !== "string") return undefined;
  const title = normalizeSessionTitle(values.title, FEISHU_MAX_TITLE_BYTES);
  return title || undefined;
}

function persistedPromptTitleFromEvents(events: readonly SessionEvent[]): string | undefined {
  const event = events.find((candidate) => {
    if (candidate.type !== "user/message" || candidate.data.source.kind !== "user") return false;
    const text = candidate.data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length > 0;
  });
  if (!event || event.type !== "user/message") return undefined;
  const text = event.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return feishuPromptTitle(text);
}

async function persistedPromptTitle(
  source: SessionHeaderSource,
  sessionId: SessionId,
): Promise<string | undefined> {
  if (!source.inspect) return undefined;
  const inspection = await source.inspect(sessionId);
  return persistedPromptTitleFromEvents(inspection.events);
}

export async function indexFeishuSessions(
  input: FeishuSessionIndexInput,
): Promise<FeishuSessionIndexResult> {
  const result: FeishuSessionIndexResult = {
    candidates: 0,
    indexed: 0,
    prewarmed: 0,
    cacheFailures: 0,
  };
  const headers = await input.persistence.list();
  for (const header of headers) {
    const sessionId = String(header.id);
    if (!isFeishuSessionId(sessionId) || !header.cwd) continue;
    const workspacePath = await canonicalNestedPath(input.workspaceRoot, header.cwd);
    if (!workspacePath) continue;
    result.candidates += 1;
    let title: string | undefined;
    let inspection: SessionInspection | undefined;
    if (input.projectionCache) {
      try {
        if (input.persistence.inspect) {
          inspection = await input.persistence.inspect(header.id as SessionId);
          const snapshot = input.projectionCache.coldSnapshot(
            inspection.meta,
            inspection.inheritedEventCount,
            inspection.events,
          );
          result.prewarmed += 1;
          title = projectionTitle(snapshot.values);
          if (!title) title = persistedPromptTitleFromEvents(inspection.events);
        } else {
          // 兼容旧宿主的单参数 coldSnapshot；正式 Alpha 宿主总是提供 inspect。
          const legacyColdSnapshot = input.projectionCache.coldSnapshot as unknown as (sessionId: SessionId) => ProjectionSnapshot | Promise<ProjectionSnapshot>;
          const snapshot = await legacyColdSnapshot(header.id as SessionId);
          result.prewarmed += 1;
          title = projectionTitle(snapshot.values);
        }
      } catch (error) {
        result.cacheFailures += 1;
        input.onCacheError?.(header.id as SessionId, error);
        title = inspection
          ? persistedPromptTitleFromEvents(inspection.events)
          : await safePersistedPromptTitle(input.persistence, header.id as SessionId);
      }
    } else {
      title = await safePersistedPromptTitle(input.persistence, header.id as SessionId);
    }
    await attachFeishuSession({
      registry: input.registry,
      workspacePath,
      sessionId: header.id as SessionId,
      ...(title ? { title } : {}),
    });
    result.indexed += 1;
  }
  return result;
}

async function safePersistedPromptTitle(
  source: SessionHeaderSource,
  sessionId: SessionId,
): Promise<string | undefined> {
  try {
    return await persistedPromptTitle(source, sessionId);
  } catch {
    return undefined;
  }
}
