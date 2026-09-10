/**
 * dsh-tool-image 插件入口（SPEC image.md §5）：generate_image 模型工具。
 * Scope 取自运行信封（larkScopeIndex）；产物写工作区顶层，随 R-06 收集
 * 产生 📎 产物行。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { requireLarkRunScope } from "dsh-lark-contracts";
import type {} from "dsh-lark-image";

export const name = "tool-image";

export const inject = ["larkImage", "larkScopeIndex", "systemPrompt", "tools"];

export interface Config {
  /** 是否注册工具（默认 true）。 */
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
});

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;
  ctx.effect(() => registerImageTool(ctx), "tool-image:register");
}

/** 返回注册 disposer，由 apply 的 Cordis effect 承载。 */
function registerImageTool(ctx: Context): Array<() => void> {
  return [
    ctx.systemPrompt.section({
      name: "tool:generate_image",
      order: 115,
      text:
        "Use generate_image to create or edit images for the user. For multiple references, first confirm the role mapping "
        + "with the user (for example: 图1 is the person and 图2 is the style), put the primary composition image first, "
        + "and refer to each image as 图N in the prompt. Uploaded images and generated-*.png files can be reused across "
        + "turns in the same workspace as canonical references. The generated PNG is delivered automatically.",
    }),
    ctx.tools.register(defineTool({
    name: "generate_image",
    description: "Generate or edit an image. For multiple references (default max 8), put the main image first and map roles with 图1..图N.",
    parameters: {
      prompt: { type: "string", required: true, description: "What to draw or how to edit (max 4000 chars)." },
      reference_paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional workspace-relative references (default max 8), ordered as 图1..图N; generated-*.png can be reused.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          bytes: { type: "number", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `图片已生成：${(value as { path: string }).path}（${(value as { bytes: number }).bytes} 字节）`,
      }],
    },
    async execute(args, exec) {
      const input = args as { prompt: string; reference_paths?: string[] };
      const prompt = input.prompt;
      const references = input.reference_paths?.length ? input.reference_paths : undefined;
      const scope = requireLarkRunScope(ctx, exec, "generate_image");
      const workspace = exec.agent?.session.header.cwd;
      return await ctx.larkImage!.generate({
        scope,
        prompt,
        ...(workspace ? { workspace } : {}),
        ...(references ? { references } : {}),
      });
    },
    })),
  ];
}
