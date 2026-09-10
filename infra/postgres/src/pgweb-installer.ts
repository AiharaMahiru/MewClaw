/**
 * pgweb 可执行文件安装器。
 * 来源：lark-claw packages/postgres-runtime（整体平移，M0）。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { type RuntimePaths } from "./config.js";
import { PGWEB_ARCHIVE } from "./manifest.js";
import { runChecked } from "./process.js";

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export async function installPgweb(paths: RuntimePaths): Promise<void> {
  requireWindows();
  if (await exists(pgwebExe(paths))) {
    await verifyPgweb(paths);
    await writeReceipt(paths);
    return;
  }
  await mkdir(paths.downloadsRoot, { recursive: true });
  if (!(await validArchive(paths.pgwebArchivePath))) await downloadPgweb(paths);
  await extractPgweb(paths);
  await verifyPgweb(paths);
  await writeReceipt(paths);
}

async function downloadPgweb(paths: RuntimePaths): Promise<void> {
  if (
    (await exists(paths.pgwebArchivePath)) &&
    (await stat(paths.pgwebArchivePath)).size >= PGWEB_ARCHIVE.bytes
  ) {
    await rm(paths.pgwebArchivePath, { force: true });
  }
  await runChecked(
    "curl.exe",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--continue-at",
      "-",
      "--output",
      paths.pgwebArchivePath,
      PGWEB_ARCHIVE.url,
    ],
    { timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (!(await validArchive(paths.pgwebArchivePath))) {
    throw new Error("pgweb archive failed size or SHA-256 verification");
  }
}

async function extractPgweb(paths: RuntimePaths): Promise<void> {
  const stage = resolve(paths.root, "runtime/.pgweb-stage");
  const tar = resolve(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe");
  await safeRemove(stage, paths.root);
  await mkdir(stage, { recursive: true });
  try {
    await runChecked(tar, ["-xf", paths.pgwebArchivePath, "-C", stage], {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const executable = await findExtractedExecutable(stage);
    await safeRemove(paths.pgwebRoot, paths.root);
    await mkdir(paths.pgwebRoot, { recursive: true });
    await rename(executable, pgwebExe(paths));
  } finally {
    await safeRemove(stage, paths.root);
  }
}

async function findExtractedExecutable(stage: string): Promise<string> {
  const entries = await readdir(stage, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile()).map((entry) => resolve(stage, entry.name));
  if (candidates.length !== 1) throw new Error("pgweb archive must contain one executable");
  return candidates[0]!;
}

async function verifyPgweb(paths: RuntimePaths): Promise<void> {
  const result = await runChecked(pgwebExe(paths), ["--version"]);
  if (!result.stdout.includes(PGWEB_ARCHIVE.version)) {
    throw new Error(`Unexpected pgweb version: ${result.stdout.trim()}`);
  }
}

async function validArchive(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  if ((await stat(path)).size !== PGWEB_ARCHIVE.bytes) return false;
  return (await hashFile(path)) === PGWEB_ARCHIVE.sha256;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeReceipt(paths: RuntimePaths): Promise<void> {
  const receipt = { version: PGWEB_ARCHIVE.version, sha256: PGWEB_ARCHIVE.sha256 };
  await writeFile(resolve(paths.root, "pgweb-runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function safeRemove(target: string, root: string): Promise<void> {
  const child = relative(resolve(root), resolve(target));
  if (!child || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Refusing to remove path outside runtime root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pgwebExe(paths: RuntimePaths): string {
  return resolve(paths.pgwebRoot, "pgweb.exe");
}

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("Portable pgweb currently supports Windows only");
}
