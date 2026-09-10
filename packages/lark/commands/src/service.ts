import type { Context } from "@deepseek-ai/cordis";
import { deterministicSessionIdForScope, parseJobId, scopeKey, type CronJob, type JobId, type RunProfile, type Scope } from "dsh-lark-contracts";
import type { LarkRunClient } from "dsh-lark-run-client";

import type { CardActionRegistry } from "./card-actions.js";
import { resolveBotMenuCommand } from "./bot-menu.js";
import {
  CRON_USAGE,
  HELP_MARKDOWN,
  cronJobActions,
  cronListActions,
  helpActions,
  overviewActions,
  renderCronJob,
  renderCronList,
  renderSession,
  renderTodo,
  runtimeActions,
  type CronListResponse,
} from "./command-card.js";
import type {
  CommandCardAction,
  GatewayCardActionInput,
  GatewayCommandInput,
  GatewayCommandResult,
  LarkCommandsService,
  ParsedGatewayCommand,
} from "./index.js";
import { parseGatewayCommand } from "./parse.js";
import { PairingClientError, type FeishuPairingBinding, type FeishuPairingClient } from "./pairing.js";
import { handleSessionCommand } from "./session-command.js";

const RUN_PROFILES = new Set(["quick", "standard", "long"]);

interface CommandServiceOptions {
  ctx: Context;
  runClient: LarkRunClient;
  defaultProfile: RunProfile;
  cardActions: CardActionRegistry;
  pairingClient?: FeishuPairingClient | undefined;
  pairingUnavailableMessage?: string | undefined;
}

type ScopedCommandInput = Pick<GatewayCommandInput, "scope" | "chatId" | "sessionGeneration">;

export class GatewayCommands implements LarkCommandsService {
  readonly #profiles = new Map<string, RunProfile>();

  constructor(private readonly options: CommandServiceOptions) {}

  parse(text: string): ParsedGatewayCommand | undefined {
    return parseGatewayCommand(text);
  }

  resolveBotMenu(eventKey: string): ParsedGatewayCommand | undefined {
    return resolveBotMenuCommand(eventKey);
  }

  getProfile(scope: Scope): RunProfile {
    return this.#profiles.get(scopeKey(scope)) ?? this.options.defaultProfile;
  }

  async handle(input: GatewayCommandInput): Promise<GatewayCommandResult | undefined> {
    return this.#execute(input, input.command);
  }

  async handleCardAction(input: GatewayCardActionInput): Promise<GatewayCommandResult> {
    const commandText = this.options.cardActions.consume(input.scope, input.actionId);
    if (!commandText) return this.#expired(input);
    const command = parseGatewayCommand(commandText);
    if (!command) return this.#expired(input);
    return (await this.#execute(input, command)) ?? this.#expired(input);
  }

  async #execute(
    input: ScopedCommandInput,
    command: ParsedGatewayCommand,
  ): Promise<GatewayCommandResult | undefined> {
    switch (command.name) {
      case "help": return this.#reply(input, HELP_MARKDOWN, helpActions());
      case "clear": return this.#clear(input);
      case "handoff": return this.#handoff(input);
      case "runtime": return this.#runtime(input, command.args);
      case "todo": return this.#overview(input, "todo");
      case "session": return this.#session(input, command.args);
      case "cron": return this.#cron(input, command.args);
      case "login": return this.#login(input);
      default: return undefined;
    }
  }

