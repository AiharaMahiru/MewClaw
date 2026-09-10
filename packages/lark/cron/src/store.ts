/**
 * PG 存储（lark-claw postgres-cron-store 平移）。
 *
 * 不变量：一切按 Scope 过滤（tenant/bot/deployment/user/conversation）；
 * 领取用 FOR UPDATE SKIP LOCKED（同一任务同一时刻至多一个执行者）；
 * complete 校验租约令牌未丢；投递 send-before-ack（租约 + token）。
 */
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import type { Scope } from "dsh-lark-contracts";

import type {
  ClaimedCronJob,
  CreateCronJobInput,
  CronJob,
  CronJobFilter,
  CronJobStatus,
  CronRun,
  CronRunOutcome,
  CronRunStatus,
  CronSchedule,
  PendingCronDelivery,
  UpdateCronJobInput,
} from "dsh-lark-contracts";
import { validateSchedule } from "dsh-lark-contracts";
import { DEFAULT_LEASE_MS, DEFAULT_OUTBOX_LEASE_MS } from "./config.js";
import { initialNextRunAt, nextOccurrence } from "./schedule.js";

export interface CronQueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount?: number | null;
}

export interface CronQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<CronQueryResult<Row>>;
  execute(sql: string): Promise<void>;
}

export interface CronDatabase extends CronQueryExecutor {
  transaction<T>(run: (executor: CronQueryExecutor) => Promise<T>): Promise<T>;
}

export interface CronStoreOptions {
  leaseMs: number;
  outboxLeaseMs: number;
  createLeaseToken?: () => string;
}

interface JobRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  deployment_id: string;
  user_id: string;
  conversation_id: string;
  task: string;
  schedule_kind: "at" | "cron";
  schedule_value: string;
  timezone: string | null;
  end_at: Date | string | null;
  status: CronJobStatus;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  lease_token: string | null;
  lease_until: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow extends QueryResultRow {
  run_id: string;
  job_id: string;
  status: CronRunStatus;
  scheduled_for: Date | string;
  started_at: Date | string;
  finished_at: Date | string;
  output: string;
  error: string | null;
  delivery_token: string | null;
}

const JOB_COLUMNS = "id, tenant_id, bot_id, deployment_id, user_id, conversation_id, task, schedule_kind, schedule_value, timezone, end_at, status, next_run_at, last_run_at, lease_token, lease_until, created_at, updated_at";

function scopeValues(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId, scope.conversationId];
}
/** 管理授权边界 = tenant/bot/deployment/user（conversation 只是执行与投递范围）。 */
function userScopeValues(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId];
}

function scheduleOf(row: JobRow): CronSchedule {
  return row.schedule_kind === "at"
    ? { kind: "at", at: row.schedule_value }
    : {
      kind: "cron",
      expression: row.schedule_value,
      timezone: row.timezone ?? "UTC",
      ...(row.end_at ? { endAt: new Date(row.end_at).toISOString() } : {}),
    };
}

