/** 公共 Web/API 分享工具：Scope 和工作区只能来自可信运行上下文。 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { requireLarkRunScope } from "dsh-lark-contracts";
import type { PreviewDescriptor } from "dsh-preview";
import type {} from "dsh-preview";

export const name = "tool-preview";
export const inject = ["preview", "larkScopeIndex", "systemPrompt", "tools"];

export interface Config { enabled?: boolean }
export const Config: z<Config> = z.object({ enabled: z.boolean() });

interface PublishArgs { command: string; port: number; ttlMinutes?: number }

export function parsePublishArgs(value: unknown): PublishArgs {
  if (typeof value !== "object" || value === null) throw new Error("share_web: invalid arguments");
  const input = value as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const port = input.port;
  const ttlMinutes = input.ttl_minutes;
  if (!command || command.length > 4_000) throw new Error("share_web: command 必须为 1..4000 字符");
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("share_web: port 必须为 1..65535 的安全整数");
  }
  if (ttlMinutes !== undefined && (!Number.isSafeInteger(ttlMinutes) || Number(ttlMinutes) < 1 || Number(ttlMinutes) > 10_080)) {
    throw new Error("share_web: ttl_minutes 必须为 1..10080 的安全整数");
  }
  return { command, port: Number(port), ...(ttlMinutes === undefined ? {} : { ttlMinutes: Number(ttlMinutes) }) };
}

function requireContext(ctx: Context, exec: ToolRunContext, tool: string) {
  const scope = requireLarkRunScope(ctx, exec, tool);
  const workspace = exec.agent?.session.header.cwd;
  if (!workspace) throw new Error(`${tool} requires a session workspace`);
  return { scope, workspace };
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;
  ctx.effect(() => register(ctx), "tool-preview:register");
}

function register(ctx: Context): Array<() => void> {
  return [
    ctx.systemPrompt.section({
      name: "tool:preview",
      order: 116,
      text: "Use share_web after the user's Web or HTTP API is ready to run. The command runs in a separate network-disabled container; use share_list and share_revoke to manage public HTTPS shares.",
    }),
    ctx.tools.register(defineTool({
      name: "share_web",
      description: "Run a Web/API command from the current workspace in an isolated container and publish it at an HTTPS /share URL.",
      parameters: {
        command: { type: "string", required: true, description: "Command that starts the HTTP service and stays in the foreground." },
        port: { type: "number", required: true, description: "TCP port the app listens on inside the preview container." },
        ttl_minutes: { type: "number", description: "Share lifetime in minutes (default 60, maximum 10080)." },
      },
      output: {
        schema: previewDescriptorSchema(),
        render: (_args, value) => [{ type: "text", text: formatPreview(value as PreviewDescriptor) }],
      },
      async execute(args, exec) {
        const input = parsePublishArgs(args);
        const { scope, workspace } = requireContext(ctx, exec, "share_web");
        return await ctx.preview!.publish({ scope, workspace, ...input });
      },
    })),
    ctx.tools.register(defineTool({
      name: "share_list",
      description: "List the current user's active public Web/API shares.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            shares: { type: "array", required: true, items: previewDescriptorSchema() },
          },
        },
        render: (_args, value) => [{
          type: "text",
          text: (value as { shares: PreviewDescriptor[] }).shares.map(formatPreview).join("\n") || "（无有效分享）",
        }],
      },
      async execute(_args, exec) {
        const { scope } = requireContext(ctx, exec, "share_list");
        return { shares: [...await ctx.preview!.list(scope)] };
      },
    })),
    ctx.tools.register(defineTool({
      name: "share_revoke",
      description: "Permanently revoke one public Web/API share owned by the current user.",
      parameters: { id: { type: "string", required: true, description: "Share ID returned by share_web or share_list." } },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            revoked: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `分享 ${(value as { id: string }).id} 已撤销` }],
      },
      async execute(args, exec) {
        const id = typeof (args as { id?: unknown }).id === "string" ? (args as { id: string }).id.trim() : "";
        if (!id) throw new Error("share_revoke: id is required");
        const { scope } = requireContext(ctx, exec, "share_revoke");
        await ctx.preview!.revoke(scope, id);
        return { id, revoked: true };
      },
    })),
  ];
}

/** 供测试和 UI 文本稳定化使用。 */
export function formatPreview(descriptor: PreviewDescriptor): string {
  return `${descriptor.url}（有效至 ${descriptor.expiresAt}）`;
}

function previewDescriptorSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      url: { type: "string", required: true },
      createdAt: { type: "string", required: true },
      expiresAt: { type: "string", required: true },
      port: { type: "number", required: true },
    },
  } as const;
}
