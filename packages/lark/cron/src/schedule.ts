/**
 * 执行期调度计算（Provider 内部）：下一次发生时刻与首个 nextRunAt。
 * 契约面校验（validateSchedule/parseOneTimeInstant）在 dsh-lark-contracts。
 */
import { CronExpressionParser } from "cron-parser";

import { parseOneTimeInstant, type CronSchedule } from "dsh-lark-contracts";

/** 下一次发生时刻（严格晚于 after）；endAt 含端点（越过即无下一次）。 */
export function nextOccurrence(schedule: CronSchedule, after: Date): Date | undefined {
  if (!Number.isFinite(after.getTime())) throw new Error("参照时间非法");
  if (schedule.kind === "at") {
    const instant = parseOneTimeInstant(schedule.at);
    return instant.getTime() > after.getTime() ? instant : undefined;
  }
  try {
    if (schedule.expression.trim().split(/\s+/).length !== 5) throw new Error();
    const next = CronExpressionParser.parse(schedule.expression, {
      currentDate: after,
      tz: schedule.timezone,
    }).next().toDate();
    if (schedule.endAt && next.getTime() > parseOneTimeInstant(schedule.endAt).getTime()) {
      return undefined;
    }
    return next;
  } catch {
    throw new Error("cron 表达式非法");
  }
}

/** 创建时的首个 nextRunAt（after = 当前时刻）。 */
export function initialNextRunAt(schedule: CronSchedule, now: Date): Date {
  const next = nextOccurrence(schedule, now);
  if (!next) throw new Error("调度已过期（请使用未来时刻）");
  return next;
}
