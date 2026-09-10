/** 自有扩展离线迁移：官方格式链不改动，扩展按唯一原始锚点回插。 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { createSessionFormatChain, type SessionFormatArtifact, type SessionFormatEvent, type SessionFormatJsonValue } from "@deepseek-ai/dsh-session-format";
import { releasedV0SessionFormatCodec, sessionFormatV0ToV1 } from "@deepseek-ai/dsh-session-format-v0-to-v1";
import { sessionFormatV1ToV2 } from "@deepseek-ai/dsh-session-format-v1-to-v2";
import { sessionFormatV2ToV3, assertReleasedV3Header, restoreReleasedV3Artifact } from "@deepseek-ai/dsh-session-format-v2-to-v3";
import { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { parseScope, parseMessageId } from "dsh-lark-contracts";
import { record, remapReferences } from "./references.js";

const extensions = new Set(["lark/message/in", "lark/run/preset", "lark/memory/recalled"]);

function canonical(value: SessionFormatJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}
function fingerprint(event: SessionFormatEvent): string {
  return createHash("sha256").update(canonical([event.type, event.time, event.data])).digest("hex");
}
function exactKeys(value: object, keys: readonly string[]): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error("unsupported extension fields");
}
function validateExtension(event: SessionFormatEvent): void {
  const allowed = ["type", "seq", "time", "data", ...(event.ignorable === undefined ? [] : ["ignorable"])];
  exactKeys(event, allowed);
  const data = record(event.data);
  if (!parseScope(data.scope).ok) throw new Error("invalid extension Scope");
  switch (event.type) {
    case "lark/message/in":
      exactKeys(data, ["scope", "messageId", "text"]);
      if (!parseMessageId(data.messageId).ok || typeof data.text !== "string") throw new Error("invalid incoming message fields");
      break;
    case "lark/run/preset":
      exactKeys(data, ["scope", "preset", "revision", "version", "skills"]);
      if (![data.preset, data.revision, data.version].every((value) => typeof value === "string") || !Array.isArray(data.skills) || !data.skills.every((value) => typeof value === "string")) throw new Error("invalid preset fields");
      break;
    case "lark/memory/recalled":
      exactKeys(data, ["scope", "count"]);
      if (typeof data.count !== "number" || !Number.isSafeInteger(data.count) || data.count < 0) throw new Error("invalid memory count");
      break;
    default: throw new Error("unsupported extension type");
  }
}
function descriptor(event: SessionFormatEvent): SessionFormatEvent {
  if (event.type !== "subagent/descriptor") return event;
  const data = record(event.data);
  if (data.version !== 2) throw new Error("unsupported historical descriptor version");
  // 本次只接受已核对的 continuable/spawn 结构，不猜测其它历史版本的默认值。
  exactKeys(data, ["version", "mode", "provider", "label", "agentProvider", "agentModel"]);
  if (data.mode !== "continuable" || data.provider !== "spawn" || typeof data.label !== "string" || typeof data.agentProvider !== "string" || typeof data.agentModel !== "string") throw new Error("unsupported descriptor fields");
  const current = snapshotSubagentDescriptor({ mode: data.mode, provider: data.provider, label: data.label, agentProvider: data.agentProvider, agentModel: data.agentModel });
  if (!isDeepStrictEqual(current, { ...data, version: 3 })) throw new Error("descriptor conversion is lossy");
  const converted = { ...event, data: current } as unknown as SessionFormatEvent;
  // snapshot 校验无损 JSON，fold 才检查完整持久化 schema，两者都必须通过。
  if (!foldSubagentDescriptor([converted as unknown as SessionEvent])) throw new Error("descriptor schema rejected");
  return converted;
}

/**
 * 将完整、无继承前缀的 v0 物理行迁移到 v3；不访问文件或生产服务。
 * @param rows 原始物理行。
 * @param maxEvents 解包及输出事件数量上限。
 * @returns 完整验证的 artifact 和不含正文的计数报告。
 */
