import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  DoorAgentMigrationService,
  FrozenDoorAgentSource,
  MigrationApproval,
  MigrationPlan,
  MigrationPolicy,
} from "dsh-dooragent-migration";

import type { MigrationActorInput, MigrationRuntime } from "./runtime.js";

export type { MigrationRuntime } from "./runtime.js";

const COMMANDS = [
  "inspect", "plan", "dry-run", "approve-apply", "apply", "reconcile",
  "sync-credentials", "approve-rollback", "rollback",
] as const;
const ADMIN_COMMANDS = new Set<CommandName>([
  "approve-apply", "apply", "reconcile", "sync-credentials", "approve-rollback", "rollback",
]);
const VALUE_FLAGS = new Set([
  "--snapshot", "--manifest", "--manifest-digest", "--tenant-id", "--bot-id",
  "--deployment-id", "--user-id", "--conversation-id", "--operator-session-id",
  "--request-id", "--run-id", "--approval-ref", "--cutover-epoch-id", "--state-path",
]);
const BOOLEAN_FLAGS = new Set([
  "--allow-credential-reuse", "--include-associated-data", "--enable-admin-command", "--boot-check",
]);
const SAFE_ID = /^\S{1,256}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PASSWORD_HASH = /scrypt:[a-f0-9]{32}:[a-f0-9]{128}/gi;
const SENSITIVE_KEY = /(email|password|token|cookie|secret|approvalref)/i;
const MIGRATION_ERROR_CODES = new Set([
  "APPROVAL_INVALID", "IMPORT_ABORTED", "IMPORT_INPUT_INVALID", "PLAN_INVALID",
  "PLAN_STALE", "SOURCE_NOT_FROZEN", "SOURCE_DIGEST_MISMATCH",
  "CREDENTIAL_ROLLBACK_UNAVAILABLE", "CREDENTIAL_SOURCE_INVALID", "CREDENTIAL_STATE_CONFLICT",
  "PATH_ESCAPE", "CONTENT_DIGEST_MISMATCH", "UNSUPPORTED_FILE_TYPE", "TARGET_CONFLICT",
  "WORKSPACE_PROVIDER_HTTP", "WORKSPACE_PROVIDER_RESPONSE_INVALID",
  "WORKSPACE_PROVIDER_RPC_ID_MISMATCH", "RUN_BUSY",
]);

export const HELP_TEXT = `Usage: dsh-dooragent-migration <command> [options]

Commands:
  inspect | plan | dry-run
  approve-apply | apply | reconcile | sync-credentials | approve-rollback | rollback
    (requires --enable-admin-command)

Lifecycle:
  --boot-check                  boot the full one-shot composition and dispose
  --state-path <absolute path>  durable migration run state (required)
  --help                        print this help without booting Cordis
`;

type CommandName = typeof COMMANDS[number];

interface CommandInvocation {
  kind: "command";
  command: CommandName;
  actor: MigrationActorInput;
  statePath: string;
  source: FrozenDoorAgentSource;
  policy: MigrationPolicy;
  runId?: string;
  approval?: MigrationApproval;
  cutoverEpochId?: string;
}

interface BootInvocation {
  kind: "boot-check";
  actor: MigrationActorInput;
  statePath: string;
}

type Invocation = BootInvocation | CommandInvocation;

export interface MigrationCliDependencies {
  start(actor: MigrationActorInput, statePath: string): Promise<MigrationRuntime>;
  writeStdout(line: string): void;
  writeStderr(line: string): void;
}

class CliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function runMigrationCli(
  argv: readonly string[],
  dependencies: MigrationCliDependencies,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    dependencies.writeStdout(HELP_TEXT);
    return 0;
  }
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    dependencies.writeStderr(failureJson(error));
    return 2;
  }
  return runInvocation(invocation, dependencies);
}

