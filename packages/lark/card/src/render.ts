/**
 * 卡片渲染纯函数（SPEC lark-card.md §1/§6）。
 *
 * 展示规则（继承 lark-claw）：隐藏推理、原始密钥、模型思考内容永不上卡——
 * 白名单化事件字段，非白名单字段丢弃。所有函数纯、无 IO、无状态；
 * 节流与投递策略在插件层（throttle/index），渲染函数只做事件 → 文本变换。
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** 一次卡片更新（M1 文本面；交互卡归 lark-approval）。 */
export type CardUpdate =
  | { kind: "processing" }
  | { kind: "append"; text: string }
  | { kind: "tool-line"; name: string; durationMs?: number }
  | { kind: "artifact-line"; name: string; bytes: number }
  | { kind: "final"; text: string; stats: string }
  | { kind: "failure"; code: string; hint: string };

/**
 * 提取 assistant 消息中的白名单文本：只取 type === "text" 的块；
 * reasoning/redacted 等块一律丢弃（隐藏推理永不上卡）。
 */
export function assistantText(event: SessionEvent): string {
  if (event.type !== "assistant/message") return "";
  const parts: string[] = [];
  for (const block of event.data.message.content) {
    if (block.type === "text" && block.text.length > 0) parts.push(block.text);
  }
  return parts.join("");
}

/** 工具折叠行：`工具名 · 时长`；无时长（进行中）只显示工具名。 */
export function toolLine(name: string, durationMs?: number): string {
  const duration = durationMs === undefined ? "" : ` · ${(durationMs / 1000).toFixed(1)}s`;
  return `\`${name}\`${duration}`;
}

/** 产物行：文件名 + 字节数（M1 仅文本行；下载入口 M3）。 */
export function artifactLine(name: string, bytes: number): string {
  return `📎 ${name}（${bytes} 字节）`;
}

/** 工具折叠行截断：超上限折叠为计数行。 */
export function collapseToolLines(lines: string[], maxToolLines: number): string[] {
  if (lines.length <= maxToolLines) return lines;
  return [...lines.slice(0, maxToolLines - 1), `…及另外 ${lines.length - maxToolLines + 1} 个工具`];
}
