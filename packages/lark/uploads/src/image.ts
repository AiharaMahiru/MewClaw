/**
 * 图片统一解码（视觉路由输入标准化）。
 *
 * 检测 MIME 为 image/* 的文件用 Sharp 解码，统一转码为 PNG 再交给视觉
 * 模型（供应商稳定支持的格式）。三重有界：输入字节、像素数、转码输出
 * 字节；PNG 可能远大于源图（真实 WebP 样本 162KB → PNG 2.9MB），输出
 * 上限不可省略。
 */
import { readFile, stat } from "node:fs/promises";

import sharp from "sharp";

/** 像素上限（对齐 DSH attachment 默认策略 40,000,000）。 */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** 转码输出字节上限（10 MiB；超大 PNG 直接拒绝）。 */
export const MAX_IMAGE_OUTPUT_BYTES = 10 * 1024 * 1024;
/** 视觉输入字节上限（默认 50 MiB）。 */
const DEFAULT_MAX_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;

function resolveMaxInputBytes(value: number | undefined): number {
  const maxInputBytes = value === undefined ? DEFAULT_MAX_IMAGE_INPUT_BYTES : value;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > DEFAULT_MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`图片输入上限必须是 1..${DEFAULT_MAX_IMAGE_INPUT_BYTES} 的安全整数`);
  }
  return maxInputBytes;
}

export interface DecodedImage {
  /** 输出格式 MIME（统一 image/png）。 */
  mimeType: string;
  /** data URL（vision.analyze 输入）。 */
  dataUrl: string;
  width: number;
  height: number;
  /** 源格式（sharp metadata.format，如 webp）。 */
  sourceFormat: string;
}

/**
 * 解码并转码图片为 PNG。输入超限、像素超限、解码失败或输出超限一律抛错
 * （fail loud，调用方按"图片分析失败"降级块呈现）。
 */
export async function decodeImageForVision(
  filePath: string,
  options: { maxInputBytes?: number } = {},
): Promise<DecodedImage> {
  const maxInputBytes = resolveMaxInputBytes(options.maxInputBytes);
  // 读入内存后交 Sharp 解码：输入上限检查更精确，且不残留文件句柄
  // （Windows 上路径式 Sharp 的延迟句柄会导致清理 EBUSY）。
  const info = await stat(filePath);
  if (info.size > maxInputBytes) throw new Error("图片超过输入字节上限");
  const data = await readFile(filePath);
  if (data.byteLength > maxInputBytes) throw new Error("图片超过输入字节上限");

  const image = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS });
  const metadata = await image.metadata();
  const output = await image.png().toBuffer();
  if (output.byteLength > MAX_IMAGE_OUTPUT_BYTES) {
    throw new Error("图片转码输出超过字节上限");
  }
  return {
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${output.toString("base64")}`,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sourceFormat: metadata.format ?? "unknown",
  };
}
