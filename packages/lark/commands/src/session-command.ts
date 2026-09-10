import {
  isSessionClaimCode,
  parseSessionId,
  type SessionDirectoryCurrent,
  type SessionDirectoryEntry,
  type SessionDirectoryRequest,
} from "dsh-lark-contracts";
import { RunClientError, type LarkRunClient } from "dsh-lark-run-client";

import { renderSession } from "./command-card.js";
import type { CommandCardAction, GatewayCommandResult } from "./index.js";

const SESSION_LIST_PAGE_SIZE = 10;
const SESSION_CARD_ACTIONS = 5;

export const SESSION_USAGE = [
  "**会话管理用法**",
  "- `/session` 或 `/session current` - 当前会话",
  "- `/session list` - 可接续的 Web 会话",
  "- `/session use <序号>` - 切换会话",
  "- `/session claim <分享码>` - 接续 Web 会话",
  "- `/session new` - 使用当前飞书会话",
  "- `/session unlink` - 解除当前 Web 会话绑定",
].join("\n");

interface SessionCommandInput extends SessionDirectoryRequest {
  args: string;
}

function navigationActions(mode?: SessionDirectoryCurrent["mode"]): CommandCardAction[] {
  return [
    { label: "当前会话", command: "/session current", group: "session" },
    { label: "会话列表", command: "/session list", group: "session" },
    { label: "使用飞书会话", command: "/session new", group: "session" },
    ...(mode === "shared"
      ? [{ label: "解除绑定", command: "/session unlink", style: "danger", group: "danger", layout: "stack", confirm: "解除后不会删除 Web 会话记录。" } satisfies CommandCardAction]
      : []),
  ];
}

function renderSessionList(entries: SessionDirectoryEntry[]): string {
  if (entries.length === 0) {
    return "尚未授权可接续的 Web 会话。请先在 Web 会话中执行 `/lark-share`。";
  }
  const lines = entries.slice(0, SESSION_LIST_PAGE_SIZE).map((entry, index) => {
    const state = entry.selected ? "当前" : "可切换";
    return `${index + 1}. ${state} · 最近使用 ${entry.lastUsedAt}`;
  });
  const overflow = entries.length > SESSION_LIST_PAGE_SIZE
    ? [`...及另外 ${entries.length - SESSION_LIST_PAGE_SIZE} 个会话`] : [];
  return ["**可接续会话**", ...lines, ...overflow].join("\n");
}

function listActions(entries: SessionDirectoryEntry[]): CommandCardAction[] {
  return [
    ...entries.slice(0, SESSION_CARD_ACTIONS).map((entry, index) => ({
      label: `切换到 ${index + 1}`,
      command: `/session use-id ${entry.sessionId}`,
      style: entries[index]!.selected ? "primary" : "default",
      group: "sessions",
    } satisfies CommandCardAction)),
    ...navigationActions(entries.some((entry) => entry.selected) ? "shared" : "deterministic"),
  ];
}

async function current(client: LarkRunClient, input: SessionDirectoryRequest): Promise<GatewayCommandResult> {
  const [target, overview] = await Promise.all([
    client.sessionCurrent(input),
    client.sessionOverview(input),
  ]);
  const source = target.mode === "shared" ? "Web 共享会话" : "飞书会话";
  return {
    markdown: `**当前会话：${source}**\n\n${renderSession(overview)}`,
    actions: navigationActions(target.mode),
  };
}

async function list(client: LarkRunClient, input: SessionDirectoryRequest): Promise<GatewayCommandResult> {
  const result = await client.sessionList(input);
  return { markdown: renderSessionList(result.sessions), actions: listActions(result.sessions) };
}

async function use(client: LarkRunClient, input: SessionDirectoryRequest, indexText: string): Promise<GatewayCommandResult> {
  if (!/^[1-9]\d*$/.test(indexText)) return { markdown: SESSION_USAGE, actions: navigationActions() };
  const index = Number(indexText);
  if (!Number.isSafeInteger(index)) return { markdown: SESSION_USAGE, actions: navigationActions() };
  const result = await client.sessionList(input);
  const entry = result.sessions[index - 1];
  if (!entry) return { markdown: `会话序号不存在。\n\n${SESSION_USAGE}`, actions: listActions(result.sessions) };
  await client.sessionUse({ ...input, sessionId: entry.sessionId });
  return { markdown: `已切换到会话 ${index}。后续消息将接续其历史。`, actions: navigationActions("shared") };
}

async function useId(client: LarkRunClient, input: SessionDirectoryRequest, sessionIdText: string): Promise<GatewayCommandResult> {
  const sessionId = parseSessionId(sessionIdText);
  if (!sessionId.ok) return { markdown: SESSION_USAGE, actions: navigationActions() };
  await client.sessionUse({ ...input, sessionId: sessionId.value });
  return { markdown: "已切换到所选 Web 会话。后续消息将接续其历史。", actions: navigationActions("shared") };
}

async function mutate(
  client: LarkRunClient,
  input: SessionDirectoryRequest,
  action: "new" | "unlink",
): Promise<GatewayCommandResult> {
  if (action === "new") {
    await client.sessionNew(input);
    return { markdown: "已切换到当前飞书会话。Web 会话绑定仍保留，可从列表重新接续。", actions: navigationActions() };
  }
  await client.sessionUnlink(input);
  return { markdown: "已解除当前 Web 会话绑定；会话记录未删除。", actions: navigationActions() };
}

async function execute(client: LarkRunClient, input: SessionCommandInput): Promise<GatewayCommandResult> {
  const parts = input.args.length > 0 ? input.args.split(/\s+/) : [];
  const [command, argument] = parts;
  const request = { scope: input.scope, sessionGeneration: input.sessionGeneration };
  if (!command || command === "current") {
    return parts.length <= 1 ? current(client, request) : { markdown: SESSION_USAGE, actions: navigationActions() };
  }
  if (command === "list") {
    return parts.length === 1 ? list(client, request) : { markdown: SESSION_USAGE, actions: navigationActions() };
  }
  if (command === "use") {
    return parts.length === 2 ? use(client, request, argument!) : { markdown: SESSION_USAGE, actions: navigationActions() };
  }
  if (command === "use-id") {
    return parts.length === 2 ? useId(client, request, argument!) : { markdown: SESSION_USAGE, actions: navigationActions() };
  }
  if (command === "claim") {
    if (parts.length !== 2 || !isSessionClaimCode(argument)) return { markdown: SESSION_USAGE, actions: navigationActions() };
    await client.sessionClaim({ ...request, code: argument });
    return { markdown: "已接续 Web 会话。后续消息将共享同一历史与模型设置。", actions: navigationActions("shared") };
  }
  if (command === "new" || command === "unlink") {
    return parts.length === 1 ? mutate(client, request, command) : { markdown: SESSION_USAGE, actions: navigationActions() };
  }
  return { markdown: SESSION_USAGE, actions: navigationActions() };
}

export async function handleSessionCommand(
  client: LarkRunClient,
  input: SessionCommandInput,
): Promise<GatewayCommandResult> {
  try {
    return await execute(client, input);
  } catch (error) {
    const claim = input.args.startsWith("claim ");
    const invalidClaim = claim && error instanceof RunClientError && error.status === 400;
    return {
      markdown: invalidClaim ? "分享码无效或已过期，请在 Web 会话中重新生成。" : "会话管理暂不可用，请稍后重试。",
      actions: claim ? [] : navigationActions(),
    };
  }
}