async function runInvocation(
  invocation: Invocation,
  dependencies: MigrationCliDependencies,
): Promise<number> {
  let runtime: MigrationRuntime | undefined;
  let result: unknown;
  let error: unknown;
  try {
    runtime = await dependencies.start(invocation.actor, invocation.statePath);
    result = invocation.kind === "boot-check"
      ? undefined
      : await executeCommand(runtime.service, invocation);
  } catch (caught) {
    error = caught;
  } finally {
    if (runtime) error = await disposeRuntime(runtime, error);
  }
  if (error) {
    dependencies.writeStderr(failureJson(error));
    return 1;
  }
  const command = invocation.kind === "boot-check" ? "boot-check" : invocation.command;
  dependencies.writeStdout(successJson(command, result));
  return 0;
}

async function disposeRuntime(runtime: MigrationRuntime, previous: unknown): Promise<unknown> {
  try {
    await runtime.dispose();
    return previous;
  } catch {
    return previous ?? new CliError("MIGRATION_DISPOSE_FAILED");
  }
}

function parseInvocation(argv: readonly string[]): Invocation {
  const parsed = tokenize(argv);
  const actor = parseActor(parsed.values);
  const bootCheck = parsed.booleans.has("--boot-check");
  const statePath = parseStatePath(parsed.values, bootCheck);
  if (bootCheck) {
    if (parsed.positionals.length > 0) throw new CliError("CLI_USAGE_INVALID");
    return { kind: "boot-check", actor, statePath };
  }
  const command = parseCommand(parsed.positionals);
  assertAdminGate(command, parsed.booleans);
  const source = parseSource(parsed.values);
  const policy: MigrationPolicy = {
    allowCredentialReuse: parsed.booleans.has("--allow-credential-reuse"),
    includeAssociatedData: parsed.booleans.has("--include-associated-data"),
  };
  const runId = parseRunId(command, parsed.values);
  const approval = parseApproval(command, parsed.values);
  return { kind: "command", command, actor, statePath, source, policy, ...runId, ...approval };
}

interface TokenizedArgs {
  booleans: Set<string>;
  positionals: string[];
  values: Map<string, string>;
}

function tokenize(argv: readonly string[]): TokenizedArgs {
  const parsed: TokenizedArgs = { booleans: new Set(), positionals: [], values: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      if (token) parsed.positionals.push(token);
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (parsed.booleans.has(token)) throw new CliError("CLI_USAGE_INVALID");
      parsed.booleans.add(token);
      continue;
    }
    if (!VALUE_FLAGS.has(token) || parsed.values.has(token)) throw new CliError("CLI_USAGE_INVALID");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new CliError("CLI_USAGE_INVALID");
    parsed.values.set(token, value);
    index += 1;
  }
  return parsed;
}

function parseActor(values: Map<string, string>): MigrationActorInput {
  const userId = requiredId(values, "--user-id");
  return {
    scope: {
      tenantId: requiredId(values, "--tenant-id"),
      botId: requiredId(values, "--bot-id"),
      deploymentId: requiredId(values, "--deployment-id"),
      userId,
      conversationId: requiredId(values, "--conversation-id"),
    },
    operator: {
      userId,
      sessionId: requiredId(values, "--operator-session-id"),
      requestId: requiredId(values, "--request-id"),
    },
  };
}

function parseSource(values: Map<string, string>): FrozenDoorAgentSource {
  const digest = requiredValue(values, "--manifest-digest");
  if (!SHA256_HEX.test(digest)) throw new CliError("CLI_USAGE_INVALID");
  return {
    snapshotPath: requiredValue(values, "--snapshot"),
    manifestPath: requiredValue(values, "--manifest"),
    manifestDigest: digest,
  };
}

function parseStatePath(values: Map<string, string>, bootCheck = false): string {
  const statePath = values.get("--state-path")
    ?? (bootCheck ? join(tmpdir(), `dsh-migration-boot-check-${process.pid}.sqlite`) : undefined);
  if (!statePath || !isAbsolute(statePath)) throw new CliError("CLI_USAGE_INVALID");
  return statePath;
}

function parseCommand(positionals: readonly string[]): CommandName {
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0] as CommandName)) {
    throw new CliError("CLI_USAGE_INVALID");
  }
  return positionals[0] as CommandName;
}

