/**
 * 文本提取测试（内容驱动）：多编码（UTF-8/UTF-16/GB18030）、未知扩展名
 * 与无扩展名文本按内容读取、二进制拒绝（明确类型而非猜测）、空文本拒绝。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractFile, UnsupportedBinaryError } from "./extract.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dsh-lark-extract-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, data: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, data);
  return path;
}

describe("extractFile 文本", () => {
  it("UTF-8 文本提取 + 规范 MIME（markdown）", async () => {
    const path = await write("a.md", new TextEncoder().encode("# 标题\n\n正文内容\n"));
    expect(await extractFile(path)).toEqual({ text: "# 标题\n\n正文内容", mimeType: "text/markdown" });
  });

  it("UTF-16LE（带 BOM）与 GB18030 回退", async () => {
    const utf16 = new TextEncoder().encode("\uFEFF中文内容");
    expect((await extractFile(await write("b.txt", utf16), 1_000_000)).text).toBe("中文内容");
    // GB18030（TextEncoder 不支持该编码，用 Buffer 构造 GBK 字节：'内容'）。
    const gbk = Buffer.from([0xC4, 0xDA, 0xC8, 0xDD]); // GBK 的"内容"
    expect((await extractFile(await write("c.txt", gbk))).text).toBe("内容");
  });

  it("无扩展名与未知扩展名文本按内容读取（不依赖白名单）", async () => {
    const content = "def f():\n    return 1\n";
    expect((await extractFile(await write("script.py", new TextEncoder().encode(content)))).text).toContain("return 1");
    expect((await extractFile(await write("data.csv", new TextEncoder().encode("a,b\n1,2\n")))).mimeType).toBe("text/csv");
    expect((await extractFile(await write("README", new TextEncoder().encode("# 无扩展名\n正文\n")))).text).toContain("正文");
    expect((await extractFile(await write("custom.unknownext", new TextEncoder().encode("内容 x")))).text).toBe("内容 x");
  });

  it("二进制数据拒绝：明确 UnsupportedBinaryError（不猜测加密/损坏）", async () => {
    // PK zip 头（残缺 zip；file-type 识别为 application/zip）。
    const binary = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x01, 0x00]);
    const error = await extractFile(await write("bin.txt", binary)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(UnsupportedBinaryError);
    expect((error as UnsupportedBinaryError).detection.kind).toBe("binary");
    expect((error as UnsupportedBinaryError).message).toMatch(/application\/zip/);
    expect((error as UnsupportedBinaryError).message).not.toMatch(/加密/);
  });

  it("空文本拒绝（fail loud）", async () => {
    await expect(extractFile(await write("empty.txt", new TextEncoder().encode("   \n"))))
      .rejects.toThrow(/未从/);
  });
});
