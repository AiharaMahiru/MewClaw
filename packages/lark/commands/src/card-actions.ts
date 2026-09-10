import { randomUUID } from "node:crypto";

import { makeInteractionId, scopeKey, type InteractionId, type Scope } from "dsh-lark-contracts";

export const DEFAULT_CARD_ACTION_TTL_MS = 10 * 60_000;
export const DEFAULT_CARD_ACTION_MAX_ENTRIES = 1_000;
export const MAX_CARD_ACTION_TTL_MS = 24 * 60 * 60_000;
export const MAX_CARD_ACTION_MAX_ENTRIES = 10_000;

export interface CardActionRegistryOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface StoredCardAction {
  command: string;
  scopeKey: string;
  expiresAt: number;
}

/** 有界、一次性的命令卡动作注册表；重启后自然丢失并 fail closed。 */
export class CardActionRegistry {
  readonly #entries = new Map<InteractionId, StoredCardAction>();

  constructor(private readonly options: CardActionRegistryOptions) {}

  register(scope: Scope, command: string): InteractionId {
    const now = this.#now();
    this.#purge(now);
    const actionId = makeInteractionId(randomUUID());
    this.#entries.set(actionId, {
      command,
      scopeKey: scopeKey(scope),
      expiresAt: now + this.options.ttlMs,
    });
    this.#enforceCapacity();
    return actionId;
  }

  /** 仅 Scope 一致且未过期的 action 可原子消费一次。 */
  consume(scope: Scope, actionId: InteractionId): string | undefined {
    const entry = this.#entries.get(actionId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(actionId);
      return undefined;
    }
    if (entry.scopeKey !== scopeKey(scope)) return undefined;
    this.#entries.delete(actionId);
    return entry.command;
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #purge(now: number): void {
    for (const [actionId, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(actionId);
    }
  }

  #enforceCapacity(): void {
    while (this.#entries.size > this.options.maxEntries) {
      const actionId = this.#entries.keys().next().value;
      if (actionId === undefined) return;
      this.#entries.delete(actionId);
    }
  }
}
