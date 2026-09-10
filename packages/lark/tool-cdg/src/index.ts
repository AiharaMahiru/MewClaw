/**
 * 模型可见的 CDG 文件工具。
 *
 * 外部二进制和密钥只来自宿主配置；模型只能提供当前会话工作区内的
 * 文件路径。所有命令均以参数数组调用，不经过 shell，也不能跨用户工作区。
 */
import { execFile } from "node:child_process";
import { mkdtemp, lstat, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { requireLarkRunScope } from "dsh-lark-contracts";
import { fileOperation } from "./file-operations.js";

export const name = "tool-cdg";
export const inject = ["larkScopeIndex", "systemPrompt", "tools"];

const executeFile = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_FILES = 256;
const MAX_REPLACEMENTS = 10_000;

export interface Config {
  /** cdgbridge CLI 的绝对路径。 */
  command?: string;
  /** 单次操作超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 是否注册工具，默认 true。 */
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  command: z.string(),
  timeoutMs: z.number(),
  enabled: z.boolean(),
});

type Action =
  | "inspect" | "read" | "decrypt_file" | "write" | "write_text"
  | "patch" | "replace_text" | "grep" | "replace"
  | "encrypt_dir" | "decrypt_dir" | "doctor" | "list" | "write_plaintext" | "append_text" | "embed_images";

interface CdgArgs {
  action: Action;
  path?: string;
  output_path?: string;
  input_path?: string;
  text?: string;
  content_base64?: string;
  encoding?: string;
  old_text?: string;
  new_text?: string;
  pattern?: string;
  replacement?: string;
  expected_sha256?: string;
  glob?: string;
  output_mode?: string;
  offset?: number;
  length?: number;
  max_files?: number;
  max_replacements?: number;
  dry_run?: boolean;
  overwrite?: boolean;
  no_clobber?: boolean;
  strict_output?: boolean;
  replace_all?: boolean;
  literal?: boolean;
  case_insensitive?: boolean;
  dot_all?: boolean;
  keep_bin_extension?: boolean;
}

function inside(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function resolveLexical(root: string, value: string): string {
  const candidate = resolve(root, value);
  if (!inside(root, candidate)) throw new Error("cdg_file: 路径超出当前会话工作区");
  return candidate;
}

async function existingPath(root: string, value: string): Promise<string> {
  const candidate = resolveLexical(root, value);
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical) throw new Error("cdg_file: 输入路径不存在");
  if (!inside(root, canonical)) throw new Error("cdg_file: 输入路径通过符号链接逃逸工作区");
  return canonical;
}

async function existingFile(root: string, value: string): Promise<string> {
  const path = await existingPath(root, value);
  if (!(await stat(path)).isFile()) throw new Error("cdg_file: 输入路径不是常规文件");
  return path;
}

async function existingDirectory(root: string, value: string): Promise<string> {
  const path = await existingPath(root, value);
  if (!(await stat(path)).isDirectory()) throw new Error("cdg_file: 输入路径不是目录");
  return path;
}

async function writablePath(root: string, value: string): Promise<string> {
  const candidate = resolveLexical(root, value);
  const current = await lstat(candidate).catch(() => undefined);
  if (current) {
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) throw new Error("cdg_file: 输出路径通过符号链接逃逸工作区");
    return canonical;
  }
  let parent = dirname(candidate);
  for (;;) {
    const metadata = await lstat(parent).catch(() => undefined);
    if (metadata) {
      const canonicalParent = await realpath(parent);
      if (!inside(root, canonicalParent)) throw new Error("cdg_file: 输出目录通过符号链接逃逸工作区");
      return candidate;
    }
    const next = dirname(parent);
    if (next === parent) throw new Error("cdg_file: 找不到可写输出目录");
    parent = next;
  }
}

function requiredString(args: CdgArgs, key: keyof CdgArgs, max = 100_000): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`cdg_file: ${String(key)} 必须是非空字符串`);
  }
  return value;
}

function optionalString(args: CdgArgs, key: keyof CdgArgs, max = 100_000): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`cdg_file: ${String(key)} 必须是非空字符串`);
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`cdg_file: ${name} 必须是 ${min}..${max} 的整数`);
  }
  return resolved;
}