function assertAdminGate(command: CommandName, booleans: Set<string>): void {
  if (ADMIN_COMMANDS.has(command) && !booleans.has("--enable-admin-command")) {
    throw new CliError("ADMIN_MODE_REQUIRED");
  }
}

function parseRunId(command: CommandName, values: Map<string, string>): { runId?: string } {
  if (command !== "reconcile" && command !== "sync-credentials"
    && command !== "approve-rollback" && command !== "rollback") return {};
  return { runId: requiredId(values, "--run-id") };
}

function parseApproval(
  command: CommandName,
  values: Map<string, string>,
): { approval?: MigrationApproval; cutoverEpochId?: string } {
  if (command === "approve-apply") {
    return { cutoverEpochId: requiredId(values, "--cutover-epoch-id", "APPROVAL_REQUIRED") };
  }
  if (command !== "apply" && command !== "rollback") return {};
  return {
    approval: {
      approvalRef: requiredId(values, "--approval-ref", "APPROVAL_REQUIRED"),
      cutoverEpochId: requiredId(values, "--cutover-epoch-id", "APPROVAL_REQUIRED"),
    },
  };
}

function requiredId(values: Map<string, string>, flag: string, code = "CLI_USAGE_INVALID"): string {
  const value = requiredValue(values, flag, code);
  if (!SAFE_ID.test(value)) throw new CliError(code);
  return value;
}

function requiredValue(values: Map<string, string>, flag: string, code = "CLI_USAGE_INVALID"): string {
  const value = values.get(flag);
  if (!value) throw new CliError(code);
  return value;
}

async function executeCommand(
  service: DoorAgentMigrationService,
  invocation: CommandInvocation,
): Promise<unknown> {
  if (invocation.command === "sync-credentials") {
    return service.syncCredentials(invocation.runId!, invocation.source);
  }
  const inventory = await service.inspect(invocation.source);
  if (invocation.command === "inspect") return inventory;
  const plan = await service.plan(inventory, invocation.policy);
  switch (invocation.command) {
    case "plan": return plan;
    case "dry-run": return service.dryRun(plan);
    case "approve-apply": return approveAndApply(service, plan, invocation.cutoverEpochId!);
    case "apply": return service.apply(plan, invocation.approval!);
    case "reconcile":
      assertRunId(plan.runId, invocation.runId);
      return service.reconcile(invocation.runId!);
    case "approve-rollback":
      assertRunId(plan.runId, invocation.runId);
      return approveAndRollback(service, invocation.runId!);
    case "rollback":
      assertRunId(plan.runId, invocation.runId);
      return service.rollback(invocation.runId!, invocation.approval!);
    default: return assertNever(invocation.command);
  }
}

async function approveAndApply(
  service: DoorAgentMigrationService,
  plan: MigrationPlan,
  cutoverEpochId: string,
): Promise<unknown> {
  const approval = await service.issueApplyApproval(plan, cutoverEpochId);
  return service.apply(plan, approval);
}

async function approveAndRollback(
  service: DoorAgentMigrationService,
  runId: string,
): Promise<unknown> {
  const approval = await service.issueRollbackApproval(runId);
  return service.rollback(runId, approval);
}

function assertRunId(planned: string, requested: string | undefined): void {
  if (requested !== planned) throw new CliError("RUN_ID_MISMATCH");
}

function assertNever(value: never): never {
  throw new CliError(`UNSUPPORTED_COMMAND_${String(value)}`);
}

function successJson(command: string, result: unknown): string {
  const envelope = result === undefined
    ? { ok: true, command }
    : { ok: true, command, result: sanitize(result) };
  return JSON.stringify(envelope);
}

function failureJson(error: unknown): string {
  let code = "MIGRATION_FAILED";
  if (error instanceof CliError) code = error.code;
  else if (hasSafeMigrationCode(error)) code = error.code;
  return JSON.stringify({ ok: false, error: { code } });
}

function hasSafeMigrationCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && MIGRATION_ERROR_CODES.has(error.code);
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(PASSWORD_HASH, "[REDACTED]");
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry),
  ]));
}
