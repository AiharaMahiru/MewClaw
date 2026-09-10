/**
 * 统一内容检测测试：BOM 文本优先（防 file-type 误判）、图片/PDF/Office
 * 按真实内容识别、纯文本与未知扩展名归 text、普通 zip 归 binary。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectContent } from "./detect.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-lark-detect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, data: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("detectContent 文本", () => {
  it("UTF-16LE/BE BOM 文本不被误判为二进制（file-type 会误报 audio/mpeg）", async () => {
    // FF FE 开头：file-type 单看魔数会识别为 audio/mpeg，BOM 优先必须生效。
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), new TextEncoder().encode("内容")]);
    expect((await detectContent(await write("note", utf16le))).kind).toBe("text");
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), new TextEncoder().encode("内容")]);
    expect((await detectContent(await write("note2", utf16be))).kind).toBe("text");
  });

  it("UTF-8 BOM 文本归 text", async () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), new TextEncoder().encode("标题")]);
    expect((await detectContent(await write("doc.txt", data))).kind).toBe("text");
  });

  it("纯文本（无 BOM、未知扩展名、无扩展名）归 text", async () => {
    for (const [name, content] of [
      ["a.py", "def f():\n    return 1\n"],
      ["b.csv", "a,b\n1,2\n"],
      ["c", "# 无扩展名\n正文\n"],
      ["d.weird", "任意文本内容"],
    ] as const) {
      const detection = await detectContent(await write(name, new TextEncoder().encode(content)));
      expect(detection.kind).toBe("text");
      expect(detection.mimeType).toBeNull();
    }
  });
});

describe("detectContent 二进制", () => {
  it("图片按真实内容识别（Sharp 生成多种格式）", async () => {
    const makeImage = async (format: "png" | "jpeg" | "gif" | "webp" | "avif" | "tiff") => {
      const pipeline = sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } });
      const buffer = await pipeline[format]().toBuffer();
      return write(`img-${format}`, buffer);
    };
    for (const format of ["png", "jpeg", "gif", "webp", "avif", "tiff"] as const) {
      const path = await makeImage(format);
      const detection = await detectContent(path);
      expect(detection.kind).toBe("image");
      expect(detection.mimeType).toMatch(/^image\//);
    }
  });

  it("PDF 与普通 zip 归对应类型", async () => {
    const pdf = await write("paper", Buffer.from("%PDF-1.4\n1 0 obj\nendobj\n"));
    expect((await detectContent(pdf)).kind).toBe("pdf");
    // 普通 zip（非 Office）：file-type 深度检测不命中 docx/xlsx → binary。
    const { zipSync } = await import("fflate");
    const zip = await write("archive", Buffer.from(zipSync({ "a.txt": new TextEncoder().encode("x") })));
    const detection = await detectContent(zip);
    expect(detection.kind).toBe("binary");
    expect(detection.mimeType).toBe("application/zip");
  });
});
