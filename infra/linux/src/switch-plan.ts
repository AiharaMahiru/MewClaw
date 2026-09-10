import { posix } from "node:path";

import type { AtomicSwitchPlan, ExecPlan, FilePlanStep } from "./types.js";
import { assertSafeAbsolutePath, assertSha256, isPathWithin } from "./validation.js";

interface ReleaseSwitchInput {
  currentLink: string;
  nextRelease: string;
  previousRelease: string;
  transactionId: string;
}

interface NginxSwitchInput {
  activeConfigSha256: string;
  activeConfigPath: string;
  backupPath: string;
  candidateSha256: string;
  candidatePath: string;
  killPath: string;
  masterPid: number;
  nginxConfigPath: string;
  nginxPath: string;
  psPath: string;
  transactionId: string;
}

interface SwitchTargets {
  linkPath: string;
  nextTarget: string;
  previousTarget: string;
  transactionId: string;
}

export function planReleaseSwitch(input: ReleaseSwitchInput): AtomicSwitchPlan {
  const currentLink = assertSafeAbsolutePath(input.currentLink, "currentLink");
  const releaseRoot = posix.join(posix.dirname(currentLink), "releases");
  const nextRelease = assertSafeAbsolutePath(input.nextRelease, "nextRelease");
  const previousRelease = assertSafeAbsolutePath(input.previousRelease, "previousRelease");
  if (!isPathWithin(nextRelease, releaseRoot) || !isPathWithin(previousRelease, releaseRoot)) {
    throw new Error("release switch targets must stay under the release root");
  }
  return createAtomicSwitchPlan({
    linkPath: currentLink,
    nextTarget: nextRelease,
    previousTarget: previousRelease,
    transactionId: assertTransactionId(input.transactionId),
  });
}

export function planNginxUpstreamSwitch(input: NginxSwitchInput): AtomicSwitchPlan {
  const activePath = assertSafeAbsolutePath(input.activeConfigPath, "activeConfigPath");
  const directory = posix.dirname(activePath);
  const candidatePath = assertSiblingPath(input.candidatePath, directory, "candidatePath");
  const backupPath = assertSiblingPath(input.backupPath, directory, "backupPath");
  if (new Set([activePath, candidatePath, backupPath]).size !== 3) throw new Error("Nginx switch paths must be distinct");
  const transactionId = assertTransactionId(input.transactionId);
  const rollbackPath = posix.join(directory, `.${posix.basename(activePath)}.rollback.${transactionId}`);
  const masterPid = assertMasterPid(input.masterPid);
  const activeDigest = assertSha256(input.activeConfigSha256, "activeConfigSha256");
  const candidateDigest = assertSha256(input.candidateSha256, "candidateSha256");
  const reload = exec(input.killPath, ["-HUP", String(masterPid)]);
  return {
    activate: [reload],
    prepare: [
      verifyDigest(activePath, activeDigest),
      copyFile(activePath, backupPath),
      verifyDigest(backupPath, activeDigest),
      verifyDigest(candidatePath, candidateDigest),
      fsync(directory),
    ],
    commit: [{ destination: activePath, kind: "rename", source: candidatePath }, fsync(directory)],
    rollback: [
      verifyDigest(backupPath, activeDigest),
      copyFile(backupPath, rollbackPath),
      fsync(directory),
      { destination: activePath, kind: "rename", source: rollbackPath },
      fsync(directory),
    ],
    rollbackActivation: [reload],
    verify: createNginxVerification(input, masterPid),
  };
}

function createNginxVerification(input: NginxSwitchInput, masterPid: number): ExecPlan[] {
  const nginxPath = assertSafeAbsolutePath(input.nginxPath, "nginxPath");
  const configPath = assertSafeAbsolutePath(input.nginxConfigPath, "nginxConfigPath");
  const process = exec(input.psPath, ["-p", String(masterPid), "-o", "pid=,ppid=,args="], [
    nginxPath,
    "-c",
    configPath,
  ]);
  return [process, exec(nginxPath, ["-t", "-c", configPath])];
}

function createAtomicSwitchPlan(targets: SwitchTargets): AtomicSwitchPlan {
  const directory = posix.dirname(targets.linkPath);
  const basename = posix.basename(targets.linkPath);
  const nextLink = posix.join(directory, `.${basename}.next.${targets.transactionId}`);
  const rollbackLink = posix.join(directory, `.${basename}.rollback.${targets.transactionId}`);
  return {
    activate: [],
    prepare: symlinkPreparation(nextLink, targets.nextTarget, directory),
    commit: symlinkCommit(nextLink, targets.linkPath, directory),
    rollback: [
      ...symlinkPreparation(rollbackLink, targets.previousTarget, directory),
      ...symlinkCommit(rollbackLink, targets.linkPath, directory),
    ],
    rollbackActivation: [],
    verify: [],
  };
}

function symlinkPreparation(linkPath: string, target: string, directory: string): FilePlanStep[] {
  return [{ kind: "create-symlink", linkPath, target }, { kind: "fsync-directory", path: directory }];
}

function symlinkCommit(source: string, destination: string, directory: string): FilePlanStep[] {
  return [{ destination, kind: "rename", source }, { kind: "fsync-directory", path: directory }];
}

function copyFile(source: string, destination: string): FilePlanStep {
  return { destination, kind: "copy-file", overwrite: false, source };
}

function fsync(path: string): FilePlanStep {
  return { kind: "fsync-directory", path };
}

function verifyDigest(path: string, sha256: string): FilePlanStep {
  return { kind: "verify-sha256", path, sha256 };
}

function exec(executable: string, args: readonly string[], expectedStdoutIncludes: readonly string[] = []): ExecPlan {
  const plan: ExecPlan = {
    args: [...args],
    executable: assertSafeAbsolutePath(executable, "executable"),
    kind: "exec",
    requiredEnvironment: [],
  };
  return expectedStdoutIncludes.length > 0 ? { ...plan, expectedStdoutIncludes: [...expectedStdoutIncludes] } : plan;
}

function assertSiblingPath(value: string, directory: string, label: string): string {
  const path = assertSafeAbsolutePath(value, label);
  if (posix.dirname(path) !== directory) throw new Error(`${label} must be in the active Nginx vhost directory`);
  return path;
}

function assertMasterPid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 1) throw new Error("Nginx masterPid must be a safe process identifier");
  return value;
}

function assertTransactionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error("transactionId is invalid");
  return value;
}
