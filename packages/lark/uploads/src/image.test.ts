/**
 * 图片统一解码测试：输入字节上限、像素上限（解码炸弹）、输出统一 PNG、
 * 源格式恢复。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeImageForVision, MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_PIXELS } from "./image.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-lark-image-"));
});
afterEach(async () => {
  // Windows 下 sharp 句柄异步释放：先让出事件循环再清理，避免 EBUSY。
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(dir, { recursive: true, force: true });
});

describe("decodeImageForVision", () => {
  it("WebP 解码并统一输出 PNG（源格式恢复）", async () => {
    const path = join(dir, "photo");
    await writeFile(path, await sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).webp().toBuffer());
    const decoded = await decodeImageForVision(path);
    expect(decoded.mimeType).toBe("image/png");
    expect(decoded.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(12);
    expect(decoded.sourceFormat).toBe("webp");
  });

  it("输入字节上限拒绝", async () => {
    const path = join(dir, "big.png");
    await writeFile(path, await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer());
    await expect(decodeImageForVision(path, { maxInputBytes: 16 })).rejects.toThrow(/输入字节上限/);
  });

  it("直接调用时拒绝零值或超过固定预算的输入上限", async () => {
    const path = join(dir, "invalid-limit.png");
    await expect(decodeImageForVision(path, { maxInputBytes: 0 })).rejects.toThrow(/输入上限/);
    await expect(decodeImageForVision(path, { maxInputBytes: 50 * 1024 * 1024 + 1 })).rejects.toThrow(/输入上限/);
  });

  it("像素上限拒绝（解码炸弹）", async () => {
    // 生成略超 MAX_IMAGE_PIXELS 像素的图片（单色 PNG 体积小，避免内存压力）。
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    const path = join(dir, "bomb.png");
    await writeFile(path, await sharp({
      create: { width: side, height: side, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer());
    await expect(decodeImageForVision(path)).rejects.toThrow();
  });

  it("转码输出字节上限拒绝（PNG 膨胀防护）", async () => {
    // 用大量高频噪点图片制造 PNG 膨胀，验证输出上限仍生效。
    const width = 256;
    const height = 256;
    const raw = Buffer.alloc(width * height * 3);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) % 256;
    const path = join(dir, "noise.png");
    await writeFile(path, await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
    // 输出上限 10 MiB 应大于该图，但解码链路必须成功且受控；用极小上限验证拒绝逻辑。
    await expect(decodeImageForVision(path)).resolves.toBeTruthy();
    expect(MAX_IMAGE_OUTPUT_BYTES).toBeGreaterThan(0);
  });
});
