import type { AuthService, AuthUser } from "dsh-lark-auth";

interface ClientEvents {
  userId: string;
  events: Map<string, string>;
}

/** 只保存真实已投递事件的关联，不持久化选项内容，也不信任HTTP自报的归属。 */
export class RemoteEventResults {
  readonly #clients = new Map<string, ClientEvents>();

  connection(userId: string) {
    const streams = new Map<string, { clientId?: string; client?: ClientEvents }>();
    let disposed = false;
    const close = (id: string): void => {
      const stream = streams.get(id);
      if (stream?.clientId && this.#clients.get(stream.clientId) === stream.client) this.#clients.delete(stream.clientId);
      streams.delete(id);
    };
    return {
      client: (text: string): void => {
        if (disposed) return;
        const frame = recordJson(text);
        if (!id(frame?.streamId)) return;
        if (frame.type === "cancel") close(frame.streamId);
        if (frame.type === "open" && frame.endpoint === "$events") {
          if (streams.has(frame.streamId) || streams.size >= 1024) throw new Error("Remote event stream limit or duplicate");
          streams.set(frame.streamId, {});
        }
      },
      server: (text: string): void => {
        if (disposed) return;
        const frame = recordJson(text);
        if (!id(frame?.streamId)) return;
        const stream = streams.get(frame.streamId);
        if (!stream) return;
        if (frame.type === "end" || frame.type === "error") { close(frame.streamId); return; }
        if (frame.type !== "item") return;
        const value = record(frame.value);
        if (!value) return;
        if (value.type === "ready" && id(value.clientId)) {
          if (stream.client || this.#clients.has(value.clientId)) throw new Error("Remote event client collision");
          stream.clientId = value.clientId;
          stream.client = { userId, events: new Map() };
          this.#clients.set(value.clientId, stream.client);
          return;
        }
        if (!stream.client || !id(value.eventId)) return;
        if (value.type === "cancel") stream.client.events.delete(value.eventId);
        if (value.type === "waterfall" && id(value.agentId)) {
          if (stream.client.events.size >= 4096) throw new Error("Remote event pending limit");
          stream.client.events.set(value.eventId, value.agentId);
        }
      },
      dispose: (): void => {
        disposed = true;
        for (const streamId of streams.keys()) close(streamId);
      },
    };
  }

  async authorize(body: Record<string, unknown>, user: AuthUser, service: AuthService): Promise<string | undefined> {
    const args = record(record(body.payload)?.args);
    if (body.method !== "$events/result" || !args || !exact(args, ["clientId", "eventId", "outcome"])
      || !id(args.clientId) || !id(args.eventId) || !validOutcome(args.outcome)) return "INVALID_RPC";
    const client = this.#clients.get(args.clientId);
    const agentId = client?.events.get(args.eventId);
    if (!client || client.userId !== user.id || !agentId) return "EVENT_RESULT_NOT_ALLOWED";
    if (user.role !== "admin" && (await service.findResource("session", agentId))?.userId !== user.id) return "RESOURCE_NOT_ALLOWED";
    // 查归属期间可能收到取消、断线或另一份回答；提交前再次检查并同步消费。
    if (this.#clients.get(args.clientId) !== client || client.events.get(args.eventId) !== agentId) return "EVENT_RESULT_NOT_ALLOWED";
    client.events.delete(args.eventId);
    return undefined;
  }
}

function validOutcome(value: unknown): boolean {
  const outcome = record(value);
  if (!outcome) return false;
  if (outcome.kind === "next") return exact(outcome, ["kind"]);
  if (outcome.kind === "result") return exact(outcome, ["kind"]) || exact(outcome, ["kind", "value"]);
  const error = record(outcome.error);
  return outcome.kind === "rejected" && exact(outcome, ["kind", "error"]) && !!error
    && typeof error.name === "string" && error.name.length > 0 && typeof error.message === "string"
    && (error.code === undefined || typeof error.code === "string")
    && Object.keys(error).every(key => ["name", "message", "code", "details"].includes(key));
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function recordJson(text: string): Record<string, unknown> | undefined { try { return record(JSON.parse(text)); } catch { return undefined; } }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
