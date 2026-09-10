/**
 * PostgreSQL 便携发行版安装器（下载、解压、校验）。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { POSTGRES_VERSION, type RuntimePaths } from "./config.js";
import { PGVECTOR_SOURCE, POSTGRES_ARCHIVE } from "./manifest.js";
import { runChecked } from "./process.js";

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export async function installPortablePostgres(paths: RuntimePaths): Promise<void> {
  requireWindows();
  await mkdir(paths.downloadsRoot, { recursive: true });
  await mkdir(paths.buildRoot, { recursive: true });
  if (!(await pathExists(postgresExe(paths)))) {
    await downloadPostgres(paths.archivePath);
    await extractPostgres(paths);
  }
  await verifyPostgres(paths);
  await installPgvector(paths);
  await writeRuntimeReceipt(paths);
}

async function downloadPostgres(archivePath: string): Promise<void> {
  if (await validArchive(archivePath)) return;
  await runChecked(
    "curl.exe",
    ["--fail", "--location", "--retry", "3", "--continue-at", "-", "--output", archivePath, POSTGRES_ARCHIVE.url],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS },
  );
  if (!(await validArchive(archivePath))) {
    throw new Error("PostgreSQL archive failed size or MD5 verification");
  }
}

async function validArchive(archivePath: string): Promise<boolean> {
  if (!(await pathExists(archivePath))) return false;
  const details = await stat(archivePath);
  if (details.size !== POSTGRES_ARCHIVE.bytes) return false;
  const md5 = await hashFile(archivePath, "md5");
  const sha256 = await hashFile(archivePath, "sha256");
  return md5 === POSTGRES_ARCHIVE.md5 && sha256 === POSTGRES_ARCHIVE.sha256;
}

async function extractPostgres(paths: RuntimePaths): Promise<void> {
  const stage = resolve(paths.root, "runtime/.postgres-stage");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const tar = resolve(systemRoot, "System32/tar.exe");
  await safeRemove(stage, paths.root);
  await mkdir(stage, { recursive: true });
  try {
    await runChecked(tar, ["-xf", paths.archivePath, "-C", stage], {
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    const extracted = resolve(stage, "pgsql");
    await access(resolve(extracted, "bin/postgres.exe"));
    await mkdir(dirname(paths.postgresRoot), { recursive: true });
    await safeRemove(paths.postgresRoot, paths.root);
    await rename(extracted, paths.postgresRoot);
  } finally {
    await safeRemove(stage, paths.root);
  }
}

async function verifyPostgres(paths: RuntimePaths): Promise<void> {
  const executable = postgresExe(paths);
  const version = await runChecked(executable, ["--version"]);
  const serverVersion = POSTGRES_VERSION.replace(/-\d+$/, "");
  if (!version.stdout.includes(serverVersion)) {
    throw new Error(`Unexpected PostgreSQL version: ${version.stdout.trim()}`);
  }
}

async function installPgvector(paths: RuntimePaths): Promise<void> {
  const control = resolve(paths.postgresRoot, "share/extension/vector.control");
  const library = resolve(paths.postgresRoot, "lib/vector.dll");
  if ((await pathExists(control)) && (await pathExists(library))) return;
  const source = resolve(paths.buildRoot, `pgvector-${PGVECTOR_SOURCE.tag}`);
  await checkoutPgvector(source, paths.root);
  const vsDevCmd = await findVsDevCmd();
  assertCmdSafe([source, paths.postgresRoot, vsDevCmd]);
  await buildPgvector(source, paths.postgresRoot, vsDevCmd);
  await access(control);
  await access(library);
}

async function buildPgvector(source: string, postgresRoot: string, vsDevCmd: string): Promise<void> {
  const scriptPath = resolve(source, ".build-pgvector.cmd");
  const script = [
    "@echo off",
    `call "${vsDevCmd}" -arch=amd64 -host_arch=amd64 || exit /b 1`,
    `set "PGROOT=${postgresRoot}"`,
    "nmake /F Makefile.win || exit /b 1",
    "nmake /F Makefile.win install || exit /b 1",
  ].join("\r\n");
  await writeFile(scriptPath, `${script}\r\n`);
  try {
    await runChecked("cmd.exe", ["/d", "/c", ".build-pgvector.cmd"], {
      cwd: source,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } finally {
    await unlink(scriptPath).catch(() => undefined);
  }
}

async function checkoutPgvector(source: string, runtimeRoot: string): Promise<void> {
  await safeRemove(source, runtimeRoot);
  await runChecked("git.exe", [
    "clone",
    "--depth",
    "1",
    "--branch",
    PGVECTOR_SOURCE.tag,
    PGVECTOR_SOURCE.repository,
    source,
  ]);
  const head = await runChecked("git.exe", ["-C", source, "rev-parse", "HEAD"]);
  if (head.stdout.trim() !== PGVECTOR_SOURCE.commit) {
    await safeRemove(source, runtimeRoot);
    throw new Error("pgvector source commit verification failed");
  }
}

async function findVsDevCmd(): Promise<string> {
  const programFiles = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = resolve(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
  const result = await runChecked(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  const installation = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!installation) throw new Error("Visual Studio C++ build tools are required");
  return resolve(installation, "Common7/Tools/VsDevCmd.bat");
}

async function writeRuntimeReceipt(paths: RuntimePaths): Promise<void> {
  const receipt = {
    postgresVersion: POSTGRES_VERSION,
    postgresArchiveMd5: POSTGRES_ARCHIVE.md5,
    postgresArchiveSha256: POSTGRES_ARCHIVE.sha256,
    pgvectorTag: PGVECTOR_SOURCE.tag,
    pgvectorCommit: PGVECTOR_SOURCE.commit,
  };
  await writeFile(resolve(paths.root, "runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function hashFile(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function safeRemove(target: string, root: string): Promise<void> {
  const path = resolve(target);
  const base = resolve(root);
  const child = relative(base, path);
  if (!child || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Refusing to remove path outside runtime root: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function postgresExe(paths: RuntimePaths): string {
  return resolve(paths.postgresRoot, "bin/postgres.exe");
}

function assertCmdSafe(paths: readonly string[]): void {
  if (paths.some((path) => /[&|<>^\r\n]/.test(path))) {
    throw new Error("Runtime paths contain characters unsafe for the Visual Studio build shell");
  }
}

function requireWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Portable PostgreSQL installation currently supports Windows only");
  }
}
