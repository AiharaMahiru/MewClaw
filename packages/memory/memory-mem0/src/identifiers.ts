import { createHash } from "node:crypto";

import type { Scope } from "dsh-lark-contracts";
import type { CubeId, MemoryId } from "dsh-memory";
import type { MemoryDatabase } from "./database.js";

export interface MemoryScopeIds {
  userId: string;
  agentId: string;
}

const MEMORY_USER_KEY = /^[0-9a-f]{64}$/;

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** 已持久化的用户键是不可逆的部署内哈希；恢复任务时允许原样传递。 */
export function isMemoryUserKey(value: string): boolean {
  return MEMORY_USER_KEY.test(value);
}

/** 为指定 Scope 用户派生稳定键；成员输入也必须走同一规则。 */
export function memoryUserKey(scope: Scope, userId: string): string {
  if (isMemoryUserKey(userId)) return userId;
  return hash([scope.tenantId, scope.botId, scope.deploymentId, userId]);
}

export function memoryScopeIds(scope: Scope): MemoryScopeIds {
  const agentParts = [scope.tenantId, scope.botId, scope.deploymentId];
  return { agentId: hash(agentParts), userId: memoryUserKey(scope, scope.userId) };
}

export function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

export function cubeId(value: string): CubeId {
  return value as CubeId;
}

/**
 * 将旧版本已经落库的明文用户键一次性升级为哈希键。
 * 该过程只在数据库事务内使用参数化 SQL，不输出原始 ID。
 */
export async function migrateMemoryUserKeys(database: MemoryDatabase): Promise<void> {
  const isKey = "^[0-9a-f]{64}$";
  await database.transaction(async (tx) => {
    const cubes = await tx.query<{ id: string; tenant_id: string; bot_id: string; deployment_id: string; owner_user_id: string }>(
      `SELECT id,tenant_id,bot_id,deployment_id,owner_user_id FROM memory_cubes WHERE owner_user_id !~ $1`, [isKey],
    );
    for (const row of cubes.rows) {
      await tx.query(`UPDATE memory_cubes SET owner_user_id=$1 WHERE id=$2`, [hash([row.tenant_id, row.bot_id, row.deployment_id, row.owner_user_id]), row.id]);
    }

    const members = await tx.query<{ cube_id: string; tenant_id: string; bot_id: string; deployment_id: string; user_id: string }>(
      `SELECT cm.cube_id,c.tenant_id,c.bot_id,c.deployment_id,cm.user_id
       FROM memory_cube_members cm JOIN memory_cubes c ON c.id=cm.cube_id WHERE cm.user_id !~ $1`, [isKey],
    );
    for (const row of members.rows) {
      await tx.query(`UPDATE memory_cube_members SET user_id=$1 WHERE cube_id=$2 AND user_id=$3`, [hash([row.tenant_id, row.bot_id, row.deployment_id, row.user_id]), row.cube_id, row.user_id]);
    }

    const nodes = await tx.query<{ id: string; tenant_id: string; bot_id: string; deployment_id: string; author_user_id: string }>(
      `SELECT id,tenant_id,bot_id,deployment_id,author_user_id FROM memory_nodes WHERE author_user_id !~ $1`, [isKey],
    );
    for (const row of nodes.rows) {
      await tx.query(`UPDATE memory_nodes SET author_user_id=$1 WHERE id=$2`, [hash([row.tenant_id, row.bot_id, row.deployment_id, row.author_user_id]), row.id]);
    }

    const jobs = await tx.query<{ id: string; tenant_id: string; bot_id: string; deployment_id: string; user_id: string }>(
      `SELECT id,tenant_id,bot_id,deployment_id,user_id FROM memory_write_jobs WHERE user_id !~ $1`, [isKey],
    );
    for (const row of jobs.rows) {
      await tx.query(`UPDATE memory_write_jobs SET user_id=$1 WHERE id=$2`, [hash([row.tenant_id, row.bot_id, row.deployment_id, row.user_id]), row.id]);
    }
  });
}