function parseArgs(value: unknown): CdgArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cdg_file: 参数必须是对象");
  const args = value as CdgArgs;
  const actions = new Set<Action>([
    "inspect", "read", "decrypt_file", "write", "write_text", "patch",
    "replace_text", "grep", "replace", "encrypt_dir", "decrypt_dir", "doctor",
    "list", "write_plaintext", "append_text", "embed_images",
  ]);
  if (!actions.has(args.action)) throw new Error("cdg_file: action 不受支持");
  for (const key of ["overwrite", "no_clobber"] as const) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`cdg_file: ${key} 必须是布尔值`);
  }
  if (args.overwrite !== undefined && args.no_clobber !== undefined && args.overwrite === args.no_clobber) {
    throw new Error("cdg_file: overwrite 与 no_clobber 冲突");
  }
  if (args.overwrite !== undefined && args.no_clobber === undefined) return { ...args, no_clobber: !args.overwrite };
  return args;
}

async function run(command: string, argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const sanitize = (value: string): string => value
    .replaceAll(cwd, ".")
    .replaceAll(command, "cdgbridge")
    .replaceAll(dirname(command), "<cdg-runtime>")
    .replace(new RegExp(`${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dsh-cdg-(?:input|patch|read|append|grep)-[^/\\s]+`, "g"), "<temporary>");
  try {
    const result = await executeFile(command, argv, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return sanitize(String(result.stdout)).trim();
  } catch (error) {
    // doctor 的非零退出可以表示未注册外部客户端；有效诊断仍应交付给调用者。
    if (argv[0] === "doctor" && error && typeof error === "object" && "stdout" in error) {
      try {
        const report: unknown = JSON.parse(String(error.stdout));
        if (report && typeof report === "object" && "healthy" in report && typeof report.healthy === "boolean") return sanitize(JSON.stringify(report));
      } catch { /* 非结构化失败仍走统一错误。 */ }
    }
    const detail = error instanceof Error ? sanitize(error.message) : "调用失败";
    throw new Error(`cdg_file: ${argv[0]} 失败（${detail}）`);
  }
}

async function commandArgs(args: CdgArgs, root: string, command: string): Promise<{ argv: string[]; temporary?: string }> {
  const source = ["doctor", "write", "write_text"].includes(args.action)
    ? undefined
    : requiredString(args, "path", 4096);
  const path = source === undefined
    ? undefined
    : ["encrypt_dir", "decrypt_dir"].includes(args.action)
      ? await existingDirectory(root, source)
      : ["grep", "replace"].includes(args.action)
        ? await existingPath(root, source)
        : await existingFile(root, source);
  switch (args.action) {
    case "inspect": return { argv: ["inspect", path!] };
    case "read": {
      const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const length = boundedInteger(args.length, MAX_READ_BYTES, 1, MAX_READ_BYTES, "length");
      return { argv: ["read", path!, "--offset", String(offset), "--length", String(length)] };
    }
    case "decrypt_file": {
      const output = await writablePath(root, requiredString(args, "output_path", 4096));
      if (output === path) throw new Error("cdg_file: 解密输出不能覆盖源文件");
      const argv = ["read", path!, "--out", output];
      if (args.no_clobber !== false) argv.push("--no-clobber");
      if (args.strict_output !== false) argv.push("--strict-output");
      return { argv };
    }
    case "write": {
      const output = await writablePath(root, requiredString(args, "output_path", 4096));
      const input = await existingFile(root, requiredString(args, "input_path", 4096));
      if (output === input) throw new Error("cdg_file: 加密输出不能覆盖明文输入");
      const argv = ["write", output, "--in", input];
      if (args.no_clobber !== false) argv.push("--no-clobber");
      return { argv };
    }
    case "write_text": {
      const output = await writablePath(root, requiredString(args, "output_path", 4096));
      const text = requiredString(args, "text", MAX_OUTPUT_BYTES);
      if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw new Error("cdg_file: text 超过大小上限");
      const temporary = await mkdtemp(resolve(tmpdir(), "dsh-cdg-input-"));
      const input = resolve(temporary, "plaintext.bin");
      await writeFile(input, text, { encoding: "utf8", mode: 0o600 });
      const argv = ["write", output, "--in", input];
      if (args.no_clobber !== false) argv.push("--no-clobber");
      return { argv, temporary };
    }
    case "patch": {
      const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const encoded = requiredString(args, "content_base64", MAX_OUTPUT_BYTES);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error("cdg_file: content_base64 不是规范 Base64");
      }
      const temporary = await mkdtemp(resolve(tmpdir(), "dsh-cdg-patch-"));
      const input = resolve(temporary, "patch.bin");
      await writeFile(input, Buffer.from(encoded, "base64"), { mode: 0o600 });
      return { argv: ["patch", path!, "--offset", String(offset), "--in", input], temporary };
    }
    case "replace_text": {
      const argv = ["replace-text", path!, "--old", requiredString(args, "old_text"), "--new", requiredString(args, "new_text")];
      const expected = optionalString(args, "expected_sha256", 64);
      if (expected) {
        if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("cdg_file: expected_sha256 格式无效");
        argv.push("--expected-sha256", expected);
      }
      if (args.replace_all === true) argv.push("--replace-all");
      if (args.dry_run !== false) argv.push("--dry-run");
      return { argv };
    }
    case "grep": {
      const argv = ["grep", path!, "--pattern", requiredString(args, "pattern")];
      const glob = optionalString(args, "glob", 4096);
      if (glob) argv.push("--glob", glob);
      if (args.case_insensitive === true) argv.push("--case-insensitive");
      const outputMode = args.output_mode ?? "content";
      if (!["content", "files_with_matches", "count", "summary"].includes(outputMode)) throw new Error("cdg_file: output_mode 无效");
      argv.push("--output-mode", outputMode);
      return { argv };
    }
    case "replace": {
      const argv = ["replace", path!, "--pattern", requiredString(args, "pattern"), "--replacement", requiredString(args, "replacement")];
      const glob = optionalString(args, "glob", 4096);
      if (glob) argv.push("--glob", glob);
      if (args.literal === true) argv.push("--literal");
      if (args.case_insensitive === true) argv.push("--case-insensitive");
      if (args.dot_all === true) argv.push("--dot-all");
      if (args.dry_run !== false) argv.push("--dry-run");
      argv.push("--max-replacements", String(boundedInteger(args.max_replacements, 100, 1, MAX_REPLACEMENTS, "max_replacements")));
      return { argv };
    }
    case "encrypt_dir":
    case "decrypt_dir": {
      const output = await writablePath(root, requiredString(args, "output_path", 4096));
      if (output === path) throw new Error("cdg_file: 目录输出不能与源目录相同");
      const argv = [args.action === "encrypt_dir" ? "encrypt-dir" : "decrypt-dir", path!, "--out", output];
      const glob = optionalString(args, "glob", 4096);
      if (glob) argv.push("--glob", glob);
      if (args.dry_run !== false) argv.push("--dry-run");
      if (args.overwrite === true) argv.push("--overwrite");
      if (args.action === "encrypt_dir" && args.keep_bin_extension === true) argv.push("--keep-bin-extension");
      argv.push("--max-files", String(boundedInteger(args.max_files, MAX_FILES, 1, MAX_FILES, "max_files")));
      return { argv };
    }
    case "doctor": return { argv: ["doctor", "--client", "all", "--scope", "project", "--mcp-exe", resolve(dirname(command), "cdgbridge-mcp")] };
    case "list": case "write_plaintext": case "append_text": case "embed_images": throw new Error("cdg_file: 内部动作分派错误");
  }
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;
  const command = config.command;
  if (!command) throw new Error("tool-cdg: 未配置 cdgbridge 可执行文件");
  if (!isAbsolute(command)) throw new Error("tool-cdg: command 必须是绝对路径");
  const timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS, "timeoutMs");

  ctx.effect(async () => {
    const metadata = await stat(command).catch(() => undefined);
    if (!metadata?.isFile()) throw new Error("tool-cdg: cdgbridge 可执行文件不存在");
    const disposePrompt = ctx.systemPrompt.section({
        name: "tool:cdg_file",
        order: 111,
        text:
          "When the user asks to inspect, read, decrypt, encrypt, search, or edit CDG/Esafenet files, use cdg_file directly. "
          + "Paths are relative to this session workspace; list with path='.' to discover files, never guess host paths. "
          + "write_text creates ENCRYPTED files, not ordinary HTML/PDF deliverables. Use write_plaintext for normal text delivery. "
          + "read accepts plaintext and encrypted files; use encoding=base64 for binary bytes. append_text extends a file; patch only overwrites a fixed-length range. "
          + "For HTML use embed_images(path, output_path) to embed actual local img src photos into a plaintext copy, not substitute illustrations. Browser downloads do not reach this workspace. "
          + "Never request or expose a key path. Use dry_run first for directory or bulk replacement operations.",
      });
    const disposeTool = ctx.tools.register(defineTool({
        name: "cdg_file",
        description: "Inspect, read, decrypt, encrypt, search, or safely edit CDG/Esafenet files inside the current session workspace.",
        parameters: {
          action: { type: "string", required: true, description: "One of list, inspect, read, decrypt_file, write, write_text (encrypted), write_plaintext, append_text, embed_images (HTML with real local photos), patch (fixed length), replace_text, grep (single plaintext/CDG file; directories CDG only), replace, encrypt_dir, decrypt_dir, doctor." },
          path: { type: "string", description: "Workspace-relative source file or directory." },
          output_path: { type: "string", description: "Workspace-relative output path; source and destination must differ." },
          input_path: { type: "string", description: "Workspace-relative plaintext input file for write." },
          text: { type: "string", description: "Text input for write_text, write_plaintext, or append_text." },
          content_base64: { type: "string", description: "Fixed-length patch bytes encoded as canonical Base64." },
          encoding: { type: "string", description: "read output encoding: utf8 (default) or base64 for binary bytes; offset/length are bytes, up to 64KiB per call." },
          old_text: { type: "string" }, new_text: { type: "string" },
          pattern: { type: "string" }, replacement: { type: "string" },
          expected_sha256: { type: "string" }, glob: { type: "string" }, output_mode: { type: "string" },
          offset: { type: "number" }, length: { type: "number" }, max_files: { type: "number" }, max_replacements: { type: "number" },
          dry_run: { type: "boolean" }, overwrite: { type: "boolean", description: "Explicit replacement; single-file alias for no_clobber=false." }, no_clobber: { type: "boolean", description: "Defaults true for writes/decryption. Set false to replace an existing output." }, strict_output: { type: "boolean" },
          replace_all: { type: "boolean" }, literal: { type: "boolean" }, case_insensitive: { type: "boolean" }, dot_all: { type: "boolean" },
          keep_bin_extension: { type: "boolean" },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", required: true },
              output: { type: "string", required: true },
            },
          },
          render: (_args, value) => [{ type: "text", text: (value as { output: string }).output }],
        },
        async execute(value, exec) {
          const args = parseArgs(value);
          requireLarkRunScope(ctx, exec, "cdg_file");
          const cwd = exec.agent?.session.header.cwd;
          if (!cwd) throw new Error("cdg_file: 缺少会话工作区");
          const root = await realpath(cwd);
          let direct: string | undefined;
          try {
            direct = await fileOperation(args, {
              root, run: (argv) => run(command, argv, root, timeoutMs, exec.signal),
              file: (path) => existingFile(root, path), existing: (path) => existingPath(root, path),
              writable: (path) => writablePath(root, path),
            });
          } catch (error) {
            // 原生文件错误含宿主绝对路径；仅返回可诊断的错误码。
            if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/u.test(error.code)) {
              throw new Error(`cdg_file: 工作区文件操作失败（${error.code}）`);
            }
            throw error;
          }
          if (direct !== undefined) return { action: args.action, output: direct };
          const invocation = await commandArgs(args, root, command);
          try {
            const output = await run(command, invocation.argv, root, timeoutMs, exec.signal);
            return { action: args.action, output: output || `${args.action}: completed` };
          } finally {
            if (invocation.temporary) await rm(invocation.temporary, { recursive: true, force: true });
          }
        },
      }));
    return () => {
      disposeTool();
      disposePrompt();
    };
  }, "tool-cdg:register");
}

export const testing = { commandArgs, existingDirectory, existingFile, existingPath, parseArgs, writablePath };
export { fileOperation } from "./file-operations.js";
