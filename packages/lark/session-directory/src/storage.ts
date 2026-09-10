import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  LarkError,
  MAX_SESSION_GENERATION,
  parseScope,
  parseSessionId,
  scopeKey,
  type Scope,
} from "dsh-lark-contracts";

const DIRECTORY_VERSION = 1;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
export const MAX_STORED_BINDINGS = 10_000;
const ROOT_FIELDS = new Set(["version", "bindings", "selections"]);
const BINDING_FIELDS = new Set(["scope", "generation", "sessionId", "claimedAt", "lastUsedAt"]);
const SELECTION_FIELDS = new Set(["scope", "generation", "sessionId"]);

export interface StoredBinding {
  scope: Scope;
  generation: number;
  sessionId: SessionId;
  claimedAt: string;
  lastUsedAt: string;
}

export interface StoredSelection {
  scope: Scope;
  generation: number;
  sessionId: SessionId;
}

export interface DirectoryState {
  version: 1;
  bindings: StoredBinding[];
  selections: StoredSelection[];
}

export function emptyState(): DirectoryState {
  return { version: DIRECTORY_VERSION, bindings: [], selections: [] };
}

function fail(): never {
  throw new LarkError("SESSION_DIRECTORY_FAILED", "environment", "会话授权目录损坏");
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}

function exactFields(input: Record<string, unknown>, fields: ReadonlySet<string>): void {
  if (Object.keys(input).length !== fields.size || Object.keys(input).some((key) => !fields.has(key))) fail();
}

function generation(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input)
    || input < 0 || input > MAX_SESSION_GENERATION) fail();
  return input;
}

function timestamp(input: unknown): string {
  if (typeof input !== "string" || input.length > 64 || !Number.isFinite(Date.parse(input))) fail();
  return input;
}

function parseBinding(input: unknown): StoredBinding {
  const value = record(input);
  exactFields(value, BINDING_FIELDS);
  const parsedScope = parseScope(value.scope);
  const sessionId = parseSessionId(value.sessionId);
  if (!parsedScope.ok || !sessionId.ok) fail();
  return {
    scope: parsedScope.value,
    generation: generation(value.generation),
    sessionId: sessionId.value,
    claimedAt: timestamp(value.claimedAt),
    lastUsedAt: timestamp(value.lastUsedAt),
  };
}

function parseSelection(input: unknown): StoredSelection {
  const value = record(input);
  exactFields(value, SELECTION_FIELDS);
  const parsedScope = parseScope(value.scope);
  const sessionId = parseSessionId(value.sessionId);
  if (!parsedScope.ok || !sessionId.ok) fail();
  return { scope: parsedScope.value, generation: generation(value.generation), sessionId: sessionId.value };
}

export function scopeGenerationKey(scope: Scope, value: number): string {
  return `${scopeKey(scope)}:${value}`;
}

export function bindingKey(binding: Pick<StoredBinding, "scope" | "generation" | "sessionId">): string {
  return `${scopeGenerationKey(binding.scope, binding.generation)}\0${binding.sessionId}`;
}

function validateRelations(state: DirectoryState): void {
  const bindingKeys = new Set(state.bindings.map(bindingKey));
  if (bindingKeys.size !== state.bindings.length) fail();
  const selectionKeys = state.selections.map((item) => scopeGenerationKey(item.scope, item.generation));
  if (new Set(selectionKeys).size !== selectionKeys.length) fail();
  if (state.selections.some((item) => !bindingKeys.has(bindingKey(item)))) fail();
}

export function parseState(input: unknown): DirectoryState {
  const value = record(input);
  exactFields(value, ROOT_FIELDS);
  if (value.version !== DIRECTORY_VERSION || !Array.isArray(value.bindings) || !Array.isArray(value.selections)
    || value.bindings.length > MAX_STORED_BINDINGS || value.selections.length > MAX_STORED_BINDINGS) fail();
  const state: DirectoryState = {
    version: DIRECTORY_VERSION,
    bindings: value.bindings.map(parseBinding),
    selections: value.selections.map(parseSelection),
  };
  validateRelations(state);
  return state;
}

export async function loadState(filePath: string): Promise<DirectoryState> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new LarkError("SESSION_DIRECTORY_FAILED", "environment", "会话授权目录读取失败");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_DIRECTORY_BYTES) fail();
  try {
    return parseState(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof LarkError) throw error;
    fail();
  }
}

export async function saveState(filePath: string, state: DirectoryState): Promise<void> {
  try {
    await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  } catch {
    throw new LarkError("SESSION_DIRECTORY_FAILED", "environment", "会话授权目录写入失败");
  }
}
