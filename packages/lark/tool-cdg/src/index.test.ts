import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { apply, testing } from "./index.js";

const BINARY = "/opt/dsh/runtime/cdgbridge/1.0.0/cdgbridge";
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-tool-cdg-test-"));
  cleanup.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("CDG 工作区路径边界", () => {
  it("接受工作区内路径并拒绝词法逃逸", async () => {
    const root = await workspace();
    await writeFile(join(root, "inside.txt"), "ok", "utf8");
    await expect(testing.existingPath(root, "inside.txt")).resolves.toBe(join(root, "inside.txt"));
    await expect(testing.existingPath(root, "../outside.txt")).rejects.toThrow(/超出/);
  });

  it("拒绝通过符号链接读取或写入工作区外", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "dsh-tool-cdg-outside-"));
    cleanup.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "escape"));
    await expect(testing.existingPath(root, "escape/secret.txt")).rejects.toThrow(/符号链接逃逸/);
    await expect(testing.writablePath(root, "escape/new.cdg")).rejects.toThrow(/符号链接逃逸/);
  });

  it("限制动作名和数值边界", () => {
    expect(() => testing.parseArgs({ action: "shell" })).toThrow(/不受支持/);
    expect(() => testing.parseArgs({ action: "inspect" })).not.toThrow();
    expect(testing.parseArgs({ action: "decrypt_file", overwrite: true })).toMatchObject({ no_clobber: false });
    expect(() => testing.parseArgs({ action: "decrypt_file", overwrite: true, no_clobber: true })).toThrow(/冲突/);
  });

  it("解密默认保留源文件且目录操作默认只预览", async () => {
    const root = await workspace();
    await writeFile(join(root, "protected.cdg"), "fixture", "utf8");
    const decrypt = await testing.commandArgs(
      { action: "decrypt_file", path: "protected.cdg", output_path: "plain.bin" },
      root,
      BINARY,
    );
    expect(decrypt.argv).toEqual([
      "read", join(root, "protected.cdg"), "--out", join(root, "plain.bin"),
      "--no-clobber", "--strict-output",
    ]);

    const directory = await testing.commandArgs(
      { action: "decrypt_dir", path: ".", output_path: "plain-output" },
      root,
      BINARY,
    );
    expect(directory.argv).toContain("--dry-run");
    expect(directory.argv).not.toContain("--overwrite");
  });
});