function jobFromRow(row: JobRow): CronJob {
  const nextRunAt = row.next_run_at ? new Date(row.next_run_at).toISOString() : undefined;
  const lastRunAt = row.last_run_at ? new Date(row.last_run_at).toISOString() : undefined;
  return {
    id: row.id,
    scope: {
      tenantId: row.tenant_id as never,
      botId: row.bot_id as never,
      deploymentId: row.deployment_id as never,
      userId: row.user_id as never,
      conversationId: row.conversation_id as never,
    },
    task: row.task,
    schedule: scheduleOf(row),
    status: row.status,
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function runFromRow(row: RunRow): CronRun {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    status: row.status,
    scheduledFor: new Date(row.scheduled_for).toISOString(),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date(row.finished_at).toISOString(),
    output: row.output,
    ...(row.error ? { error: row.error } : {}),
  };
}

export class PostgresCronStore {
  private readonly leaseMs: number;
  private readonly outboxLeaseMs: number;
  private readonly createLeaseToken: () => string;

  constructor(
    private readonly database: CronDatabase,
    options: Partial<CronStoreOptions> = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.outboxLeaseMs = options.outboxLeaseMs ?? DEFAULT_OUTBOX_LEASE_MS;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async create(scope: Scope, input: CreateCronJobInput, now: Date): Promise<CronJob> {
    validateSchedule(input.schedule);
    const nextRunAt = initialNextRunAt(input.schedule, now);
    const scheduleValue = input.schedule.kind === "at" ? input.schedule.at : input.schedule.expression;
    const timezone = input.schedule.kind === "cron" ? input.schedule.timezone : null;
    const endAt = input.schedule.kind === "cron" ? input.schedule.endAt ?? null : null;
    const result = await this.database.query<JobRow>(
      `INSERT INTO cron_jobs (${JOB_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,NULL,NULL,NULL,$13,$13)
       RETURNING ${JOB_COLUMNS}`,
      [randomUUID(), ...scopeValues(scope), input.task.trim(), input.schedule.kind,
        scheduleValue, timezone, endAt, nextRunAt, now],
    );
    return jobFromRow(result.rows[0]!);
  }

  async get(scope: Scope, jobId: string): Promise<CronJob | undefined> {
    const result = await this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE id = $1 AND tenant_id = $2 AND bot_id = $3
       AND deployment_id = $4 AND user_id = $5`,
      [jobId, ...userScopeValues(scope)],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async list(scope: Scope, filter: CronJobFilter, limit: number): Promise<CronJob[]> {
    const result = await this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE tenant_id = $1 AND bot_id = $2
       AND deployment_id = $3 AND user_id = $4
       ${filter === "all" ? "" : "AND status = $6"}
       ORDER BY created_at DESC LIMIT $5`,
      filter === "all"
        ? [...userScopeValues(scope), limit]
        : [...userScopeValues(scope), limit, filter],
    );
    return result.rows.map(jobFromRow);
  }

  async listRuns(scope: Scope, limit: number): Promise<CronRun[]> {
    const result = await this.database.query<RunRow>(
      `SELECT r.run_id, r.job_id, r.status, r.scheduled_for, r.started_at,
              r.finished_at, r.output, r.error, r.delivery_token
       FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id
       WHERE j.tenant_id = $1 AND j.bot_id = $2 AND j.deployment_id = $3
         AND j.user_id = $4
       ORDER BY r.finished_at DESC LIMIT $5`,
      [...userScopeValues(scope), limit],
    );
    return result.rows.map(runFromRow);
  }

  /** 更新（同一 SQL 内重算 nextRunAt 并清租约——防窗口竞态）。 */
  async update(scope: Scope, jobId: string, input: UpdateCronJobInput, now: Date): Promise<CronJob | undefined> {
    const current = await this.get(scope, jobId);
    if (!current) return undefined;
    const schedule = input.schedule ?? current.schedule;
    validateSchedule(schedule);
    const nextRunAt = input.schedule ? initialNextRunAt(schedule, now) : current.nextRunAt;
    const task = input.task !== undefined ? input.task.trim() : current.task;
    const scheduleValue = schedule.kind === "at" ? schedule.at : schedule.expression;
    const timezone = schedule.kind === "cron" ? schedule.timezone : null;
    const endAt = schedule.kind === "cron" ? schedule.endAt ?? null : null;
    const result = await this.database.query<JobRow>(
      `UPDATE cron_jobs SET task = $6, schedule_kind = $7, schedule_value = $8,
         timezone = $9, end_at = $10, next_run_at = $11, lease_token = NULL,
         lease_until = NULL, updated_at = $12
       WHERE id = $1 AND tenant_id = $2 AND bot_id = $3 AND deployment_id = $4
         AND user_id = $5 RETURNING ${JOB_COLUMNS}`,
      [jobId, ...userScopeValues(scope), task, schedule.kind, scheduleValue,
        timezone, endAt, nextRunAt ? new Date(nextRunAt) : null, now],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async updateStatus(scope: Scope, jobId: string, status: CronJobStatus, nextRunAt: Date | undefined): Promise<CronJob | undefined> {
    const result = await this.database.query<JobRow>(
      `UPDATE cron_jobs SET status = $6, next_run_at = $7, lease_token = NULL,
         lease_until = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND bot_id = $3 AND deployment_id = $4
         AND user_id = $5 RETURNING ${JOB_COLUMNS}`,
      [jobId, ...userScopeValues(scope), status, nextRunAt ?? null],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async remove(scope: Scope, jobId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM cron_jobs WHERE id = $1 AND tenant_id = $2 AND bot_id = $3
       AND deployment_id = $4 AND user_id = $5`,
      [jobId, ...userScopeValues(scope)],
    );
    return result.rowCount === 1;
  }

  /** SKIP LOCKED 领取到期任务（租约 = leaseToken + lease_until）。 */
  async claimDue(now: Date, limit: number): Promise<ClaimedCronJob[]> {
    return this.database.transaction(async (database) => {
      const token = this.createLeaseToken();
      const leaseUntil = new Date(now.getTime() + this.leaseMs);
      const result = await database.query<JobRow>(
        `WITH due AS (
           SELECT id FROM cron_jobs WHERE status = 'active' AND next_run_at <= $1
             AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE cron_jobs j SET lease_token = $3, lease_until = $4, updated_at = $1
         FROM due WHERE j.id = due.id RETURNING j.*`,
        [now, limit, token, leaseUntil],
      );
      return result.rows.map((row) => ({
        ...jobFromRow(row),
        nextRunAt: new Date(row.next_run_at!).toISOString(),
        leaseToken: token,
      }));
    });
  }

  async renewLease(jobId: string, leaseToken: string, now: Date): Promise<boolean> {
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const result = await this.database.query<{ id: string }>(
      `UPDATE cron_jobs SET lease_until = $4, updated_at = $3
       WHERE id = $1 AND lease_token = $2 AND lease_until > $3 RETURNING id`,
      [jobId, leaseToken, now, leaseUntil],
    );
    return result.rows.length === 1;
  }

  /** 运行结束：租约校验 → 执行历史（幂等）→ 重算下次调度。 */
  async complete(claim: ClaimedCronJob, runId: string, outcome: CronRunOutcome, finishedAt: Date): Promise<void> {
    await this.database.transaction(async (database) => {
      const locked = await database.query<JobRow>(
        "SELECT * FROM cron_jobs WHERE id = $1 FOR UPDATE",
        [claim.id],
      );
      if (locked.rows[0]?.lease_token !== claim.leaseToken) throw new Error("cron 租约已丢失");
      await database.query(
        `INSERT INTO cron_runs (run_id, job_id, status, scheduled_for, started_at,
          finished_at, output, error, artifacts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb)
         ON CONFLICT (job_id, scheduled_for) DO NOTHING`,
        [runId, claim.id, outcome.status, new Date(claim.nextRunAt), finishedAt,
          finishedAt, outcome.output.slice(0, 100_000), outcome.error?.slice(0, 10_000) ?? null],
      );
      const schedule = scheduleOf(locked.rows[0]!);
      const nextRunAt = nextOccurrence(schedule, finishedAt);
      await database.query(
        `UPDATE cron_jobs SET status = $2, next_run_at = $3, last_run_at = $4,
          lease_token = NULL, lease_until = NULL, updated_at = $4 WHERE id = $1`,
        [claim.id, nextRunAt ? "active" : "completed", nextRunAt ?? null, finishedAt],
      );
    });
  }

  /** outbox 认领（网关侧：授权用户集合 + SKIP LOCKED + 租约）。 */
  async claimDeliveries(input: {
    tenantId: string;
    botId: string;
    deploymentId: string;
    userIds: string[];
    now: Date;
    limit: number;
  }): Promise<PendingCronDelivery[]> {
    if (input.userIds.length === 0) return [];
    return this.database.transaction(async (database) => {
      const token = this.createLeaseToken();
      const leaseUntil = new Date(input.now.getTime() + this.outboxLeaseMs);
      const result = await database.query<RunRow & { tenant_id: string; bot_id: string; deployment_id: string; user_id: string; conversation_id: string; task: string }>(
        `WITH pending AS (
           SELECT r.run_id FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id
           WHERE r.delivered_at IS NULL
             AND (r.delivery_lease_until IS NULL OR r.delivery_lease_until <= $1)
             AND j.tenant_id = $2 AND j.bot_id = $3 AND j.deployment_id = $4
             AND j.user_id = ANY($5::text[])
           ORDER BY r.finished_at FOR UPDATE OF r SKIP LOCKED LIMIT $6
         ), claimed AS (
           UPDATE cron_runs r SET delivery_token = $7, delivery_lease_until = $8
           FROM pending WHERE r.run_id = pending.run_id RETURNING r.*
         )
         SELECT claimed.*, j.tenant_id, j.bot_id, j.deployment_id, j.user_id,
           j.conversation_id, j.task FROM claimed JOIN cron_jobs j ON j.id = claimed.job_id`,
        [input.now, input.tenantId, input.botId, input.deploymentId,
          input.userIds, input.limit, token, leaseUntil],
      );
      return result.rows.map((row) => ({
        ...runFromRow(row),
        deliveryToken: token,
        scope: {
          tenantId: row.tenant_id as never,
          botId: row.bot_id as never,
          deploymentId: row.deployment_id as never,
          userId: row.user_id as never,
          conversationId: row.conversation_id as never,
        },
        task: row.task,
      }));
    });
  }

  async ackDelivery(runId: string, deliveryToken: string, deliveredAt: Date): Promise<boolean> {
    const result = await this.database.query<{ run_id: string }>(
      `UPDATE cron_runs SET delivered_at = $3, delivery_token = NULL,
         delivery_lease_until = NULL WHERE run_id = $1 AND delivery_token = $2
         AND delivered_at IS NULL RETURNING run_id`,
      [runId, deliveryToken, deliveredAt],
    );
    return result.rows.length === 1;
  }
}
