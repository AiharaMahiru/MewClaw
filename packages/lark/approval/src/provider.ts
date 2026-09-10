import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import {
  UserQuestionError,
} from "@deepseek-ai/dsh-user-questions";
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from "@deepseek-ai/dsh-user-questions/types";
import "dsh-lark-contracts/context";
import "dsh-lark-contracts/events";
import { makeInteractionId, scopeEquals, type ApprovalOutcome, type Scope } from "dsh-lark-contracts";

import { StoreFullError, type InteractionAnswer, type MemoryPendingStore, type PendingRecord } from "./store.js";

interface WaiterOptions {
  ctx: Context;
  store: MemoryPendingStore;
  session: Session;
  scope: Scope;
  record: PendingRecord;
  signal?: AbortSignal;
}

interface InteractionPayload {
  scope: Scope;
  interactionId: string;
  answer: InteractionAnswer;
}

class PendingAnswerWaiter {
  #settled = false;
  #offAnswer: () => void = () => undefined;
  #offAbort: () => void = () => undefined;
  #resolve: (answer: InteractionAnswer) => void = () => undefined;
  #reject: (error: UserQuestionError) => void = () => undefined;

  constructor(private readonly options: WaiterOptions) {}

  wait(): Promise<InteractionAnswer> {
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.#offAnswer = this.options.ctx.on("lark/interaction/resolved", (payload: InteractionPayload) => {
        this.#answer(payload);
      });
      this.options.store.onExpire(this.options.record.id, () => this.#storeExpired());
      this.#bindAbort();
    });
  }

  #answer(payload: InteractionPayload): void {
    const { record, store } = this.options;
    if (payload.interactionId !== record.id || !scopeEquals(payload.scope, record.scope)) return;
    if (!store.resolve(record.id)) return;
    this.#write("answered");
    this.#settle(() => this.#resolve(payload.answer));
  }

  #storeExpired(): void {
    this.#write("expired");
    this.#settle(() => this.#reject(new UserQuestionError("等待回答超时", "EXPIRED")));
  }

  #abort = (): void => {
    const { record, store } = this.options;
    if (!store.expire(record.id, "aborted")) return;
    this.#write("aborted");
    this.#settle(() => this.#reject(new UserQuestionError("交互已中止", "ABORTED")));
  };

  #bindAbort(): void {
    const { signal } = this.options;
    if (signal?.aborted) return this.#abort();
    if (!signal) return;
    signal.addEventListener("abort", this.#abort, { once: true });
    this.#offAbort = () => signal.removeEventListener("abort", this.#abort);
  }

  #write(outcome: ApprovalOutcome): void {
    const { session, scope, record } = this.options;
    session.append("lark/approval/resolved", { scope, interactionId: record.id, outcome });
  }

  #settle(action: () => void): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#offAnswer();
    this.#offAbort();
    action();
  }
}

interface ProviderOptions {
  ctx: Context;
  store: MemoryPendingStore;
  maxOptions: number;
}

type Question = AskUserQuestionRequestEvent["questions"][number];

interface AskOneInput {
  options: ProviderOptions;
  request: AskUserQuestionRequestEvent;
  scope: Scope;
  question: Question;
}

async function askOne(input: AskOneInput): Promise<AskUserQuestionAnswer["answers"][number]> {
  const { options, request, scope, question } = input;
  const session = request.agent
    ? options.ctx.sessions?.get(request.agent.id) ?? (request.agent as { session?: Session }).session
    : undefined;
  if (!session) throw new UserQuestionError("交互请求缺少运行 Session", "NO_SCOPE");
  try {
    const record = options.store.create(scope, question.id);
    const labels = question.options?.slice(0, options.maxOptions).map((option) => option.label) ?? [];
    session.append("lark/approval/requested", {
      scope,
      interactionId: makeInteractionId(record.id),
      kind: "questionnaire",
      question: { id: question.id, question: question.question, options: labels },
    });
    const answer = await new PendingAnswerWaiter({
      ctx: options.ctx,
      store: options.store,
      session,
      scope,
      record,
      ...(request.signal ? { signal: request.signal } : {}),
    }).wait();
    return {
      id: question.id,
      selected: answer.selected,
      ...(answer.custom ? { custom: answer.custom } : {}),
    };
  } catch (error) {
    if (error instanceof StoreFullError) throw new UserQuestionError(error.message, "TOO_MANY_PENDING");
    throw error;
  }
}

export function createApprovalAnswerer(options: ProviderOptions): (
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer> {
  return async (request, next): Promise<AskUserQuestionAnswer> => {
    if (!request.agent) return next();
    const scope = options.ctx.larkScopeIndex!.get(request.agent.id);
    if (!scope) {
      throw new UserQuestionError("交互请求缺少运行 Scope（larkScopeIndex 未命中）", "NO_SCOPE");
    }
    const answers: AskUserQuestionAnswer["answers"] = [];
    for (const question of request.questions) {
      answers.push(await askOne({ options, request, scope, question }));
    }
    return { answers };
  };
}
