export interface RuntimePaths {
  backupsRoot: string;
  currentLink: string;
  environmentFile: string;
  releasesRoot: string;
  sessionsRoot: string;
  stateRoot: string;
  uploadsRoot: string;
  workspacesRoot: string;
}

export interface RuntimePorts {
  admin: number;
  authEdge: number;
  browser: number;
  preview: number;
  postgres: number;
  workerRun: number;
  workerWeb: number;
}

export interface UnitManifest {
  configSha256: string;
  entrypoint: string;
  name: string;
}

export interface EnvironmentFileMetadata {
  bytes: number;
  group: string;
  mode: "0600";
  owner: string;
  path: string;
  sha256: string;
}

export interface SourceFileMetadata {
  bytes: number;
  path: string;
  sha256: string;
}

export interface ProductionRuntimeManifest {
  schemaVersion: 1;
  createdAt: string;
  host: {
    architecture: string;
    bootId: string;
    hostname: string;
    osRelease: string;
  };
  release: {
    artifactSha256: string;
    gitCommit: string;
    lockfileSha256: string;
    productionLockSha256: string;
  };
  paths: RuntimePaths;
  ports: RuntimePorts;
  database: {
    bindHost: "127.0.0.1";
    cluster: string;
    vectorVersion: string;
    version: string;
  };
  sandbox: {
    imageDigest: string;
    network: "none";
    rootless: true;
  };
  units: readonly UnitManifest[];
  environment: EnvironmentFileMetadata;
}

export type RuntimePhase =
  | "staged"
  | "verified"
  | "source-frozen"
  | "promoted"
  | "rollback-pending"
  | "rolled-back"
  | "accepted";

export interface CutoverEpochRecord {
  schemaVersion: 1;
  epochId: string;
  migrationRunId: string;
  sourceManifestSha256: string;
  targetManifestSha256: string;
  openedAt: string;
  sealedAt?: string;
  phase: RuntimePhase;
  nextSequence: number;
}

export type CutoverSurface =
  | "auth"
  | "billing"
  | "session"
  | "workspace"
  | "upload"
  | "knowledge"
  | "memory";

export interface CutoverDeltaEntry {
  epochId: string;
  sequence: number;
  operationId: string;
  occurredAt: string;
  surface: CutoverSurface;
  kind: "create" | "update" | "delete";
  targetDigest: string;
  beforeDigest?: string;
  afterDigest: string;
  reversible: boolean;
  durableReference: string;
}

export interface CutoverJournal {
  epoch: CutoverEpochRecord;
  entries: readonly CutoverDeltaEntry[];
}

export interface ExecPlan {
  args: readonly string[];
  executable: string;
  expectedStdoutIncludes?: readonly string[];
  kind: "exec";
  requiredEnvironment: readonly string[];
}

export type FilePlanStep =
  | { destination: string; kind: "copy-file"; overwrite: false; source: string }
  | { kind: "create-symlink"; linkPath: string; target: string }
  | { kind: "fsync-directory"; path: string }
  | { kind: "rename"; destination: string; source: string }
  | { kind: "verify-sha256"; path: string; sha256: string };

export interface AtomicSwitchPlan {
  activate: readonly ExecPlan[];
  commit: readonly FilePlanStep[];
  prepare: readonly FilePlanStep[];
  rollback: readonly FilePlanStep[];
  rollbackActivation: readonly ExecPlan[];
  verify: readonly ExecPlan[];
}

export interface ProductionPackageEntry {
  archiveContentSha1: string | null;
  archiveUrl: string | null;
  architecture: string;
  filename: string;
  name: string;
  repository: string;
  sha256: string;
  size: number;
  version: string;
}

export interface ProductionRuntimeEntry {
  architecture: "x64";
  name: "node";
  platform: "linux";
  sha256: string;
  size: number;
  url: string;
  version: string;
}

export interface ProductionPackageLock {
  schemaVersion: 1;
  observedAt: string;
  host: { architecture: string; os: string };
  packages: readonly ProductionPackageEntry[];
  runtimes: readonly ProductionRuntimeEntry[];
}