describe.skipIf(!existsSync(BINARY))("CDG 模型工具实机", () => {
  it("普通用户工作区内可加密、探测和解密，且不会删除原文件", async () => {
    const root = await workspace();
    let definition: { execute(args: unknown, exec: unknown): Promise<{ action: string; output: string }> } | undefined;
    let activation: Promise<unknown> | undefined;
    const ctx = {
      effect(callback: () => Promise<unknown>) {
        activation = callback();
        return vi.fn();
      },
      systemPrompt: { section: vi.fn(() => vi.fn()) },
      tools: { register: vi.fn((value) => { definition = value; return vi.fn(); }) },
      larkScopeIndex: { get: vi.fn(() => ({ tenantId: "t", botId: "b", deploymentId: "d", userId: "u", conversationId: "c" })) },
    };
    apply(ctx as never, { command: BINARY });
    await activation;
    expect(definition).toBeDefined();
    const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };

    await definition!.execute({ action: "write_text", output_path: "protected.cdg", text: "hello CDG" }, exec);
    expect(existsSync(join(root, "protected.cdg"))).toBe(true);
    await definition!.execute({ action: "decrypt_file", path: "protected.cdg", output_path: "plain.bin" }, exec);
    const plain = await definition!.execute({ action: "read", path: "plain.bin" }, exec);
    expect(JSON.parse(plain.output)).toMatchObject({ content: "hello CDG", isEncrypted: false, eof: true });
    const cipher = await definition!.execute({ action: "read", path: "protected.cdg", encoding: "base64" }, exec);
    expect(JSON.parse(cipher.output)).toMatchObject({ content: Buffer.from("hello CDG").toString("base64"), isEncrypted: true });
    await definition!.execute({ action: "append_text", path: "protected.cdg", text: "追加" }, exec);
    expect(JSON.parse((await definition!.execute({ action: "read", path: "protected.cdg" }, exec)).output).content).toBe("hello CDG追加");
    await definition!.execute({ action: "write_plaintext", output_path: "delivery.html", text: "<h1>中文交付</h1>" }, exec);
    await expect(definition!.execute({ action: "write_plaintext", output_path: "delivery.html", text: "overwrite" }, exec)).rejects.toThrow(/^cdg_file: 工作区文件操作失败（EEXIST）$/u);
    await definition!.execute({ action: "write_plaintext", output_path: "delivery.html", text: "替换", overwrite: true }, exec);
    await definition!.execute({ action: "append_text", path: "delivery.html", text: "追加" }, exec);
    expect(await readFile(join(root, "delivery.html"), "utf8")).toBe("替换追加");
    const matches = (await definition!.execute({ action: "grep", path: "delivery.html", pattern: "替换" }, exec)).output;
    expect(matches).toContain("替换");
    expect(matches).toContain("delivery.html");
    expect(matches).not.toContain("search.cdg");
    await expect(definition!.execute({ action: "append_text", path: "delivery.html", text: "失败", expected_sha256: "0".repeat(64) }, exec)).rejects.toThrow(/摘要不匹配/);
    expect(await readFile(join(root, "delivery.html"), "utf8")).toBe("替换追加");
    const png = Buffer.from("89504e470d0a1a0a000102030405", "hex");
    await writeFile(join(root, "photo.png"), png);
    const binary = JSON.parse((await definition!.execute({ action: "read", path: "photo.png", encoding: "base64" }, exec)).output);
    expect(Buffer.from(binary.content, "base64")).toEqual(png);
    await expect(definition!.execute({ action: "read", path: "photo.png", length: 65537 }, exec)).rejects.toThrow(/范围/);
    await definition!.execute({ action: "write_text", output_path: "source.html", text: '<html><body>真实照片<img src="photo.png"></body></html>' }, exec);
    const embedded = await definition!.execute({ action: "embed_images", path: "source.html", output_path: "standalone.html" }, exec);
    expect(JSON.parse(embedded.output)).toMatchObject({ embedded: 1, unresolved: 0, isEncrypted: false });
    expect(await readFile(join(root, "standalone.html"), "utf8")).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(await readFile(join(root, "standalone.html"), "utf8")).toContain('charset="utf-8"');
    expect(JSON.parse((await definition!.execute({ action: "inspect", path: "source.html" }, exec)).output).isEncrypted).toBe(true);
    await definition!.execute({ action: "write_plaintext", output_path: "escape.html", text: '<img src="../outside.png">' }, exec);
    await expect(definition!.execute({ action: "embed_images", path: "escape.html", output_path: "escape-output.html" }, exec)).rejects.toThrow(/超出/);
    expect(JSON.parse((await definition!.execute({ action: "list" }, exec)).output).entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: "photo.png" })]));
    const diagnostic = await definition!.execute({ action: "doctor" }, exec);
    expect(typeof JSON.parse(diagnostic.output).healthy).toBe("boolean");
    const inspect = await definition!.execute({ action: "inspect", path: "protected.cdg" }, exec);
    expect(inspect.output).toContain('"isEncrypted": true');
    await definition!.execute({ action: "decrypt_file", path: "protected.cdg", output_path: "plain.bin", overwrite: true }, exec);
    expect(await readFile(join(root, "plain.bin"), "utf8")).toBe("hello CDG追加");
    expect(existsSync(join(root, "protected.cdg"))).toBe(true);
  });

  it("没有普通用户运行 Scope 时拒绝执行", async () => {
    const root = await workspace();
    let definition: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined;
    let activation: Promise<unknown> | undefined;
    const ctx = {
      effect(callback: () => Promise<unknown>) { activation = callback(); return vi.fn(); },
      systemPrompt: { section: vi.fn(() => vi.fn()) },
      tools: { register: vi.fn((value) => { definition = value; return vi.fn(); }) },
      larkScopeIndex: { get: vi.fn(() => undefined) },
    };
    apply(ctx as never, { command: BINARY });
    await activation;
    const exec = { agent: { id: "session-test", session: { header: { cwd: root } } }, signal: new AbortController().signal };
    await expect(definition!.execute({ action: "doctor" }, exec)).rejects.toThrow(/Scope/);
  });
});
