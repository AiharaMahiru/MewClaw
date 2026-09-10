import type { RunRequest, RunStreamDone, RunStreamItem } from "dsh-lark-contracts";

import { RunClientError, type RunClientErrorCode } from "./errors.js";
import { parseLine } from "./validation.js";

export interface StreamOptions {
  heartbeatToleranceMs: number;
  maxEventBytes: number;
  onStreamError?: (code: RunClientErrorCode) => void;
}

/** 按字节累积单条 NDJSON 帧，避免分块到达时反复扫描整个字符串。 */
class FrameBuffer {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer: Uint8Array;
  #size = 0;

  constructor(private readonly maxBytes: number) {
    this.#buffer = new Uint8Array(Math.min(1_024, maxBytes));
  }

  append(value: Uint8Array): void {
    const nextSize = this.#size + value.byteLength;
    if (nextSize > this.maxBytes) throw this.#tooLarge();
    this.#ensureCapacity(nextSize);
    this.#buffer.set(value, this.#size);
    this.#size = nextSize;
  }

  takeLine(value: Uint8Array): string {
    this.append(value);
    try {
      return this.#decoder.decode(this.#buffer.subarray(0, this.#size));
    } catch {
      throw new RunClientError("STREAM_SCHEMA_ERROR", "事件行不是合法 UTF-8");
    } finally {
      this.#size = 0;
    }
  }

  takePending(): string | undefined {
    return this.#size === 0 ? undefined : this.takeLine(new Uint8Array());
  }

  #ensureCapacity(size: number): void {
    if (size <= this.#buffer.byteLength) return;
    const capacity = Math.min(this.maxBytes, Math.max(size, this.#buffer.byteLength * 2));
    const expanded = new Uint8Array(capacity);
    expanded.set(this.#buffer.subarray(0, this.#size));
    this.#buffer = expanded;
  }

  #tooLarge(): RunClientError {
    return new RunClientError("STREAM_SCHEMA_ERROR", `事件行超出 ${this.maxBytes} 字节上限`);
  }
}

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  toleranceMs: number,
): Promise<{ done: true } | { done: false; value: Uint8Array }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunClientError("STREAM_BROKEN", "心跳超时")), toleranceMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof RunClientError) throw error;
    throw new RunClientError("STREAM_BROKEN", error instanceof Error ? error.message : "读取中断");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeStreamError(error: unknown): RunClientError {
  return error instanceof RunClientError
    ? error
    : new RunClientError("STREAM_BROKEN", error instanceof Error ? error.message : "流中断");
}

async function* readLines(
  response: Response,
  toleranceMs: number,
  maxEventBytes: number,
): AsyncGenerator<string> {
  if (!response.body) throw new RunClientError("STREAM_BROKEN", "响应无流式 body");
  const reader = response.body.getReader();
  const buffered = new FrameBuffer(maxEventBytes);
  try {
    for (;;) {
      const frame = await readFrame(reader, toleranceMs);
      if (frame.done) break;
      let start = 0;
      for (let index = 0; index < frame.value.byteLength; index += 1) {
        if (frame.value[index] !== 10) continue;
        yield buffered.takeLine(frame.value.subarray(start, index));
        start = index + 1;
      }
      buffered.append(frame.value.subarray(start));
    }
    const pending = buffered.takePending();
    if (pending !== undefined) yield pending;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function* iterateResponse(
  response: Response,
  request: RunRequest,
  options: StreamOptions,
): AsyncGenerator<RunStreamItem | RunStreamDone> {
  try {
    for await (const line of readLines(response, options.heartbeatToleranceMs, options.maxEventBytes)) {
      if (line.length === 0) continue;
      const item = parseLine(line, request, options.maxEventBytes);
      yield item;
      if ("outcome" in item) return;
    }
    throw new RunClientError("STREAM_BROKEN", "事件流结束但缺少终止行");
  } catch (error) {
    const normalized = normalizeStreamError(error);
    options.onStreamError?.(normalized.code);
    throw normalized;
  }
}

/** 把响应体解析为惰性 NDJSON 事件流。 */
export function streamFromResponse(
  response: Response,
  request: RunRequest,
  options: StreamOptions,
): AsyncIterable<RunStreamItem | RunStreamDone> {
  return { [Symbol.asyncIterator]: () => iterateResponse(response, request, options) };
}
