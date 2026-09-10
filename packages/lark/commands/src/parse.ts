/**
 * 斜杠命令解析（纯函数）。
 *
 * 命令是不可信输入：仅识别 `/name`（小写字母数字与 - _）+ 可选原文参数；
 * 其余形态（空斜杠、双斜杠、纯文本）返回 undefined。
 */
import type { ParsedGatewayCommand } from "./index.js";

const COMMAND_LINE = /^\/([a-z0-9_-]+)(?:\s+(.*))?$/i;

/** 解析斜杠命令；非命令文本返回 undefined。 */
export function parseGatewayCommand(text: string): ParsedGatewayCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = COMMAND_LINE.exec(trimmed);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}