export function migrateRows(rows: unknown[], maxEvents = 200000): { artifact: SessionFormatArtifact; report: { inputEvents: number; outputEvents: number; extensions: number; descriptors: number } } {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error("invalid event limit");
  const decoder = releasedV0SessionFormatCodec.createDecoder(rows[0], "strict");
  const source: SessionFormatEvent[] = [];
  const collect = (target: SessionFormatEvent[]) => ({
    emitEvent(event: SessionFormatEvent) {
      if (target.length >= maxEvents) throw new Error("event limit exceeded");
      target.push(event);
    },
    emitRun(run: { expand(): Iterable<SessionFormatEvent> }) { for (const event of run.expand()) this.emitEvent(event); },
  });
  const sink = collect(source);
  for (const row of rows.slice(1)) decoder.decodeRow(row, sink);
  if (decoder.finish(sink) !== 0) throw new Error("inherited history is not supported");
  const groups = new Map<string, SessionFormatEvent[]>();
  let pending: SessionFormatEvent[] = [];
  const compact: SessionFormatEvent[] = [];
  const mapping = new Map<number, number>();
  let descriptors = 0;
  for (const event of source) {
    if (extensions.has(event.type)) { validateExtension(event); pending.push(event); continue; }
    if (pending.length) {
      const key = fingerprint(event);
      if (event.type !== "agent/inbox/spliced" || groups.has(key) || source.filter((item) => item.type === event.type && fingerprint(item) === key).length !== 1) throw new Error("extension anchor missing or ambiguous");
      groups.set(key, pending);
      pending = [];
    }
    const converted = descriptor(event);
    if (converted !== event) descriptors++;
    compact.push(remapReferences(converted, compact.length, mapping));
    mapping.set(event.seq, compact.length - 1);
  }
  if (pending.length) throw new Error("extension anchor missing at EOF");
  const chain = createSessionFormatChain({ currentVersion: 3, migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3], restoreCurrentHeader(header) { assertReleasedV3Header(header); return header; } });
  const official: SessionFormatEvent[] = [];
  const stream = chain.createStream(decoder.header, 0, collect(official));
  for (const event of compact) stream.emitEvent(event);
  const cut = stream.finish();
  if (cut !== 0) throw new Error("unexpected inherited output");
  const result: SessionFormatEvent[] = [];
  const forward = new Map<number, number>();
  const reverse = new Map<number, number>();
  const inserted = new Set<number>();
  for (const event of official) {
    const key = fingerprint(event);
    const group = groups.get(key);
    if (group) {
      if (official.filter((item) => fingerprint(item) === key).length !== 1) throw new Error("converted anchor ambiguous");
      for (const extension of group) { inserted.add(result.length); result.push({ ...extension, seq: result.length }); }
      groups.delete(key);
    }
    const mapped = remapReferences(event, result.length, forward);
    result.push(mapped);
    forward.set(event.seq, mapped.seq);
    reverse.set(mapped.seq, event.seq);
  }
  if (groups.size) throw new Error("converted anchor changed or missing");
  if (result.length > maxEvents) throw new Error("event limit exceeded");
  // 反映射并比较全部官方事件，而不只是正文；覆盖 surface 和事件引用完整性。
  const roundtrip = result.filter((event) => !inserted.has(event.seq)).map((event) => remapReferences(event, reverse.get(event.seq)!, reverse));
  if (!isDeepStrictEqual(roundtrip, official)) throw new Error("official event roundtrip mismatch");
  const artifact = restoreReleasedV3Artifact({ header: stream.header, inheritedEventCount: cut, events: result }, KNOWN_SESSION_EVENT_TYPES);
  Session.fromRestore(SessionId(artifact.header.id), artifact.events as unknown as SessionEvent[], artifact.header as unknown as SessionHeader, SessionLogOffset(cut), "detached");
  return { artifact, report: { inputEvents: source.length, outputEvents: result.length, extensions: inserted.size, descriptors } };
}
