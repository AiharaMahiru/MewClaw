import type { CronJob, RunProfile, SessionOverview } from "dsh-lark-contracts";

import type { CommandCardAction } from "./index.js";

const TODO_MARKS = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
const CRON_PAGE_SIZE = 10;
const CARD_JOB_ACTIONS = 3;
const CRON_STATUS_LABEL = { active: "进行中", paused: "已暂停", completed: "已完成" } as const;

export const HELP_MARKDOWN = [
  "**命令中心**",
  "选择下方操作，或直接输入命令：",
  "- `/login` — 生成 Web 配对链接并接续当前飞书会话",
  "- `/clear` — 开启新的飞书会话代次",
  "- `/runtime` — 查看或调整运行档位",
  "- `/session` — 管理 Web / 飞书会话",
  "- `/todo` — 查看当前会话任务",
  "- `/cron` — 管理定时任务",
].join("\n");

export const CRON_USAGE = [
  "**定时任务用法**",
  "- `/cron` 或 `/cron list` — 任务列表",
  "- `/cron <jobId>` — 任务详情",
  "- `/cron pause|resume|delete <jobId>` — 控制任务",
  "新建或改写调度请直接用自然语言描述。",
].join("\n");

export interface CronListResponse {
  jobs: CronJob[];
  runs: Array<{ runId: string; status: string; scheduledFor: string }>;
}

export function renderTodo(overview: SessionOverview): string {
  if (!overview.exists) return "当前会话尚无持久化记录。";
  if (overview.todos.length === 0) return "**当前 TODO**\n\n暂无任务。";
  return ["**当前 TODO**", ...overview.todos.map((todo) => `${TODO_MARKS[todo.status]} ${todo.content}`)].join("\n");
}

export function renderSession(overview: SessionOverview): string {
  if (!overview.exists) return "当前会话尚无持久化记录。";
  const { usage } = overview;
  return [
    "**当前会话**",
    `- 运行次数：${usage.runs}`,
    `- 模型调用：${usage.modelCalls}`,
    `- 输入 token：${usage.inputTokens}`,
    `- 输出 token：${usage.outputTokens}`,
    `- 缓存读取 / 写入：${usage.cacheReadTokens} / ${usage.cacheWriteTokens}`,
    `- 推理 token：${usage.reasoningTokens}`,
    ...(overview.lastActivityAt ? [`- 最近活动：${overview.lastActivityAt}`] : []),
  ].join("\n");
}

export function renderCronJob(job: CronJob): string {
  return [
    `**定时任务** \`${job.id}\``,
    `- 任务：${job.task}`,
    `- 状态：${CRON_STATUS_LABEL[job.status]}`,
    `- 调度：${scheduleText(job)}`,
    ...(job.nextRunAt ? [`- 下次：${job.nextRunAt}`] : []),
    ...(job.lastRunAt ? [`- 上次：${job.lastRunAt}`] : []),
  ].join("\n");
}

export function renderCronList(jobs: CronJob[], runs: CronListResponse["runs"]): string {
  if (jobs.length === 0) return "暂无定时任务。新建请直接用自然语言描述。";
  const lines = jobs.slice(0, CRON_PAGE_SIZE).map((job) => {
    const task = job.task.length > 40 ? `${job.task.slice(0, 40)}…` : job.task;
    const next = job.nextRunAt ? `→ ${job.nextRunAt}` : "无下次执行";
    return `- \`${job.id.slice(0, 8)}\` ${CRON_STATUS_LABEL[job.status]} ${task}（${next}）`;
  });
  const overflow = jobs.length > CRON_PAGE_SIZE ? [`…及另外 ${jobs.length - CRON_PAGE_SIZE} 个任务`] : [];
  const recent = runs.length > 0
    ? ["", `最近执行：${runs.slice(0, 3).map((run) => `${run.status === "completed" ? "成功" : "失败"} ${run.scheduledFor}`).join("、")}`]
    : [];
  return ["**定时任务**", ...lines, ...overflow, ...recent].join("\n");
}

export function helpActions(): CommandCardAction[] {
  return [
    { label: "Web 配对登录", command: "/login", style: "primary", group: "auth" },
    { label: "会话概览", command: "/session", group: "session" },
    { label: "查看 TODO", command: "/todo", group: "session" },
    { label: "运行档位", command: "/runtime", group: "session" },
    { label: "定时任务", command: "/cron", group: "cron" },
    { label: "开启新会话", command: "/clear", style: "danger", group: "danger", layout: "stack", confirm: "将开启新会话，当前会话会保留。" },
  ];
}

export function runtimeActions(active: RunProfile): CommandCardAction[] {
  const profiles: RunProfile[] = ["quick", "standard", "long"];
  return [
    ...profiles.map((profile) => ({
      label: profile,
      command: `/runtime ${profile}`,
      style: profile === active ? "primary" : "default",
      group: "profiles",
    } satisfies CommandCardAction)),
    { label: "会话概览", command: "/session", group: "overview" },
  ];
}

export function overviewActions(): CommandCardAction[] {
  return [
    { label: "会话概览", command: "/session", group: "overview" },
    { label: "查看 TODO", command: "/todo", group: "overview" },
    { label: "运行档位", command: "/runtime", group: "overview" },
  ];
}

export function cronListActions(jobs: CronJob[]): CommandCardAction[] {
  return [
    { label: "刷新任务", command: "/cron", group: "overview" },
    ...jobs.slice(0, CARD_JOB_ACTIONS).map((job) => ({
      label: `查看 ${job.id.slice(0, 8)}`,
      command: `/cron ${job.id}`,
      group: "jobs",
    })),
    { label: "查看用法", command: "/cron help", group: "overview" },
  ];
}

export function cronJobActions(job: CronJob): CommandCardAction[] {
  const actions: CommandCardAction[] = [{ label: "返回列表", command: "/cron", group: "overview" }];
  if (job.status === "active") actions.push({ label: "暂停", command: `/cron pause ${job.id}`, group: "control" });
  if (job.status === "paused") actions.push({ label: "恢复", command: `/cron resume ${job.id}`, style: "primary", group: "control" });
  actions.push({ label: "删除", command: `/cron delete ${job.id}`, style: "danger", group: "danger", layout: "stack", confirm: "删除后无法恢复此定时任务。" });
  return actions;
}

function scheduleText(job: CronJob): string {
  if (job.schedule.kind === "at") return `一次性 ${job.schedule.at}`;
  return `每 ${job.schedule.expression}（${job.schedule.timezone}${job.schedule.endAt ? `，至 ${job.schedule.endAt}` : ""}）`;
}
