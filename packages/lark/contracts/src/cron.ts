/**
 * cron 能力缝 Definition（SPEC cron.md §2；R-15 契约分离）：调度/任务/
 * 执行历史/投递类型 + 服务接口 + 调度校验（什么算合法调度属契约面）。
 * 执行期计算（nextOccurrence/initialNextRunAt）与存储在 Provider dsh-lark-cron。
 */
import { CronExpressionParser } from "cron-parser";

import type { Scope } from "./scope.js";

/** 调度：一次性 ISO 时刻 或 五字段 cron 表达式（IANA 时区，可选 endAt 含端点）。 */
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "cron"; expression: string; timezone: string; endAt?: string };

export type CronJobStatus = "active" | "paused" | "completed";
export type CronJobFilter = "all" | CronJobStatus;
export type CronRunStatus = "completed" | "failed";

export interface CronJob {
  id: string;
  scope: Scope;
  task: string;
  schedule: CronSchedule;
  status: CronJobStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronRun {
  runId: string;
  jobId: string;
  status: CronRunStatus;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string;
  output: string;
  error?: string;
}

/** 领取的到期任务（含租约令牌；complete 时必须回传以校验租约未丢）。 */
export interface ClaimedCronJob extends Omit<CronJob, "nextRunAt"> {
  nextRunAt: string;
  leaseToken: string;
}

export interface CreateCronJobInput {
  /** 任务文本（进入模型运行前按提示注入规则处理——不可信证据）。 */
  task: string;
  schedule: CronSchedule;
}

export interface UpdateCronJobInput {
  task?: string;
  schedule?: CronSchedule;
}

export interface CronListFilter {
  filter?: CronJobFilter;
  limit?: number;
}

export interface CronRunOutcome {
  status: CronRunStatus;
  output: string;
  error?: string;
}

export interface PendingCronDelivery extends CronRun {
  deliveryToken: string;
  scope: Scope;
  task: string;
}

export interface CronService {
  /** 创建（调度归一化在 Provider 内完成；非法输入 fail loud）。 */
  create(scope: Scope, input: CreateCronJobInput): Promise<CronJob>;
  /** 更新任务/调度（同一 SQL 重算 nextRunAt 并清租约）。 */
  update(scope: Scope, jobId: string, input: UpdateCronJobInput): Promise<CronJob | undefined>;
  pause(scope: Scope, jobId: string): Promise<CronJob | undefined>;
  resume(scope: Scope, jobId: string): Promise<CronJob | undefined>;
  remove(scope: Scope, jobId: string): Promise<boolean>;
  list(scope: Scope, filter: CronListFilter): Promise<CronJob[]>;
  listRuns(scope: Scope, limit: number): Promise<CronRun[]>;
  get(scope: Scope, jobId: string): Promise<CronJob | undefined>;
  /** worker 内部：SKIP LOCKED 领取到期任务（租约）。 */
  claimDue(now: Date, limit: number): Promise<ClaimedCronJob[]>;
  /** worker 内部：租约心跳续期。 */
  renewLease(jobId: string, leaseToken: string, now: Date): Promise<boolean>;
  /** worker 内部：运行结束 → 执行历史 + 下次调度（无下次 → completed）。 */
  complete(claim: ClaimedCronJob, runId: string, outcome: CronRunOutcome, finishedAt: Date): Promise<void>;
  /** 投递 outbox（网关侧认领/确认，send-before-ack）。 */
  claimDeliveries(input: { tenantId: string; botId: string; deploymentId: string; userIds: string[]; now: Date; limit: number }): Promise<PendingCronDelivery[]>;
  ackDelivery(runId: string, deliveryToken: string, deliveredAt: Date): Promise<boolean>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 跨会话 cron 能力缝（worker 宿主面；Definition 在 dsh-lark-contracts）。 */
    cron?: CronService;
  }
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
const MILLIS_PER_MINUTE = 60_000;

/** 严格解析一次性 ISO 时刻（字段范围 + 偏移一致性双校验）。 */
export function parseOneTimeInstant(at: string): Date {
  const match = ISO_INSTANT.exec(at);
  if (!match) throw new Error("一次性调度格式非法");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const milliseconds = Number((match[7] || "").slice(0, 3).padEnd(3, "0"));
  const zone = match[8]!;
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const valid = year! >= 1_000 && month! >= 1 && month! <= 12
    && day! >= 1 && day! <= daysInMonth && hour! <= 23 && minute! <= 59
    && second! <= 59 && offsetHour <= 23 && offsetMinute <= 59;
  if (!valid) throw new Error("一次性调度格式非法");
  const sign = zone.startsWith("-") ? -1 : 1;
  const offset = sign * ((offsetHour * 60) + offsetMinute);
  const expected = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, milliseconds)
    - (offset * MILLIS_PER_MINUTE);
  const instant = new Date(at);
  if (instant.getTime() !== expected) throw new Error("一次性调度格式非法");
  return instant;
}

/** 归一化校验（工具/控制面入口共用）：非法调度 fail loud。 */
export function validateSchedule(schedule: CronSchedule): void {
  if (schedule.kind === "at") {
    parseOneTimeInstant(schedule.at);
    return;
  }
  if (!schedule.timezone || schedule.timezone.trim().length === 0) {
    throw new Error("cron 调度缺少时区");
  }
  try {
    // IANA 时区显式校验（cron-parser/luxon 对非法时区静默回退——不可接受）。
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone });
  } catch {
    throw new Error("cron 表达式或时区非法");
  }
  try {
    // 解析即校验（表达式）。
    CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone });
  } catch {
    throw new Error("cron 表达式或时区非法");
  }
  if (schedule.endAt) parseOneTimeInstant(schedule.endAt);
}
