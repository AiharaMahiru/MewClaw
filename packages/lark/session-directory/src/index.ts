import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";

import { FileSessionDirectory } from "./store.js";
import type { LarkSessionDirectory } from "./types.js";

export const name = "lark-session-directory";
export const inject = ["sessionPersistence", "commands"];

const DEFAULT_FILE_PATH = "var/session-directory.json";
const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 20;
const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 100;

export interface Config {
  filePath?: string;
  claimTtlMs?: number;
  maxEntries?: number;
}

export const Config: z<Config> = z.object({
  filePath: z.string(),
  claimTtlMs: z.number(),
  maxEntries: z.number(),
});

function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`lark-session-directory: ${name} 非法`);
  }
  return resolved;
}

export function registerLarkShareCommand(ctx: Context, directory: LarkSessionDirectory): () => void {
  const definition: CommandDefinition = {
    name: "lark-share",
    description: "生成一次性分享码，以便飞书接续当前会话",
    recordInput: false,
    handler: async (invocation) => {
      try {
        const claim = await directory.issueClaim(invocation.agent.id as SessionId);
        return {
          kind: "success",
          text: `飞书会话分享码：${claim.code}\n请在飞书中输入 /session claim ${claim.code}\n有效期至 ${claim.expiresAt}`,
        };
      } catch {
        return { kind: "error", text: "当前会话无法分享，请确认会话工作区仍然可用。" };
      }
    },
  };
  return ctx.commands.register(definition);
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  let active = true;
  ctx.effect(() => () => { active = false; });
  const directory = await FileSessionDirectory.open({
    filePath: resolve(config.filePath ?? DEFAULT_FILE_PATH),
    persistence: ctx.sessionPersistence!,
    claimTtlMs: bounded(config.claimTtlMs, DEFAULT_CLAIM_TTL_MS, MAX_CLAIM_TTL_MS, "claimTtlMs"),
    maxEntries: bounded(config.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES, "maxEntries"),
  });
  if (!active) return;
  ctx.provide("larkSessionDirectory", directory);
  ctx.effect(() => registerLarkShareCommand(ctx, directory));
}

export { FileSessionDirectory } from "./store.js";
export { inspectStoredSession } from "./persistence.js";
export type { FileSessionDirectoryOptions } from "./store.js";
export type { LarkSessionDirectory, SessionClaim, SessionResolution } from "./types.js";
