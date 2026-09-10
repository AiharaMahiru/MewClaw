import { randomUUID } from "node:crypto";

import {
  parseBotId,
  parseConversationId,
  parseDeploymentId,
  parseTenantId,
  parseUserId,
  type Scope,
  type UserId,
} from "dsh-lark-contracts";
import { parseMemoryCommand, type MemoryCommand, type MemoryResult } from "dsh-memory";

import type { MemoryDatabase } from "./database.js";
import { isMemoryUserKey, memoryUserKey } from "./identifiers.js";

export interface MemorySchedulerConfig {
  concurrency: number;
  pollIntervalMs: number;
  maxAttempts: number;
  leaseMs: number;
}

interface LoggerPort { warn(message: string): void }

interface JobRow {
  id: string;
  command: unknown;
  tenant_id: string;
  bot_id: string;
  deployment_id: string;
  user_id: string;
  conversation_id: string;
  attempts: number;
}

type ExecuteCommand = (scope: Scope, command: MemoryCommand) => Promise<MemoryResult>;

export class MemoryWriteScheduler {
  #timer: NodeJS.Timeout | undefined;
  #running = 0;
  #draining = false;
  #stopped = false;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly execute: ExecuteCommand,
    private readonly logger: LoggerPort,
    private readonly config: MemorySchedulerConfig,
  ) {}

  async start(): Promise<void> {
    await this.database.query(
      `UPDATE memory_write_jobs SET status='queued',locked_at=NULL,updated_at=now()
       WHERE status='running' AND locked_at < now() - ($1::text || ' milliseconds')::interval`,
      [this.config.leaseMs],
    );
    this.#timer = setInterval(() => { void this.drain(); }, this.config.pollIntervalMs);
    await this.drain();
  }

  async enqueue(scope: Scope, command: MemoryCommand): Promise<void> {
    if (this.#stopped) throw new Error("MEMORY_SCHEDULER_STOPPED");
    const userKey = memoryUserKey(scope, scope.userId);
    await this.database.query(
      `INSERT INTO memory_write_jobs (id,tenant_id,bot_id,deployment_id,user_id,conversation_id,command,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'queued')`,
      [randomUUID(), scope.tenantId, scope.botId, scope.deploymentId, userKey, scope.conversationId, JSON.stringify(persistedCommand(scope, command))],
    );
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.#stopped || this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#stopped && this.#running < this.config.concurrency) {
        let job: JobRow | undefined;
        try { job = await this.claim(); }
        catch (error) {
          this.logger.warn(`memory-mem0: scheduler claim failed (${error instanceof Error ? error.message : "unknown"})`);
          break;
        }
        if (!job) break;
        this.#running += 1;
        void this.run(job).finally(() => {
          this.#running -= 1;
          void this.drain();
        });
      }
    } catch (error) {
      this.logger.warn(`memory-mem0: scheduler drain failed (${error instanceof Error ? error.message : "unknown"})`);
    } finally {
      this.#draining = false;
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    while (this.#running > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async claim(): Promise<JobRow | undefined> {
    const result = await this.database.transaction(async (tx) => {
      const rows = await tx.query<JobRow>(
        `WITH next_job AS (
           SELECT id FROM memory_write_jobs
           WHERE status='queued' AND available_at <= now()
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE memory_write_jobs j SET status='running',attempts=j.attempts+1,locked_at=now(),updated_at=now()
         FROM next_job WHERE j.id=next_job.id RETURNING j.*`,
      );
      return rows.rows[0];
    });
    return result;
  }

  private async run(job: JobRow): Promise<void> {
    const scope = restoreScope(job);
    if (!scope) {
      await this.fail(job, "INVALID_SCOPE", false);
      return;
    }
    try {
      const raw = typeof job.command === "string" ? JSON.parse(job.command) : job.command;
      const parsed = parseMemoryCommand(raw);
      if (!parsed.ok) {
        await this.fail(job, "INVALID_COMMAND", false);
        return;
      }
      await this.execute(scope, parsed.value);
      await this.database.query(`UPDATE memory_write_jobs SET status='completed',locked_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await this.fail(job, message, job.attempts < this.config.maxAttempts);
    }
  }

  private async fail(job: JobRow, message: string, retry: boolean): Promise<void> {
    if (retry) {
      const delay = Math.min(60_000, 100 * 2 ** Math.max(0, job.attempts - 1));
      await this.database.query(
        `UPDATE memory_write_jobs SET status='queued',available_at=now()+($1::text || ' milliseconds')::interval,locked_at=NULL,last_error=$2,updated_at=now() WHERE id=$3`,
        [delay, message.slice(0, 512), job.id],
      );
      return;
    }
    await this.database.query(`UPDATE memory_write_jobs SET status='failed',locked_at=NULL,last_error=$1,updated_at=now() WHERE id=$2`, [message.slice(0, 512), job.id]);
    this.logger.warn("memory-mem0: 异步写入任务失败，已达到重试上限");
  }
}

/** 从持久化的哈希 Scope 恢复图 Provider 所需的最小内部 Scope。 */
function restoreScope(job: JobRow): Scope | undefined {
  const tenant = parseTenantId(job.tenant_id);
  const bot = parseBotId(job.bot_id);
  const deployment = parseDeploymentId(job.deployment_id);
  const conversation = parseConversationId(job.conversation_id);
  if (!tenant.ok || !bot.ok || !deployment.ok || !conversation.ok) return undefined;
  let userId: UserId;
  if (isMemoryUserKey(job.user_id)) {
    userId = job.user_id as UserId;
  } else {
    const user = parseUserId(job.user_id);
    if (!user.ok) return undefined;
    userId = memoryUserKey({
      tenantId: tenant.value,
      botId: bot.value,
      deploymentId: deployment.value,
      userId: user.value,
      conversationId: conversation.value,
    }, user.value) as UserId;
  }
  return {
    tenantId: tenant.value,
    botId: bot.value,
    deploymentId: deployment.value,
    userId,
    conversationId: conversation.value,
  };
}

/** 任务载荷也不能携带 Cube 成员的明文用户键。 */
function persistedCommand(scope: Scope, command: MemoryCommand): MemoryCommand {
  if (command.op === "cube_create" && command.cube.members) {
    return { ...command, cube: { ...command.cube, members: command.cube.members.map((member) => ({ ...member, userId: memoryUserKey(scope, member.userId) })) } };
  }
  if (command.op === "cube_update" && command.patch.members) {
    return { ...command, patch: { ...command.patch, members: command.patch.members.map((member) => ({ ...member, userId: memoryUserKey(scope, member.userId) })) } };
  }
  return command;
}