  #reply(
    input: Pick<ScopedCommandInput, "scope">,
    markdown: string,
    actions: readonly CommandCardAction[] = [],
  ): GatewayCommandResult {
    if (actions.length === 0) return { markdown };
    return {
      markdown,
      actions: actions.map((action) => ({
        ...action,
        actionId: this.options.cardActions.register(input.scope, action.command),
      })),
    };
  }

  #clear(input: ScopedCommandInput): GatewayCommandResult {
    this.options.ctx.emit("lark/command/clear-session", { scope: input.scope, chatId: input.chatId });
    return this.#reply(input, "已开启新会话。旧会话保留，可继续查询历史。", [{ label: "打开命令中心", command: "/help", style: "primary" }]);
  }

  async #login(input: ScopedCommandInput): Promise<GatewayCommandResult> {
    if (!this.options.pairingClient) return this.#reply(input, this.options.pairingUnavailableMessage ?? "Web 配对登录尚未配置，请联系管理员。");
    try {
      const sessionId = deterministicSessionIdForScope(input.scope, input.sessionGeneration ?? 0);
      const pairing = await this.options.pairingClient.issue(input.scope.userId, sessionId);
      return this.#reply(input, renderPairingCard(pairing.url, pairing.binding));
    } catch (error) {
      this.#warnPairing(error);
      const message = error instanceof PairingClientError && error.code === "PAIRING_NOT_CONFIGURED"
        ? "Web 配对登录暂不可用：服务端配对凭证尚未配置。"
        : "Web 配对链接生成失败，请稍后重试。";
      return this.#reply(input, message);
    }
  }

  #handoff(input: ScopedCommandInput): GatewayCommandResult {
    const { scope } = input;
    return this.#reply(input, [
      "**会话归属**",
      `- 会话：${scope.conversationId}`,
      `- 用户：${scope.userId}`,
      `- 部署：${scope.deploymentId}`,
      "此命令仅显示归属，不会创建交接任务；如需人工接管，请联系部署管理员。",
    ].join("\n"), overviewActions());
  }

  #runtime(input: ScopedCommandInput, args: string): GatewayCommandResult {
    const current = this.getProfile(input.scope);
    if (args.length === 0) {
      return this.#reply(input, `当前运行档位：\`${current}\`。请选择下方档位。`, runtimeActions(current));
    }
    if (!RUN_PROFILES.has(args)) {
      return this.#reply(input, "用法：`/runtime [quick|standard|long]`", runtimeActions(current));
    }
    const profile = args as RunProfile;
    this.#profiles.set(scopeKey(input.scope), profile);
    return this.#reply(input, `运行档位已设为 \`${profile}\`。`, runtimeActions(profile));
  }

  async #overview(input: ScopedCommandInput, kind: "todo" | "session"): Promise<GatewayCommandResult> {
    try {
      const overview = await this.options.runClient.sessionOverview({
        scope: input.scope,
        sessionGeneration: input.sessionGeneration ?? 0,
      });
      const markdown = kind === "todo" ? renderTodo(overview) : renderSession(overview);
      return this.#reply(input, markdown, overviewActions());
    } catch {
      return this.#reply(input, "会话视图暂不可用，请稍后重试。", [{ label: "重试", command: `/${kind}`, style: "primary" }]);
    }
  }

  async #session(input: ScopedCommandInput, args: string): Promise<GatewayCommandResult> {
    const result = await handleSessionCommand(this.options.runClient, {
      scope: input.scope,
      sessionGeneration: input.sessionGeneration ?? 0,
      args,
    });
    return this.#reply(input, result.markdown, result.actions);
  }

  async #cron(input: ScopedCommandInput, args: string): Promise<GatewayCommandResult> {
    const parts = args.length > 0 ? args.split(/\s+/) : [];
    const [first, second] = parts;
    let kind: "list" | "get" | "stop" | "start" | "delete";
    let jobId: string | undefined;
    if (first === "help") {
      if (parts.length !== 1) return this.#cronUsage(input);
      return this.#reply(input, CRON_USAGE, [{ label: "查看任务", command: "/cron", style: "primary" }]);
    }
    if (!first || first === "list") {
      if ((first && parts.length !== 1) || (!first && parts.length !== 0)) return this.#cronUsage(input);
      kind = "list";
    }
    else if (first === "pause" || first === "resume" || first === "delete" || first === "get") {
      if (parts.length !== 2) return this.#cronUsage(input);
      kind = first === "pause" ? "stop" : first === "resume" ? "start" : first;
      jobId = second;
    } else {
      if (parts.length !== 1) return this.#cronUsage(input);
      kind = "get";
      jobId = first;
    }
    if (kind !== "list") {
      const parsed = parseJobId(jobId);
      if (!parsed.ok) return this.#cronUsage(input);
      return this.#cronAction(input, kind, parsed.value);
    }
    try {
      const result = await this.options.runClient.cronControl({ kind: "list", scope: input.scope }) as CronListResponse;
      return this.#reply(input, renderCronList(result.jobs, result.runs), cronListActions(result.jobs));
    } catch (error) {
      this.#warnCron(error);
      return this.#reply(input, "cron 管理暂不可用，请稍后重试。", [{ label: "重试", command: "/cron", style: "primary" }]);
    }
  }

  #cronUsage(input: ScopedCommandInput): GatewayCommandResult {
    return this.#reply(input, CRON_USAGE, [{ label: "查看任务", command: "/cron", style: "primary" }]);
  }

  async #cronAction(
    input: ScopedCommandInput,
    kind: "get" | "stop" | "start" | "delete",
    jobId: JobId,
  ): Promise<GatewayCommandResult> {
    try {
      const control = this.options.runClient.cronControl.bind(this.options.runClient);
      if (kind === "delete") {
        const result = await control({ kind: "delete", scope: input.scope, jobId }) as { removed: boolean };
        const markdown = result.removed ? "定时任务已删除。" : "任务不存在（可能已被删除）。";
        return this.#reply(input, markdown, [{ label: "查看任务", command: "/cron", style: "primary" }]);
      }
      const job = await control({ kind, scope: input.scope, jobId }) as CronJob | undefined;
      if (!job) return this.#reply(input, "任务不存在（可能已被删除）。", [{ label: "查看任务", command: "/cron", style: "primary" }]);
      const heading = kind === "get" ? "" : `任务已${kind === "stop" ? "暂停" : "恢复"}：\n\n`;
      return this.#reply(input, `${heading}${renderCronJob(job)}`, cronJobActions(job));
    } catch (error) {
      this.#warnCron(error);
      return this.#reply(input, "cron 管理暂不可用，请稍后重试。", [{ label: "重试", command: "/cron", style: "primary" }]);
    }
  }

  #expired(input: GatewayCardActionInput): GatewayCommandResult {
    return this.#reply(input, "该卡片操作已过期或无效，请重新输入 `/help`。", [{ label: "打开命令中心", command: "/help", style: "primary" }]);
  }

  #warnCron(error: unknown): void {
    const reason = error instanceof Error ? error.message : "unknown";
    this.options.ctx.logger.warn(`lark-commands: cron 控制失败（${reason}）`);
  }

  #warnPairing(error: unknown): void {
    const code = error instanceof PairingClientError ? error.code : "PAIRING_UNAVAILABLE";
    this.options.ctx.logger.warn(`lark-commands: Web 配对失败（${code}）`);
  }
}

function renderPairingCard(url: string, binding: FeishuPairingBinding): string {
  const state = binding.status === "bound"
    ? [
      "**当前绑定状态：已绑定**",
      `此飞书账户已绑定 Web 账户：${cardCode(binding.displayName)}（${cardCode(binding.email)}）。`,
      "如果当前浏览器登录的是其他 Web 账户，请在配对页选择“切换到已绑定 Web 账户”。",
    ]
    : [
      "**当前绑定状态：未绑定**",
      "此飞书账户尚未绑定 Web 账户。打开链接后可登录已有账户，或注册并验证邮箱完成绑定。",
    ];
  return [
    "**Web 配对登录**",
    ...state,
    `[打开 MewClaw Web](${url})`,
    "链接约 5 分钟有效且只能使用一次。",
  ].join("\n");
}

function cardCode(value: string): string {
  return ["`", value.replace(/[\r\n`]/g, " ").slice(0, 160), "`"].join("");
}

export function resolveDefaultProfile(input: string | undefined): RunProfile {
  return input && RUN_PROFILES.has(input) ? input as RunProfile : "standard";
}
