/**
 * dsh-tool-cron 插件入口（SPEC cron.md §5）。
 *
 * 模型面 `cron_schedule` 工具：调度归一化在工具内完成——ISO 时刻或
 * 五字段 cron 表达式 + IANA 时区（Provider 校验兜底）；Scope 取自运行
 * 信封（agent → larkScopeIndex），模型参数不可提供 tenant/user/visibility。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { validateSchedule, type CronSchedule } from "dsh-lark-contracts";

export const name = "tool-cron";

export const inject = ["cron", "larkScopeIndex", "systemPrompt", "tools"];

export interface Config {
  /** 是否注册工具（默认 true）。 */
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
});

interface CronToolArgs {
  schedule: string;
  timezone?: string;
  task: string;
  endAt?: string;
}

/** 参数校验（schema DSL 之外的约束）。 */
function parseArgs(args: unknown): CronToolArgs {
  if (typeof args !== "object" || args === null) throw new Error("cron_schedule: invalid arguments");
  const record = args as Record<string, unknown>;
  const schedule = typeof record.schedule === "string" ? record.schedule.trim() : "";
  const task = typeof record.task === "string" ? record.task.trim() : "";
  const timezone = typeof record.timezone === "string" ? record.timezone.trim() : "";
  const endAt = typeof record.endAt === "string" ? record.endAt.trim() : "";
  if (!schedule || !task) throw new Error("cron_schedule: schedule and task are required");
  return {
    schedule,
    task,
    ...(timezone ? { timezone } : {}),
    ...(endAt ? { endAt } : {}),
  };
}

/** 归一化：ISO 时刻 → at；其余按五字段 cron 表达式。 */
export function normalizeSchedule(args: CronToolArgs): CronSchedule {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.schedule);
  if (iso) {
    if (args.timezone || args.endAt) throw new Error("cron_schedule: 一次性时刻不需要时区/endAt");
    return { kind: "at", at: args.schedule };
  }
  const timezone = args.timezone || "Asia/Shanghai";
  const schedule: CronSchedule = {
    kind: "cron",
    expression: args.schedule,
    timezone,
    ...(args.endAt ? { endAt: args.endAt } : {}),
  };
  validateSchedule(schedule);
  return schedule;
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;

  ctx.systemPrompt.section({
    name: "tool:cron_schedule",
    order: 110,
    text:
      "Use the cron_schedule tool to create recurring timed tasks for the user. "
      + "Schedule is an ISO instant or a 5-field cron expression with an IANA timezone; the task text runs later as a chat prompt.",
  });

  ctx.tools.register(defineTool({
    name: "cron_schedule",
    description: "Create a scheduled (one-time or recurring) task that will run in this conversation later.",
    parameters: {
      schedule: {
        type: "string",
        required: true,
        description: "ISO instant (e.g. 2026-08-20T09:00:00+08:00) or 5-field cron expression (e.g. 0 9 * * 1-5).",
      },
      timezone: { type: "string", description: "IANA timezone for cron expressions (default Asia/Shanghai)." },
      task: { type: "string", required: true, description: "The task prompt to run at schedule time." },
      endAt: { type: "string", description: "Optional inclusive end instant for recurring schedules (ISO)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          job: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              task: { type: "string", required: true },
              status: { type: "string", required: true },
              nextRunAt: { type: "string" },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: formatCronOutput(value),
      }],
    },
    async execute(args, exec) {
      const parsed = parseArgs(args);
      const schedule = normalizeSchedule(parsed);
      if (!exec.agent) throw new Error("cron_schedule requires an agent context");
      const scope = ctx.larkScopeIndex!.get(exec.agent.id);
      if (!scope) throw new Error("cron_schedule requires a lark run scope");
      const job = await ctx.cron!.create(scope, { task: parsed.task, schedule });
      return {
        job: {
          id: job.id,
          task: job.task,
          status: job.status,
          ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
        },
      };
    },
  }));
}

/** 工具返回值 → 模型文本。 */
export function formatCronOutput(value: unknown): string {
  const job = (typeof value === "object" && value !== null
    ? (value as { job?: { id?: unknown; task?: unknown; status?: unknown; nextRunAt?: unknown } }).job
    : undefined);
  if (!job || typeof job.id !== "string") return "cron_schedule: no job created.";
  return [
    `Scheduled task created (id: ${job.id}, status: ${String(job.status ?? "active")}).`,
    ...(typeof job.nextRunAt === "string" ? [`Next run: ${job.nextRunAt}.`] : []),
    `Task: ${String(job.task ?? "")}`,
  ].join("\n");
}
