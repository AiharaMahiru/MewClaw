/** 浏览器工具 Consumer：Scope 与工作区只能来自可信运行上下文。 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { requireLarkRunScope } from "dsh-lark-contracts";
import type { BrowserConsoleLevel, BrowserConsoleResult, BrowserNetworkResult, BrowserPage,
  BrowserSnapshot } from "dsh-browser";
import type {} from "dsh-browser";

export const name = "tool-browser";
export const inject = ["browser", "larkScopeIndex", "systemPrompt", "tools"];

export interface Config { enabled?: boolean }
export const Config: z<Config> = z.object({ enabled: z.boolean() });

const MODEL_TEXT_LIMIT = 30_000;
const URL_LIMIT = 4_096;
const SELECTOR_LIMIT = 2_048;
const INPUT_TEXT_LIMIT = 20_000;
const EXPRESSION_LIMIT = 20_000;
const LOG_LIMIT_MAX = 100;

function trustedContext(ctx: Context, exec: ToolRunContext, tool: string, workspace: true): { scope: ReturnType<typeof requireLarkRunScope>; workspace: string };
function trustedContext(ctx: Context, exec: ToolRunContext, tool: string, workspace?: false): { scope: ReturnType<typeof requireLarkRunScope> };
function trustedContext(ctx: Context, exec: ToolRunContext, tool: string, workspace = false) {
  const scope = requireLarkRunScope(ctx, exec, tool);
  if (!workspace) return { scope };
  const cwd = exec.agent?.session.header.cwd;
  if (!cwd) throw new Error(`${tool} requires a session workspace`);
  return { scope, workspace: cwd };
}

export function parseOpenArgs(value: unknown): { url: string } {
  const input = inputRecord(value, "browser_open");
  const raw = requiredString(input.url, "browser_open: url", URL_LIMIT);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("browser_open: url 非法"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("browser_open: url 必须是无凭证的 HTTP(S) URL");
  }
  return { url: url.href };
}

export function parseSelectorArgs(value: unknown, tool: string): { selector: string } {
  return { selector: requiredString(inputRecord(value, tool).selector, `${tool}: selector`, SELECTOR_LIMIT) };
}

export function parseTypeArgs(value: unknown): { selector: string; text: string } {
  const input = inputRecord(value, "browser_type");
  const selector = requiredString(input.selector, "browser_type: selector", SELECTOR_LIMIT);
  const text = boundedString(input.text, "browser_type: text", INPUT_TEXT_LIMIT);
  return { selector, text };
}

export function parseWaitArgs(value: unknown): { selector?: string; milliseconds?: number } {
  const input = inputRecord(value, "browser_wait");
  const selector = optionalBoundedString(input.selector, "browser_wait: selector", SELECTOR_LIMIT);
  const milliseconds = optionalInteger(input.milliseconds, "browser_wait: milliseconds", 0, 120_000);
  if (selector === undefined && milliseconds === undefined) {
    throw new Error("browser_wait: 至少提供 selector 或 milliseconds 之一");
  }
  return {
    ...(selector === undefined ? {} : { selector }),
    ...(milliseconds === undefined ? {} : { milliseconds }),
  };
}

export function parseEvaluateArgs(value: unknown): { expression: string } {
  const input = inputRecord(value, "browser_evaluate");
  const expression = requiredString(input.expression, "browser_evaluate: expression", EXPRESSION_LIMIT);
  return { expression };
}

export function parseListArgs(value: unknown, tool: string): { level?: BrowserConsoleLevel; limit?: number } {
  const input = inputRecord(value, tool);
  const limit = optionalInteger(input.limit, `${tool}: limit`, 1, LOG_LIMIT_MAX);
  if (tool !== "browser_console" && input.level !== undefined) throw new Error(`${tool}: level 不受支持`);
  const level = tool === "browser_console" ? optionalConsoleLevel(input.level) : undefined;
  return { ...(level === undefined ? {} : { level }), ...(limit === undefined ? {} : { limit }) };
}

export function parseScreenshotArgs(value: unknown): { filename?: string } {
  const input = inputRecord(value, "browser_screenshot");
  const filename = optionalBoundedString(input.filename, "browser_screenshot: filename", 240);
  if (filename !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/i.test(filename) || filename.includes(".."))) {
    throw new Error("browser_screenshot: filename 必须是不含目录的相对 .png 文件名");
  }
  return { ...(filename === undefined ? {} : { filename }) };
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;
  ctx.effect(() => register(ctx), "tool-browser:register");
}

function register(ctx: Context): Array<() => void> {
  const disposers: Array<() => void> = [ctx.systemPrompt.section({
    name: "tool:browser",
    order: 117,
    text: "Use browser_open and browser_snapshot for browser-based research, Web debugging, and automation. Use precise CSS selectors for click/type/wait, inspect console/network failures, save screenshots only when useful, and close the browser when finished.",
  })];

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_open",
    description: "Open an HTTP(S) page in the current user's isolated browser.",
    parameters: { url: { type: "string", required: true, description: "HTTP(S) URL without embedded credentials." } },
    output: pageOutput("已打开"),
    async execute(args, exec) {
      return await ctx.browser!.open({ ...trustedContext(ctx, exec, "browser_open", true), ...parseOpenArgs(args) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_snapshot",
    description: "Return a bounded accessibility-tree snapshot of the current page.",
    parameters: {},
    output: {
      schema: snapshotSchema(),
      render: (_args, value) => [{ type: "text", text: formatSnapshot(value as BrowserSnapshot) }],
    },
    async execute(_args, exec) {
      return await ctx.browser!.snapshot(trustedContext(ctx, exec, "browser_snapshot"));
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_click",
    description: "Click an element selected by a CSS selector.",
    parameters: { selector: { type: "string", required: true, description: "CSS selector for the target element." } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { clicked: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "点击完成" }],
    },
    async execute(args, exec) {
      return await ctx.browser!.click({ ...trustedContext(ctx, exec, "browser_click"), ...parseSelectorArgs(args, "browser_click") });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_type",
    description: "Type text into an element selected by a CSS selector.",
    parameters: {
      selector: { type: "string", required: true, description: "CSS selector for an editable element." },
      text: { type: "string", required: true, description: "Text to enter (max 20000 chars)." },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { typed: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "输入完成" }],
    },
    async execute(args, exec) {
      return await ctx.browser!.type({ ...trustedContext(ctx, exec, "browser_type"), ...parseTypeArgs(args) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_wait",
    description: "Wait for a CSS selector or for a bounded duration.",
    parameters: {
      selector: { type: "string", description: "CSS selector that must appear." },
      milliseconds: { type: "number", description: "Duration in milliseconds (0..120000)." },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { found: { type: "boolean" }, waited: { type: "number" } },
      },
      render: () => [{ type: "text", text: "等待完成" }],
    },
    async execute(args, exec) {
      return await ctx.browser!.wait({ ...trustedContext(ctx, exec, "browser_wait"), ...parseWaitArgs(args) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_evaluate",
    description: "Evaluate a bounded JavaScript expression in the current page.",
    parameters: {
      expression: { type: "string", required: true, description: "JavaScript expression (max 20000 chars)." },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { result: { type: "string", required: true }, truncated: { type: "boolean", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: boundedOutput((value as { result: string }).result) }],
    },
    async execute(args, exec) {
      return await ctx.browser!.evaluate({ ...trustedContext(ctx, exec, "browser_evaluate"), ...parseEvaluateArgs(args) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_console",
    description: "Read bounded browser console entries for debugging.",
    parameters: {
      level: { type: "string", description: "Optional minimum level: error, warning, info, or debug." },
      limit: { type: "number", description: "Maximum entries (1..100)." },
    },
    output: {
      schema: logSchema(),
      render: (_args, value) => [{ type: "text", text: formatConsole(value as BrowserConsoleResult) }],
    },
    async execute(args, exec) {
      return await ctx.browser!.console({ ...trustedContext(ctx, exec, "browser_console"), ...parseListArgs(args, "browser_console") });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_network",
    description: "Read bounded page network request summaries for debugging.",
    parameters: { limit: { type: "number", description: "Maximum entries (1..100)." } },
    output: {
      schema: logSchema(),
      render: (_args, value) => [{ type: "text", text: formatNetwork(value as BrowserNetworkResult) }],
    },
    async execute(args, exec) {
      const parsed = parseListArgs(args, "browser_network");
      return await ctx.browser!.network({ ...trustedContext(ctx, exec, "browser_network"), ...(parsed.limit === undefined ? {} : { limit: parsed.limit }) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_screenshot",
    description: "Save a PNG screenshot inside the current session workspace.",
    parameters: {
      filename: { type: "string", description: "Optional relative .png filename without directory components." },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `截图已保存：${(value as { path: string }).path}` }],
    },
    async execute(args, exec) {
      return await ctx.browser!.screenshot({ ...trustedContext(ctx, exec, "browser_screenshot", true), ...parseScreenshotArgs(args) });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "browser_close",
    description: "Close the current user's browser and release its resources.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: { closed: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "浏览器已关闭" }],
    },
    async execute(_args, exec) {
      return await ctx.browser!.close(trustedContext(ctx, exec, "browser_close"));
    },
  })));

  return disposers;
}

function inputRecord(value: unknown, tool: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool}: invalid arguments`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  const result = boundedString(value, name, maximum).trim();
  if (!result) throw new Error(`${name} 必须为 1..${maximum} 字符`);
  return result;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${name} 必须是不超过 ${maximum} 字符的字符串`);
  return value;
}

function optionalBoundedString(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, name, maximum);
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} 必须为 ${minimum}..${maximum} 的安全整数`);
  }
  return Number(value);
}

function optionalConsoleLevel(value: unknown): BrowserConsoleLevel | undefined {
  if (value === undefined) return undefined;
  if (value !== "error" && value !== "warning" && value !== "info" && value !== "debug") {
    throw new Error("browser_console: level 必须为 error、warning、info 或 debug");
  }
  return value;
}

function boundedOutput(value: string): string {
  return value.length <= MODEL_TEXT_LIMIT ? value : `${value.slice(0, MODEL_TEXT_LIMIT)}\n…（输出已截断）`;
}

function formatSnapshot(value: BrowserSnapshot): string {
  return boundedOutput(`${value.title}\n${value.url}\n\n${value.content}${value.truncated ? "\n…（daemon 已截断）" : ""}`);
}

function formatConsole(value: BrowserConsoleResult): string {
  const text = value.entries.join("\n") || "（无控制台记录）";
  return boundedOutput(text + (value.truncated ? "\n…（其余记录已截断）" : ""));
}

function formatNetwork(value: BrowserNetworkResult): string {
  const text = value.entries.join("\n") || "（无网络记录）";
  return boundedOutput(text + (value.truncated ? "\n…（其余记录已截断）" : ""));
}

function pageSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: { url: { type: "string", required: true }, title: { type: "string", required: true } },
  } as const;
}

function pageOutput(prefix: string) {
  return {
    schema: pageSchema(),
    render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: `${prefix}：${(value as BrowserPage).title}\n${(value as BrowserPage).url}` }],
  };
}

function snapshotSchema() {
  return {
    ...pageSchema(),
    properties: { ...pageSchema().properties, content: { type: "string", required: true }, truncated: { type: "boolean", required: true } },
  } as const;
}

function logSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      entries: {
        type: "array", required: true, items: { type: "string" },
      },
      truncated: { type: "boolean", required: true },
    },
  } as const;
}
