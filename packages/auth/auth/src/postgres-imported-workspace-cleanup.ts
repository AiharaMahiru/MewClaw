import type { Pool, PoolClient } from "pg";

import type { ImportedWorkspaceCleanupInput } from "./types.js";

interface CleanupRow {
  source_id: string;
  target_id: string | null;
  target_user_id: string | null;
  resource_id: string | null;
}

export async function purgeImportedWorkspaceResources(
  pool: Pool,
  input: ImportedWorkspaceCleanupInput,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`dsh-lark:workspace-cleanup:${input.runId}`]);
    const operator = await client.query(`
      SELECT 1 FROM auth_sessions AS sessions
      JOIN auth_users AS users ON users.id = sessions.user_id
      WHERE sessions.id = $1 AND sessions.user_id = $2
        AND sessions.revoked_at IS NULL AND sessions.expires_at > $3
        AND users.role = 'admin' AND users.status = 'active'
    `, [input.operatorSessionId, input.operatorUserId, input.now]);
    if (!operator.rowCount) throw new Error("IMPORT_NOT_AUTHORIZED");

    const candidates = await client.query<CleanupRow>(`
      SELECT mappings.source_id, mappings.target_id, mappings.target_user_id,
             resources.resource_id
      FROM auth_import_mappings AS mappings
      LEFT JOIN auth_resources AS resources
        ON resources.resource_type = 'workspace'
       AND resources.resource_id = mappings.target_id
       AND resources.user_id = mappings.target_user_id
      WHERE mappings.run_id = $1 AND mappings.source_system = 'dooragent'
        AND mappings.source_type = 'workspace' AND mappings.result = 'claimed'
        AND mappings.created_target = true AND mappings.rolled_back_at IS NULL
      ORDER BY mappings.source_id
      FOR UPDATE OF mappings
    `, [input.runId]);
    assertCandidates(candidates.rows);
    for (const row of candidates.rows) await removeCandidate(client, input, row);
    await client.query(
      `INSERT INTO auth_audit_log
       (action,user_id,request_id,ip_hash,user_agent_hash,metadata,created_at)
       VALUES ('auth.import.workspace-cleanup',$1,$2,NULL,NULL,$3,$4)`,
      [input.operatorUserId, input.requestId, { runId: input.runId, removed: candidates.rows.length }, input.now],
    );
    await client.query("COMMIT");
    return candidates.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertCandidates(rows: CleanupRow[]): void {
  if (rows.some((row) => !row.target_id || !row.target_user_id || row.resource_id !== row.target_id)) {
    throw new Error("WORKSPACE_CLEANUP_CONFLICT");
  }
}

async function removeCandidate(
  client: PoolClient,
  input: ImportedWorkspaceCleanupInput,
  row: CleanupRow,
): Promise<void> {
  const removed = await client.query(
    `DELETE FROM auth_resources
     WHERE resource_type = 'workspace' AND resource_id = $1 AND user_id = $2`,
    [row.target_id, row.target_user_id],
  );
  const marked = await client.query(
    `UPDATE auth_import_mappings SET rolled_back_at = $4
     WHERE run_id = $1 AND source_system = 'dooragent' AND source_type = 'workspace'
       AND source_id = $2 AND target_id = $3 AND rolled_back_at IS NULL`,
    [input.runId, row.source_id, row.target_id, input.now],
  );
  if (removed.rowCount !== 1 || marked.rowCount !== 1) throw new Error("WORKSPACE_CLEANUP_CONFLICT");
}
