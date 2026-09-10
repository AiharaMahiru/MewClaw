import { RunClientError } from "./errors.js";

function invalidResponse(): RunClientError {
  return new RunClientError("RESPONSE_SCHEMA_ERROR", "worker JSON 响应非法或超出上限");
}

function declaredBodySize(response: Response, required = false): number {
  const header = response.headers.get("content-length");
  if (header === null) {
    if (required) throw invalidResponse();
    return 0;
  }
  if (!/^\d+$/.test(header)) throw invalidResponse();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw invalidResponse();
  return size;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > maxBytes) throw invalidResponse();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalidResponse();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof RunClientError) throw error;
    throw invalidResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 读取 worker 的非流式 JSON 响应；声明值与实际字节都必须受预算约束。 */
export async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readResponseText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

/** 读取受限二进制响应；声明长度、实际长度与读取预算都必须一致。 */
export async function readBinaryResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const declared = declaredBodySize(response, true);
    if (declared > maxBytes) throw invalidResponse();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (total !== declared) throw invalidResponse();
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }
      total += value.byteLength;
      if (total > maxBytes) throw invalidResponse();
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RunClientError) throw error;
    throw invalidResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
