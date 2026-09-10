import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";

const MAX_READ = 64 * 1024;
const MAX_EDIT = 8 * 1024 * 1024;

interface Args {
  action: string; path?: string; output_path?: string; text?: string;
  encoding?: string; offset?: number; length?: number; no_clobber?: boolean; expected_sha256?: string;
  pattern?: string; case_insensitive?: boolean; output_mode?: string;
}
interface Io {
  root: string;
  run(argv: string[]): Promise<string>;
  file(path: string): Promise<string>;
  existing(path: string): Promise<string>;
  writable(path: string): Promise<string>;
}
interface Inspection { isEncrypted: boolean; uploadSize: number }

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function integer(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new Error("cdg_file: 读取范围无效");
  return result;
}
function pathArg(value: string | undefined): string {
  if (!value || value.length > 4096) throw new Error("cdg_file: 必须提供工作区相对路径");
  return value;
}
async function inspect(io: Io, path: string): Promise<Inspection> {
  const value = JSON.parse(await io.run(["inspect", path])) as Partial<Inspection>;
  if (typeof value.isEncrypted !== "boolean" || !Number.isSafeInteger(value.uploadSize) || value.uploadSize! < 0) {
    throw new Error("cdg_file: 文件加密状态无法判定");
  }
  return value as Inspection;
}

/** 明确探测成功后才读取明文；密文只交给受控 CLI，临时副本始终清理。 */
async function bytes(io: Io, path: string, info: Inspection, offset: number, length: number): Promise<Buffer> {
  if (offset >= info.uploadSize || length === 0) return Buffer.alloc(0);
  if (!info.isEncrypted) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, info.uploadSize - offset));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, result.bytesRead);
    } finally { await handle.close(); }
  }
  const temp = await mkdtemp(join(tmpdir(), "dsh-cdg-read-"));
  try {
    const output = join(temp, "part.bin");
    await io.run(["read", path, "--offset", String(offset), "--length", String(length), "--out", output, "--strict-output"]);
    if ((await stat(output)).size > length) throw new Error("cdg_file: 解密结果超出读取范围");
    return await readFile(output);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function commit(path: string, data: Buffer, overwrite: boolean, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!overwrite) {
    await writeFile(path, data, { flag: "wx", mode });
    return;
  }
  const staged = join(dirname(path), `.dsh-cdg-${randomUUID()}.tmp`);
  try {
    await writeFile(staged, data, { flag: "wx", mode });
    await rename(staged, path);
  } finally { await rm(staged, { force: true }); }
}

