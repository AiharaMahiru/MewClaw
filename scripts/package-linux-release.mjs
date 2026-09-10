import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { parseProductionPackageLock } from "../infra/linux/src/production-lock.ts";
import {
  assertLockedBuildVersions,
  createLinuxBuildPlan,
  materializeReleaseTree,
  stageWorkspaceForLinuxBuild,
  validateReleaseBuildRoot,
  writeReleaseArchive,
} from "../infra/linux/src/release-package.ts";

const execFileAsync = promisify(execFile);
const PNPM_EXECUTABLE = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
const outputDir = resolve(options.outputDir ?? join(sourceRoot, ".artifacts/linux-release"));
const preparedRoot = options.preparedRoot ? resolve(options.preparedRoot) : null;
const buildRoot = preparedRoot ?? await mkdtemp(join(tmpdir(), "dsh-linux-build-"));
const releaseRoot = await mkdtemp(join(tmpdir(), "dsh-linux-release-"));
const cleanupPaths = options.keepStage ? [releaseRoot] : [releaseRoot, ...(!preparedRoot ? [buildRoot] : [])];

try {
  const gitCommit = options.gitCommit ?? await resolveGitCommit(sourceRoot);
  const workspace = await readJson(join(sourceRoot, "package.json"));
  const productionLock = parseProductionPackageLock(await readJson(join(sourceRoot, "infra/linux/production.lock.json")));
  const nodeVersion = process.version;
  const pnpmVersion = await resolvePnpmVersion(sourceRoot);
  assertLockedBuildVersions({
    nodeVersion,
    packageManager: workspace.packageManager,
    pnpmVersion,
    productionLock,
  });
  if (!preparedRoot) await prepareBuildRoot(sourceRoot, buildRoot);
  await validateReleaseBuildRoot(buildRoot);
  const releaseId = options.releaseId ?? `dsh-linux-${gitCommit.slice(0, 12)}`;
  const manifest = await materializeReleaseTree({
    buildRoot,
    createdAt: new Date().toISOString(),
    gitCommit,
    nodeVersion,
    pnpmVersion,
    releaseId,
    releaseRoot,
  });
  await mkdir(outputDir, { recursive: true });
  const archivePath = join(outputDir, `${releaseId}.tar`);
  const manifestPath = join(outputDir, `${releaseId}.content-manifest.json`);
  const archive = await writeReleaseArchive(releaseRoot, archivePath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeShaFile(archivePath, archive.sha256);
  await writeShaFile(manifestPath, await sha256File(manifestPath));
  console.log(JSON.stringify({
    ok: true,
    archivePath,
    archiveSha256: archive.sha256,
    entryCount: archive.entries,
    manifestPath,
    releaseId,
  }, null, 2));
} finally {
  await Promise.all(cleanupPaths.map((path) => rm(path, { force: true, recursive: true })));
}

function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--keep-stage") {
      booleans.add(token);
      continue;
    }
    if (!["--git-commit", "--output-dir", "--prepared-root", "--release-id", "--source-root"].includes(token)) {
      throw new Error(`unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }
  return {
    gitCommit: values.get("--git-commit"),
    keepStage: booleans.has("--keep-stage"),
    outputDir: values.get("--output-dir"),
    preparedRoot: values.get("--prepared-root"),
    releaseId: values.get("--release-id"),
    sourceRoot: values.get("--source-root"),
  };
}

async function prepareBuildRoot(sourceRoot, buildRoot) {
  if (process.platform !== "linux") {
    throw new Error("fresh linux packaging requires a Linux host; use --prepared-root for an existing Linux build root");
  }
  await stageWorkspaceForLinuxBuild(sourceRoot, buildRoot);
  for (const command of createLinuxBuildPlan(buildRoot)) {
    await runExecutable(command.argv[0], command.argv.slice(1), command.cwd);
  }
}

async function resolveGitCommit(root) {
  const result = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return result.stdout.trim();
}

async function resolvePnpmVersion(root) {
  const result = await runExecutable("pnpm", ["--version"], root);
  return result.stdout.trim();
}

async function runExecutable(command, args, cwd) {
  if (process.platform !== "win32" || command !== "pnpm") {
    return execFileAsync(command, args, { cwd });
  }
  return execFileAsync("cmd.exe", ["/d", "/s", "/c", PNPM_EXECUTABLE, ...args], { cwd });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  const source = await readFile(path);
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(source).digest("hex");
}

async function writeShaFile(path, sha256) {
  await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
}
