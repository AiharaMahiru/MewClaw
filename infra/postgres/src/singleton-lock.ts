/**
 * 单实例锁（防重复启动）。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { createHash } from "node:crypto";

import { Client } from "pg";

const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, $2) AS unlocked";

interface AdvisoryLockClient {
  connect(): Promise<unknown>;
  query(sql: string, values?: number[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export interface SingletonProcessLock {
  release(): Promise<void>;
}

export interface AcquireSingletonProcessLockOptions {
  connectionString: string;
  identity: string;
  onLockLost: (error: Error) => void;
  clientFactory?: (connectionString: string) => AdvisoryLockClient;
}

export class SingletonLockUnavailableError extends Error {
  constructor() {
    super("Another process already owns the requested singleton lock");
    this.name = "SingletonLockUnavailableError";
  }
}

export function deriveAdvisoryLockKeys(identity: string): [number, number] {
  if (!identity) throw new Error("Singleton lock identity is required");
  const digest = createHash("sha256").update(identity).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function acquireSingletonProcessLock(
  options: AcquireSingletonProcessLockOptions,
): Promise<SingletonProcessLock> {
  const keys = deriveAdvisoryLockKeys(options.identity);
  const client = options.clientFactory?.(options.connectionString)
    ?? new Client({ connectionString: options.connectionString });
  await connectClient(client);
  const connectionError = (error: Error) => options.onLockLost(error);
  client.on("error", connectionError);

  try {
    const result = await client.query(TRY_LOCK_SQL, keys);
    if (result.rows[0]?.acquired !== true) {
      throw new SingletonLockUnavailableError();
    }
    return createLock(client, keys, connectionError);
  } catch (error) {
    client.off("error", connectionError);
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function connectClient(client: AdvisoryLockClient): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

function createLock(
  client: AdvisoryLockClient,
  keys: [number, number],
  connectionError: (error: Error) => void,
): SingletonProcessLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      client.off("error", connectionError);
      try {
        await client.query(UNLOCK_SQL, keys);
      } finally {
        await client.end();
      }
    },
  };
}
