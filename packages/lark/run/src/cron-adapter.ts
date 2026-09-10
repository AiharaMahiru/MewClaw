import type { Context } from "@deepseek-ai/cordis";
import type { JobId, CronControlCommand } from "dsh-lark-contracts";
import type {} from "dsh-lark-contracts";

import type { CronHttpService } from "./http-types.js";

type CronService = NonNullable<Context["cron"]>;
type ControlHandler = (command: CronControlCommand) => Promise<unknown>;

function optionalJob(
  command: CronControlCommand,
  action: (jobId: JobId) => Promise<unknown>,
): Promise<unknown> | undefined {
  return command.jobId ? action(command.jobId) : undefined;
}

function parseAtSchedule(record: Record<string, unknown>) {
  if (typeof record.at !== "string") throw new Error("schedule.at 非法");
  return { kind: "at" as const, at: record.at };
}

function parseCronSchedule(record: Record<string, unknown>) {
  if (typeof record.expression !== "string" || typeof record.timezone !== "string") {
    throw new Error("schedule 非法");
  }
  return {
    kind: "cron" as const,
    expression: record.expression,
    timezone: record.timezone,
    ...(typeof record.endAt === "string" && record.endAt ? { endAt: record.endAt } : {}),
  };
}

function parseScheduleWire(input: unknown) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") throw new Error("schedule 非法");
  const record = input as Record<string, unknown>;
  if (record.kind === "at") return parseAtSchedule(record);
  if (record.kind === "cron") return parseCronSchedule(record);
  throw new Error("schedule.kind 非法");
}

async function updateJob(service: CronService, command: CronControlCommand): Promise<unknown> {
  if (!command.jobId) throw new Error("update 需要 jobId");
  const payload = (command.payload ?? {}) as { task?: unknown; schedule?: unknown };
  if (payload.task !== undefined && typeof payload.task !== "string") throw new Error("task 非法");
  const schedule = parseScheduleWire(payload.schedule);
  return service.update(command.scope, command.jobId, {
    ...(payload.task !== undefined ? { task: payload.task } : {}),
    ...(schedule ? { schedule } : {}),
  });
}

function controlHandlers(service: CronService): Record<CronControlCommand["kind"], ControlHandler> {
  return {
    list: async (command) => {
      const [jobs, runs] = await Promise.all([
        service.list(command.scope, {}),
        service.listRuns(command.scope, 5),
      ]);
      return { jobs, runs };
    },
    get: async (command) => optionalJob(command, (jobId) => service.get(command.scope, jobId)),
    update: async (command) => updateJob(service, command),
    start: async (command) => optionalJob(command, (jobId) => service.resume(command.scope, jobId)),
    stop: async (command) => optionalJob(command, (jobId) => service.pause(command.scope, jobId)),
    delete: async (command) => ({
      removed: command.jobId ? await service.remove(command.scope, command.jobId) : false,
    }),
  };
}

export function createCronHttpService(ctx: Context): CronHttpService {
  const service = ctx.cron!;
  const handlers = controlHandlers(service);
  return {
    control: (command) => handlers[command.kind](command),
    claimDeliveries: async (input) => {
      const deliveries = await service.claimDeliveries({ ...input, now: new Date(), limit: 20 });
      return deliveries as never[];
    },
    ackDelivery: (input) => service.ackDelivery(input.runId, input.deliveryToken, new Date()),
  };
}
