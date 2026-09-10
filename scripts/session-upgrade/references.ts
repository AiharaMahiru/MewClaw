/** 仅重映射官方迁移链明确拥有的序号字段，不递归改写业务 payload。 */
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from "@deepseek-ai/dsh-session-format";

/** 持久化 JSON 对象解析；错误不携带聊天内容。 */
export function record(value: SessionFormatJsonValue): SessionFormatJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value as SessionFormatJsonObject;
}

/**
 * 将事件和已知引用转换为新坐标；映射必须指向存在的更早事件。
 * @param event 已结构解码的逻辑事件。
 * @param seq 输出序号。
 * @param mapping 源序号到目标序号；被暂存扩展不应包含在映射内。
 * @returns 不修改输入的转换结果。
 */
export function remapReferences(event: SessionFormatEvent, seq: number, mapping: ReadonlyMap<number, number>): SessionFormatEvent {
  const one = (value: SessionFormatJsonValue | undefined): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= event.seq) {
      throw new Error("reference must name an earlier source event");
    }
    const target = mapping.get(value);
    if (target === undefined || target >= seq || target < 0 || !Number.isSafeInteger(target)) {
      throw new Error("reference target missing or not earlier");
    }
    return target;
  };
  const list = (value: SessionFormatJsonValue | undefined): number[] => {
    if (!Array.isArray(value)) throw new Error("sequence references must be an array");
    return value.map(one);
  };
  const range = (value: SessionFormatJsonValue | undefined, start: string, end: string): SessionFormatJsonObject => {
    if (value === undefined) throw new Error("missing sequence range");
    const source = record(value);
    const left = one(source[start]);
    const right = one(source[end]);
    if (left > right) throw new Error("reversed sequence range");
    return { ...source, [start]: left, [end]: right };
  };
  let data = record(event.data);
  switch (event.type) {
    case "command/done":
      if (data.sourceEventSeq !== undefined) data = { ...data, sourceEventSeq: one(data.sourceEventSeq) };
      break;
    case "compaction/prune":
    case "compaction/summary":
      data = { ...data, shadowedRange: range(data.shadowedRange, "start", "end"), shadowedSeqs: list(data.shadowedSeqs) };
      break;
    case "session/title":
    case "session/title-llm-request":
      data = { ...data, messageSeqs: list(data.messageSeqs) };
      break;
  }
  let surfaceOp = event.surfaceOp;
  if (surfaceOp !== undefined && surfaceOp !== "append") {
    const operation = record(surfaceOp);
    if (operation.op !== "replace") throw new Error("unsupported surface operation");
    const current = Object.hasOwn(operation, "startSeq") || Object.hasOwn(operation, "endSeq");
    if (current && (Object.hasOwn(operation, "start") || Object.hasOwn(operation, "end"))) throw new Error("mixed surface coordinates");
    surfaceOp = range(operation, current ? "startSeq" : "start", current ? "endSeq" : "end");
  }
  return {
    ...event, seq, data,
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: list(event.sourceEventSeqs) }),
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  };
}
