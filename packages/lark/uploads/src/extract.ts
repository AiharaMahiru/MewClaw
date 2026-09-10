/**
 * 文本提取（内容驱动；不依赖扩展名白名单）。
 *
 * 统一内容检测（detect.ts）决定分派：PDF/DOCX/XLSX 按真实 MIME 进入富
 * 格式解析器，普通文本走安全多编码解码（UTF-8 → UTF-16 BOM → GB18030
 * 回退，NUL/控制字符比例/大小上限拒绝），已识别二进制抛
 * UnsupportedBinaryError（调用方明确报告类型，不得猜测加密/损坏）。
 * 扩展名只用于文本 MIME 细化（展示/摄入元数据），不决定能否读取。
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { detectContent, type ContentDetection } from "./detect.js";

export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
/** 富格式解压/解析后的独立文本预算，防止压缩输入放大模型摄入和知识写入。 */
export const MAX_RICH_EXTRACTED_TEXT_CHARS = 2_000_000;
const MAX_CONTROL_CHARACTER_RATIO = 0.01;

/** 文本提取结果（mimeType 是提取器判定的规范文本 MIME；富格式产物统一 text/plain）。 */
export interface ExtractedText {
  text: string;
  mimeType: string;
}

/** 已识别但无文本解析器的二进制附件（含图片——图片走视觉分析，不走文本提取）。 */
export class UnsupportedBinaryError extends Error {
  readonly detection: ContentDetection;

  constructor(detection: ContentDetection, detail?: string) {
    const label = detection.mimeType
      ? `${detection.mimeType}${detection.extension ? `（.${detection.extension}）` : ""}`
      : "未知二进制";
    super(detail ? `${label}：${detail}` : `已识别二进制格式 ${label}，当前暂无文本解析器`);
    this.name = "UnsupportedBinaryError";
    this.detection = detection;
  }
}

/** 扩展名 → 规范文本 MIME（仅文本 MIME 细化；可读性由内容检测决定）。 */
function textMimeType(extension: string): string {
  if (extension === ".md" || extension === ".mdx") return "text/markdown";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".css") return "text/css";
  if (extension === ".csv") return "text/csv";
  if (extension === ".tsv") return "text/tab-separated-values";
  if (extension === ".json" || extension === ".jsonl") return "application/json";
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) return "text/javascript";
  if (extension === ".xml") return "application/xml";
  return "text/plain";
}

/** 二进制检测 + 多编码解码（UTF-8 失败回退 GB18030）。 */
function decodeText(data: Uint8Array): string {
  let text: string;
  if (data[0] === 0xff && data[1] === 0xfe) {
    text = new TextDecoder("utf-16le", { fatal: true }).decode(data.subarray(2));
  } else if (data[0] === 0xfe && data[1] === 0xff) {
    text = new TextDecoder("utf-16be", { fatal: true }).decode(data.subarray(2));
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      text = new TextDecoder("gb18030", { fatal: true }).decode(data);
    }
  }
  const controls = [...text].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
  }).length;
  if (text.includes("\u0000") || controls / Math.max(text.length, 1) > MAX_CONTROL_CHARACTER_RATIO) {
    throw new Error("文本文件疑似二进制内容");
  }
  return text;
}

/** 归一化：去 NUL、换行统一、压缩空行。 */
function normalizeText(text: string, maxChars?: number): string {
  const normalized = text
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (maxChars !== undefined && normalized.length > maxChars) {
    throw new Error(`富格式提取文本超过 ${maxChars} 字符上限`);
  }
  return normalized;
}

/** 富格式提取（按检测结果分派；动态导入避免冷启动成本）。 */
async function extractRich(filePath: string, kind: "pdf" | "docx" | "xlsx"): Promise<string> {
  if (kind === "pdf") {
    const { extractText } = await import("unpdf");
    const data = new Uint8Array(await readFile(filePath));
    const result = await extractText(data, { mergePages: true });
    // unpdf 按页返回文本数组；合并为单个文本。
    return Array.isArray(result.text) ? result.text.join("\n") : result.text;
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: await readFile(filePath) });
    return result.value;
  }
  // Node 版导出（根导出是 browser 实现，不接受路径参数）。
  const readXlsxFile = (await import("read-excel-file/node")).default as unknown as (
    input: string,
  ) => Promise<Array<Array<string | number | boolean | Date | null>>>;
  const rows = await readXlsxFile(filePath);
  return rows
    .map((row) => row.map((cell) => (cell === null ? "" : String(cell).trim())).join("\t"))
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * 提取文本；按真实内容分派（detection 可复用调用方已检测的结果，避免
 * 二次 IO）。图片/未支持二进制/超限/空文本/疑似二进制一律抛错（fail
 * loud）。
 */
export async function extractFile(
  filePath: string,
  maxBytes = MAX_TEXT_FILE_BYTES,
  detection?: ContentDetection,
): Promise<ExtractedText> {
  const det = detection ?? await detectContent(filePath);
  if (det.kind === "image") {
    throw new UnsupportedBinaryError(det, "图片内容请通过视觉分析处理");
  }
  if (det.kind === "binary") {
    throw new UnsupportedBinaryError(det);
  }
  const isRich = det.kind === "pdf" || det.kind === "docx" || det.kind === "xlsx";
  const data = await readFile(filePath);
  if (data.byteLength > maxBytes) {
    throw new Error(`文件超过 ${maxBytes} 字节上限`);
  }
  const text = normalizeText(
    det.kind === "pdf" || det.kind === "docx" || det.kind === "xlsx"
      ? await extractRich(filePath, det.kind)
      : decodeText(data),
    isRich ? MAX_RICH_EXTRACTED_TEXT_CHARS : undefined,
  );
  if (!text) throw new Error(`未从 ${basename(filePath)} 提取到文本内容`);
  return { text, mimeType: isRich ? "text/plain" : textMimeType(extname(filePath).toLowerCase()) };
}
