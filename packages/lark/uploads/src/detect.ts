/**
 * 统一内容检测（内容驱动；不依赖文件名、扩展名或上游 MIME）。
 *
 * 用 file-type 的魔数检测恢复真实二进制类型；对普通文本（file-type 返回
 * undefined）归类为 text，由 extractFile 的安全文本解码验证。
 *
 * 注意：file-type 会把 UTF-16LE/BE BOM（FF FE / FE FF）误判为 audio/mpeg，
 * 因此 BOM 检查必须优先于 file-type，否则 UTF-16 文本会走二进制分支。
 */
import { open } from "node:fs/promises";

import { fileTypeFromFile } from "file-type";

export type DetectedKind = "image" | "pdf" | "docx" | "xlsx" | "text" | "binary";

export interface ContentDetection {
  kind: DetectedKind;
  /** file-type 检测到的 MIME；文本为 null（BOM 文本同样为 null）。 */
  mimeType: string | null;
  /** file-type 建议扩展名（无点）；文本为 null。 */
  extension: string | null;
}

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);

/** 只读文件头，判断是否带 UTF-8/UTF-16 BOM（BOM 文本优先于魔数检测）。 */
async function hasTextBom(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(3);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length >= 2
      && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
      return true;
    }
    return head.length >= 3
      && head[0] === UTF8_BOM[0] && head[1] === UTF8_BOM[1] && head[2] === UTF8_BOM[2];
  } finally {
    await handle.close();
  }
}

/**
 * 检测文件真实内容类型。文本（含 BOM 文本、未知扩展名、无扩展名）一律
 * 归为 text；富格式按真实 MIME 分派；已识别但无解析器的二进制归为 binary
 * （由调用方明确报告类型，不得猜测加密/损坏）。
 */
export async function detectContent(filePath: string): Promise<ContentDetection> {
  if (await hasTextBom(filePath)) return { kind: "text", mimeType: null, extension: null };
  const detected = await fileTypeFromFile(filePath);
  if (!detected) return { kind: "text", mimeType: null, extension: null };
  const { ext, mime } = detected;
  if (mime.startsWith("image/")) return { kind: "image", mimeType: mime, extension: ext };
  if (mime === "application/pdf") return { kind: "pdf", mimeType: mime, extension: ext };
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { kind: "docx", mimeType: mime, extension: ext };
  }
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return { kind: "xlsx", mimeType: mime, extension: ext };
  }
  if (mime.startsWith("text/")) return { kind: "text", mimeType: mime, extension: ext };
  return { kind: "binary", mimeType: mime, extension: ext };
}
