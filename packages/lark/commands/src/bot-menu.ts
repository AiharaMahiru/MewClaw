import type { ParsedGatewayCommand } from "./index.js";
import { parseGatewayCommand } from "./parse.js";

const BOT_MENU_COMMANDS = new Map<string, string>([
  ["help", "/help"],
  ["session", "/session"],
  ["new", "/clear"],
  ["cron", "/cron"],
  ["preset", "/runtime"],
  ["clear", "/clear"],
  ["runtime", "/runtime"],
  ["todo", "/todo"],
  ["handoff", "/handoff"],
]);

/** 把飞书机器人菜单 eventKey 解析为现有确定性命令。 */
export function resolveBotMenuCommand(eventKey: string): ParsedGatewayCommand | undefined {
  const commandText = BOT_MENU_COMMANDS.get(eventKey);
  return commandText ? parseGatewayCommand(commandText) : undefined;
}
