export type DoorAgentMigrationErrorCode =
  | "APPROVAL_INVALID"
  | "IMPORT_ABORTED"
  | "IMPORT_INPUT_INVALID"
  | "PLAN_INVALID"
  | "PLAN_STALE"
  | "RUN_BUSY"
  | "SOURCE_NOT_FROZEN"
  | "SOURCE_DIGEST_MISMATCH"
  | "CREDENTIAL_ROLLBACK_UNAVAILABLE"
  | "CREDENTIAL_SOURCE_INVALID"
  | "CREDENTIAL_STATE_CONFLICT"
  | "PATH_ESCAPE"
  | "CONTENT_DIGEST_MISMATCH"
  | "UNSUPPORTED_FILE_TYPE"
  | "TARGET_CONFLICT"
  | "WORKSPACE_PROVIDER_HTTP"
  | "WORKSPACE_PROVIDER_RESPONSE_INVALID"
  | "WORKSPACE_PROVIDER_RPC_ID_MISMATCH";

export class DoorAgentMigrationError extends Error {
  constructor(
    readonly code: DoorAgentMigrationErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DoorAgentMigrationError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DoorAgentMigrationError("IMPORT_ABORTED");
}
