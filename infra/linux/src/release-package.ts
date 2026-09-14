import { chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { copySelectedRoots } from "./release-copy.js";
import {
  assertPathExists,
  parsePackageManagerVersion,
  pathExists,
  sha256File,
  stripVersionPrefix,
} from "./release-fs-utils.js";
import { collectTarEntries, TAR_BLOCK_SIZE, writeTarFile, writeTarHeader } from "./release-tar.js";
import type { ProductionPackageLock } from "./types.js";

const REQUIRED_RELEASE_PATHS = [
  "apps/admin-web/dist/index.html",
  "apps/admin/boot-check.overlay.yml",
  "apps/admin/dist/main.js",
  "apps/auth/dist/main.js",
  "apps/browser/dist/main.js",
  "apps/preview/dist/main.js",
  "apps/lark-gateway/dist/main.js",
  "apps/lark-worker/dist/main.js",
  "apps/lark-worker/full.overlay.yml",
  "apps/lark-worker/full-port0.overlay.yml",
  "apps/lark-worker/boot-check.overlay.yml",
  "apps/lark-worker/lightweight.overlay.yml",
  "apps/lark-worker/web-port0.overlay.yml",
  "apps/migration/dist/main.js",
  "infra/linux/overlays/admin.production.yml",
  "infra/linux/overlays/gateway.production.yml",
  "infra/linux/overlays/worker.production.yml",
  "infra/linux/systemd/dsh-browser.service",
  "infra/linux/systemd/dsh-preview.service",
  "infra/linux/systemd/dsh-podman-ready.service",
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  "presets/lark-standard/preset.json",
  "packages/browser/browser/lib/index.js",
  "packages/browser/tool-browser/lib/index.js",
  "packages/lark/tool-cdg/lib/index.js",
  "scripts/validate-linux-release.mjs",
  "scripts/verify-dsh-brand.mjs",
  "skills/cdg-bridge/SKILL.md",
  "skills/trust-manifest.json",
  "skills/lark-browser/SKILL.md",
] as const;

export interface ReleaseCommand {
  argv: readonly string[];
  cwd: string;
}

export interface ReleaseContentEntry {
  kind: "directory" | "file";
  path: string;
  sha256?: string;
  size: number;
  sourcePath?: string;
}

export interface ReleaseContentManifest {
  schemaVersion: 1;
  createdAt: string;
  entries: readonly ReleaseContentEntry[];
  gitCommit: string;
  nodeVersion: string;
  pnpmVersion: string;
  releaseId: string;
}

export interface MaterializeReleaseOptions {
  buildRoot: string;
  createdAt: string;
  gitCommit: string;
  nodeVersion: string;
  pnpmVersion: string;
  releaseId: string;
  releaseRoot: string;
}

export interface ReleaseArchiveResult {
  entries: number;
  sha256: string;
}

export function assertLockedBuildVersions(input: {
  nodeVersion: string;
  packageManager: string;
  pnpmVersion: string;
  productionLock: ProductionPackageLock;
}): void {
  const expectedNode = input.productionLock.runtimes[0]?.version;
  if (!expectedNode) throw new Error("production lock is missing the Node runtime");
  if (stripVersionPrefix(input.nodeVersion) !== expectedNode) {
    throw new Error(`Node version mismatch: expected ${expectedNode}, received ${input.nodeVersion}`);
  }
  const expectedPnpm = parsePackageManagerVersion(input.packageManager);
  if (input.pnpmVersion !== expectedPnpm) {
    throw new Error(`pnpm version mismatch: expected ${expectedPnpm}, received ${input.pnpmVersion}`);
  }
}

export function createLinuxBuildPlan(root: string): readonly ReleaseCommand[] {
  return [
    { argv: ["pnpm", "install", "--frozen-lockfile"], cwd: root },
    { argv: ["pnpm", "build"], cwd: root },
    { argv: ["pnpm", "build:admin-web"], cwd: root },
    { argv: ["node", "scripts/validate-linux-release.mjs"], cwd: root },
  ];
}

export async function stageWorkspaceForLinuxBuild(sourceRoot: string, stageRoot: string): Promise<void> {
  await mkdir(stageRoot, { recursive: true });
  await copySelectedRoots({ mode: "stage", sourceRoot, targetRoot: stageRoot });
}

export async function validateReleaseBuildRoot(root: string): Promise<void> {
  for (const relativePath of REQUIRED_RELEASE_PATHS) {
    await assertPathExists(root, relativePath);
  }
}

export async function materializeReleaseTree(options: MaterializeReleaseOptions): Promise<ReleaseContentManifest> {
  await mkdir(options.releaseRoot, { recursive: true });
  const entries = await copySelectedRoots({
    mode: "release",
    sourceRoot: options.buildRoot,
    targetRoot: options.releaseRoot,
  });
  await rewriteLinuxReleaseTypeScriptConfigs(options.releaseRoot, entries);
  const manifest = {
    schemaVersion: 1,
    createdAt: options.createdAt,
    entries,
    gitCommit: options.gitCommit,
    nodeVersion: stripVersionPrefix(options.nodeVersion),
    pnpmVersion: options.pnpmVersion,
    releaseId: options.releaseId,
  } satisfies ReleaseContentManifest;
  await writeManifest(options.releaseRoot, manifest);
  return manifest;
}

async function rewriteLinuxReleaseTypeScriptConfigs(
  releaseRoot: string,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const rootConfigPath = join(releaseRoot, "tsconfig.json");
  if (await pathExists(rootConfigPath)) {
    const config = JSON.parse(await readFile(rootConfigPath, "utf8")) as {
      references?: Array<{ path?: string }>;
    };
    if (config.references) {
      config.references = config.references.filter((reference) => reference.path !== "infra/windows");
    }
    await rewriteManifestFile(releaseRoot, "tsconfig.json", config, entries);
  }

  const testConfigPath = join(releaseRoot, "tsconfig.test.json");
  if (await pathExists(testConfigPath)) {
    const config = JSON.parse(await readFile(testConfigPath, "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    delete config.compilerOptions?.paths?.["dsh-lark-service-runtime"];
    await rewriteManifestFile(releaseRoot, "tsconfig.test.json", config, entries);
  }
}

async function rewriteManifestFile(
  releaseRoot: string,
  relativePath: string,
  value: unknown,
  entries: ReleaseContentEntry[],
): Promise<void> {
  const path = join(releaseRoot, relativePath);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await chmod(path, 0o644);
  const fileStats = await stat(path);
  const entry = entries.find((candidate) => candidate.kind === "file" && candidate.path === relativePath);
  if (!entry) throw new Error(`release manifest entry is missing for rewritten file: ${relativePath}`);
  entry.sha256 = await sha256File(path);
  entry.size = fileStats.size;
}

export async function writeReleaseArchive(releaseRoot: string, archivePath: string): Promise<ReleaseArchiveResult> {
  const directory = dirname(archivePath);
  await mkdir(directory, { recursive: true });
  const entries = await collectTarEntries(releaseRoot);
  const handle = await open(archivePath, "w");
  try {
    for (const entry of entries) {
      await writeTarHeader(handle, releaseRoot, entry);
      if (entry.kind === "file") await writeTarFile(handle, join(releaseRoot, entry.path), entry.size);
    }
    await handle.write(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  } finally {
    await handle.close();
  }
  return { entries: entries.length, sha256: await sha256File(archivePath) };
}

async function writeManifest(root: string, manifest: ReleaseContentManifest): Promise<void> {
  const path = join(root, ".dsh-release-manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