/** 返回 undefined 表示交给原 CDG CLI 动作，不把未知动作当作明文操作。 */
export async function fileOperation(args: Args, io: Io): Promise<string | undefined> {
  if (args.action === "embed_images") {
    const source = await io.file(pathArg(args.path));
    const output = await io.writable(pathArg(args.output_path));
    if (source === output) throw new Error("cdg_file: 内嵌交付必须保留HTML原件，使用不同输出路径");
    const info = await inspect(io, source);
    if (info.uploadSize > MAX_EDIT) throw new Error("cdg_file: HTML 超过8MiB");
    let html = (await bytes(io, source, info, 0, info.uploadSize)).toString("utf8");
    let embedded = 0;
    let unresolved = 0;
    let total = Buffer.byteLength(html);
    const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const match of html.matchAll(/<img\b[^>]*>/giu)) {
      const tag = match[0];
      const src = /(?<=\s)src\s*=\s*(["'])(.*?)\1/iu.exec(tag);
      if (!src || /\bsrcset\s*=/iu.test(tag)) { unresolved++; continue; }
      const value = src[2]!;
      if (/^data:image\//iu.test(value)) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value)) { unresolved++; continue; }
      const reference = decodeURIComponent(value.replaceAll("&amp;", "&").split(/[?#]/u)[0]!);
      const imagePath = await io.file(join(dirname(source), reference));
      const imageInfo = await inspect(io, imagePath);
      const contentType = mime[extname(imagePath).toLowerCase()];
      if (!contentType) { unresolved++; continue; }
      total += Math.ceil(imageInfo.uploadSize / 3) * 4;
      if (total > MAX_EDIT) throw new Error("cdg_file: 内嵌HTML超过8MiB，请压缩图片后重试");
      const data = await bytes(io, imagePath, imageInfo, 0, imageInfo.uploadSize);
      const embeddedTag = tag.slice(0, src.index) + `src="data:${contentType};base64,${data.toString("base64")}"` + tag.slice(src.index + src[0].length);
      replacements.push({ start: match.index, end: match.index + tag.length, text: embeddedTag });
      embedded++;
    }
    for (const replacement of replacements.reverse()) html = html.slice(0, replacement.start) + replacement.text + html.slice(replacement.end);
    if (!/<meta\b[^>]*charset\s*=/iu.test(html)) html = `<meta charset="utf-8">\n${html}`;
    if (await lstat(output).catch(() => undefined)) {
      if ((await inspect(io, output)).isEncrypted) throw new Error("cdg_file: 不能覆盖加密原件");
    }
    const data = Buffer.from(html);
    await commit(output, data, args.no_clobber === false);
    return JSON.stringify({ path: relative(io.root, output), size: data.length, sha256: digest(data), isEncrypted: false, embedded, unresolved, note: "仅内嵌img src中的本地照片；CSS/JS等其他资源未打包" });
  }
  if (args.action === "list") {
    const path = await io.existing(args.path ?? ".");
    if (!(await stat(path)).isDirectory()) throw new Error("cdg_file: list 需要目录");
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ path: relative(io.root, path) || ".", entries: entries.slice(0, 256).map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file" })), truncated: entries.length > 256 });
  }
  if (args.action === "read") {
    const path = await io.file(pathArg(args.path));
    const info = await inspect(io, path);
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const length = integer(args.length, MAX_READ, MAX_READ);
    const encoding = args.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw new Error("cdg_file: encoding 只支持 utf8/base64");
    const data = await bytes(io, path, info, offset, length);
    return JSON.stringify({ encoding, content: data.toString(encoding), offset, nextOffset: offset + data.length, eof: offset + data.length >= info.uploadSize, size: info.uploadSize, isEncrypted: info.isEncrypted });
  }
  if (args.action === "write_plaintext") {
    if (typeof args.text !== "string" || Buffer.byteLength(args.text) > MAX_EDIT) throw new Error("cdg_file: text 必须是不超过8MiB的文本");
    const path = await io.writable(pathArg(args.output_path));
    const data = Buffer.from(args.text);
    if (await lstat(path).catch(() => undefined)) {
      if ((await inspect(io, path)).isEncrypted) throw new Error("cdg_file: 明文交付不能覆盖加密原件，请使用不同输出路径");
    }
    await commit(path, data, args.no_clobber === false);
    return JSON.stringify({ path: relative(io.root, path), size: data.length, sha256: digest(data), isEncrypted: false });
  }
  if (args.action === "append_text") {
    if (typeof args.text !== "string" || Buffer.byteLength(args.text) > MAX_EDIT) throw new Error("cdg_file: 追加文本超过8MiB");
    const path = await io.file(pathArg(args.path));
    const info = await inspect(io, path);
    if (info.uploadSize + Buffer.byteLength(args.text) > MAX_EDIT) throw new Error("cdg_file: 追加后文件超过8MiB");
    const original = await readFile(path);
    const previous = await bytes(io, path, info, 0, info.uploadSize);
    if (args.expected_sha256 !== undefined && args.expected_sha256 !== digest(previous)) throw new Error("cdg_file: 原文摘要不匹配");
    const updated = Buffer.concat([previous, Buffer.from(args.text)]);
    let stored = updated;
    if (info.isEncrypted) {
      const temp = await mkdtemp(join(tmpdir(), "dsh-cdg-append-"));
      try {
        const input = join(temp, "input.txt");
        const output = join(temp, "encoded.cdg");
        await writeFile(input, updated, { mode: 0o600 });
        await io.run(["write", output, "--in", input, "--no-clobber"]);
        stored = await readFile(output);
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (!(await readFile(path)).equals(original)) throw new Error("cdg_file: 文件已变化，拒绝覆盖");
    await commit(path, stored, true, (await stat(path)).mode & 0o777);
    return JSON.stringify({ path: relative(io.root, path), size: updated.length, sha256: digest(updated), isEncrypted: info.isEncrypted });
  }
  if (args.action === "grep" && args.path) {
    const path = await io.existing(args.path);
    if ((await stat(path)).isFile() && !(await inspect(io, path)).isEncrypted) {
      if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 100000) throw new Error("cdg_file: pattern 必须是非空有界字符串");
      if ((await stat(path)).size > MAX_EDIT) throw new Error("cdg_file: 明文grep文件超过8MiB，请使用普通grep或Bash");
      const outputMode = args.output_mode ?? "content";
      if (!["content", "files_with_matches", "count", "summary"].includes(outputMode)) throw new Error("cdg_file: output_mode 无效");
      const temp = await mkdtemp(join(tmpdir(), "dsh-cdg-grep-"));
      try {
        const encrypted = join(temp, "search.cdg");
        await io.run(["write", encrypted, "--in", path, "--no-clobber"]);
        const argv = ["grep", encrypted, "--pattern", args.pattern, "--output-mode", outputMode];
        if (args.case_insensitive === true) argv.push("--case-insensitive");
        return (await io.run(argv)).replaceAll(encrypted, relative(io.root, path))
          .replaceAll("<temporary>/search.cdg", relative(io.root, path))
          .replaceAll(temp, "<temporary>") || "grep: no matches";
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
  }
  return undefined;
}
