const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const BASE64_INPUT_BYTES = 3;
const BASE64_OUTPUT_CHARS = 4;
const RESPONSE_ENVELOPE_BYTES = KIBIBYTE;

/** 与 R-06 单交付物上限一致，避免生成后才由收集器静默跳过。 */
export const MAX_GENERATED_IMAGE_BYTES = 30 * MEBIBYTE;
export const MAX_GENERATED_IMAGE_BASE64_CHARS = Math.ceil(
  MAX_GENERATED_IMAGE_BYTES / BASE64_INPUT_BYTES,
) * BASE64_OUTPUT_CHARS;
export const MAX_IMAGE_RESPONSE_BYTES = MAX_GENERATED_IMAGE_BASE64_CHARS + RESPONSE_ENVELOPE_BYTES;
export const MAX_IMAGE_ERROR_RESPONSE_BYTES = 64 * KIBIBYTE;
export const MAX_IMAGE_ERROR_DETAIL_CHARS = 512;

function invalidImageResponse(): Error {
  return new Error("Image API returned invalid response");
}

function declaredBodySize(response: Response): number {
  const header = response.headers.get("content-length");
  if (header === null) return 0;
  if (!/^\d+$/.test(header)) throw invalidImageResponse();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw invalidImageResponse();
  return size;
}

/** 读取受限响应文本；声明和实际流字节均不得超过调用者预算。 */
export async function readImageText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidImageResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > maxBytes) throw invalidImageResponse();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalidImageResponse();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    throw invalidImageResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 成功响应使用与输出图片一致的预算，先读受限文本再解析 JSON。 */
export async function readImageJson(response: Response, maxBytes = MAX_IMAGE_RESPONSE_BYTES): Promise<unknown> {
  const text = await readImageText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidImageResponse();
  }
}
