const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;

/** 视觉上游 JSON 的硬性 wire 上限。 */
export const MAX_VISION_RESPONSE_BYTES = MEBIBYTE;
/** 失败响应只读取有限诊断信息，避免错误页放大 Worker。 */
export const MAX_VISION_ERROR_RESPONSE_BYTES = 64 * KIBIBYTE;
export const MAX_VISION_ERROR_DETAIL_CHARS = 512;
/** 上游 Responses 的 JSON 字段本身也需要独立限额。 */
export const MAX_VISION_OUTPUT_TEXT_BYTES = 256 * KIBIBYTE;
/** 结构化字段与数组限制最终写入模型上下文的规模。 */
export const MAX_VISUAL_ANALYSIS_FIELD_BYTES = 16 * KIBIBYTE;
export const MAX_VISUAL_ANALYSIS_LABEL_BYTES = 512;
export const MAX_VISUAL_ANALYSIS_ITEMS = 128;
export const MAX_VISUAL_ANALYSIS_BYTES = 64 * KIBIBYTE;

function invalidVisionResponse(): Error {
  return new Error("Vision API returned invalid response");
}

function declaredBodySize(response: Response): number {
  const header = response.headers.get("content-length");
  if (header === null) return 0;
  if (!/^\d+$/.test(header)) throw invalidVisionResponse();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw invalidVisionResponse();
  return size;
}

/** 使用 UTF-8 字节而非 UTF-16 字符数计量不可信文本。 */
export function isWithinVisionByteLimit(text: string, maxBytes: number): boolean {
  return new TextEncoder().encode(text).byteLength <= maxBytes;
}

/** 读取受限响应文本；声明长度和实际流字节均必须在调用者预算内。 */
export async function readVisionText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidVisionResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > maxBytes) throw invalidVisionResponse();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalidVisionResponse();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    throw invalidVisionResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 成功响应必须先在有限流中完成 UTF-8 解码，再解析 JSON。 */
export async function readVisionJson(response: Response): Promise<unknown> {
  const text = await readVisionText(response, MAX_VISION_RESPONSE_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidVisionResponse();
  }
}
