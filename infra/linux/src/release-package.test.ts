import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseProductionPackageLock } from "./production-lock.js";
import {
  assertLockedBuildVersions,
  createLinuxBuildPlan,
  materializeReleaseTree,
  stageWorkspaceForLinuxBuild,
  validateReleaseBuildRoot,
  writeReleaseArchive,
} from "./release-package.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).reverse().map((path) => rm(path, { force: true, recursive: true })));
});

describe("linux release packaging", () => {
  it("隔离 full boot-check 的 OCI profile 标记且禁止打开浏览器", async () => {
    const validator = await readFile("scripts/validate-linux-release.mjs", "utf8");
    expect(validator).toContain('{ unsetEnv: ["DSH_SANDBOX_IMAGE"] }');
    expect(validator.match(/"--no-open"/gu)).toHaveLength(2);
  });

  it("stages a clean workspace copy without node_modules, dist, env, or caches", async () => {
    const sourceRoot = await tempDir("release-source-");
    const stageRoot = await tempDir("release-stage-");

    await writeFileAt(sourceRoot, "package.json", JSON.stringify({
      packageManager: "pnpm@10.30.3",
      devDependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" },
    }));
    await writeFileAt(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await writeFileAt(sourceRoot, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    await writeFileAt(sourceRoot, "apps/auth/src/main.ts", "export {};\n");
    await writeFileAt(sourceRoot, "scripts/build-web-auth-client.mjs", "console.log('ok');\n");
    await writeFileAt(sourceRoot, "skills/trust-manifest.json", "{\"schemaVersion\":1}\n");
    await writeFileAt(sourceRoot, "presets/lark-standard/preset.json", "{\"name\":\"lark-standard\"}\n");
    await writeFileAt(sourceRoot, "node_modules/win-only.txt", "windows");
    await writeFileAt(sourceRoot, "infra/windows/service.ps1", "windows");
    await writeFileAt(sourceRoot, "apps/auth/dist/main.js", "stale");
    await writeFileAt(sourceRoot, ".env", "SECRET=1\n");
    await writeFileAt(sourceRoot, ".git/config", "[core]\n");
    await writeFileAt(sourceRoot, ".pnpm-store/cache.json", "{}\n");

    await stageWorkspaceForLinuxBuild(sourceRoot, stageRoot);

    await expect(readFile(join(stageRoot, "apps/auth/src/main.ts"), "utf8")).resolves.toContain("export");
    await expect(readFile(join(stageRoot, "presets/lark-standard/preset.json"), "utf8")).resolves.toContain("lark-standard");
    await expect(pathExists(join(stageRoot, "node_modules"))).resolves.toBe(false);
    await expect(pathExists(join(stageRoot, "apps/auth/dist"))).resolves.toBe(false);
    await expect(pathExists(join(stageRoot, ".env"))).resolves.toBe(false);
    await expect(pathExists(join(stageRoot, ".git"))).resolves.toBe(false);
    await expect(pathExists(join(stageRoot, ".pnpm-store"))).resolves.toBe(false);
    await expect(pathExists(join(stageRoot, "infra/windows/service.ps1"))).resolves.toBe(true);
  });

  it("pins exact Node and pnpm versions and schedules install/build/validate commands", async () => {
    const workspace = JSON.parse(await readFile("package.json", "utf8")) as { packageManager: string };
    const lock = parseProductionPackageLock(JSON.parse(await readFile("infra/linux/production.lock.json", "utf8")));

    expect(() => assertLockedBuildVersions({
      nodeVersion: "v24.19.0",
      packageManager: workspace.packageManager,
      pnpmVersion: "10.30.3",
      productionLock: lock,
    })).not.toThrow();
    expect(() => assertLockedBuildVersions({
      nodeVersion: "v24.19.1",
      packageManager: workspace.packageManager,
      pnpmVersion: "10.30.3",
      productionLock: lock,
    })).toThrow(/Node/);
    expect(() => assertLockedBuildVersions({
      nodeVersion: "v24.19.0",
      packageManager: workspace.packageManager,
      pnpmVersion: "10.30.2",
      productionLock: lock,
    })).toThrow(/pnpm/);

    expect(createLinuxBuildPlan("/release")).toEqual([
      { argv: ["pnpm", "install", "--frozen-lockfile"], cwd: "/release" },
      { argv: ["pnpm", "build"], cwd: "/release" },
      { argv: ["pnpm", "build:admin-web"], cwd: "/release" },
      { argv: ["node", "scripts/validate-linux-release.mjs"], cwd: "/release" },
    ]);
  });

  it("requires built runtime entrypoints, overlays, skills, and brand verification assets", async () => {
    const buildRoot = await tempDir("release-build-");
    await writeBuildRootFixture(buildRoot);

    await expect(validateReleaseBuildRoot(buildRoot)).resolves.toBeUndefined();

    await rm(join(buildRoot, "skills"), { force: true, recursive: true });
    await expect(validateReleaseBuildRoot(buildRoot)).rejects.toThrow(/skills\//);
  });

  it("materializes in-root symlinks, excludes secrets, and rejects escaped symlinks", async () => {
    const buildRoot = await tempDir("release-build-");
    const releaseRoot = await tempDir("release-root-");
    await writeBuildRootFixture(buildRoot);
    await writeFileAt(buildRoot, ".env", "SECRET=1\n");
    await writeFileAt(buildRoot, "node_modules/.cache/index.json", "{}\n");
    await writeFileAt(buildRoot, "packages/local-pkg/dist/index.js", "export const value = 1;\n");
    await writeFileAt(buildRoot, "packages/local-pkg/package.json", "{\"name\":\"local-pkg\"}\n");
    await writeFileAt(buildRoot, "packages/local-pkg/bin/cli.mjs", "#!/usr/bin/env node\nimport '../dist/index.js';\n");
    await chmod(join(buildRoot, "packages/local-pkg/bin/cli.mjs"), 0o755);
    await writeFileAt(buildRoot, "packages/bundle/web/agent-presets-tia/tia-openness/agent.cordis.yml", "disabled\n");
    await writeFileAt(buildRoot, "infra/windows/service.ps1", "windows\n");
    await ensureDir(join(buildRoot, "node_modules"));
    await ensureDir(join(buildRoot, "node_modules/.bin"));
    await symlink(
      join(buildRoot, "packages/local-pkg"),
      join(buildRoot, "node_modules/local-pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      join(buildRoot, "packages/local-pkg/bin/cli.mjs"),
      join(buildRoot, "node_modules/.bin/local-tool"),
      process.platform === "win32" ? "file" : undefined,
    );

    const manifest = await materializeReleaseTree({
      buildRoot,
      createdAt: "2026-08-23T00:00:00.000Z",
      gitCommit: "a".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "10.30.3",
      releaseId: "fixture-release",
      releaseRoot,
    });

    await expect(readFile(join(releaseRoot, "node_modules/local-pkg/dist/index.js"), "utf8")).resolves.toContain("value = 1");
    const binWrapper = await readFile(join(releaseRoot, "node_modules/.bin/local-tool"), "utf8");
    expect(binWrapper).toContain("packages/local-pkg/bin/cli.mjs");
    expect((await stat(join(releaseRoot, "node_modules/.bin/local-tool"))).mode & 0o111).toBeGreaterThan(0);
    expect((await stat(join(releaseRoot, "packages/local-pkg/bin/cli.mjs"))).mode & 0o111).toBeGreaterThan(0);
    await expect(readFile(join(releaseRoot, "presets/lark-standard/preset.json"), "utf8")).resolves.toContain("lark-standard");
    expect(manifest.entries.some((entry) => entry.path === "node_modules/local-pkg/dist/index.js")).toBe(true);
    expect(await pathExists(join(releaseRoot, "packages/bundle/web/agent-presets-tia"))).toBe(false);
    expect(await pathExists(join(releaseRoot, "infra/windows"))).toBe(false);
    expect(await pathExists(join(releaseRoot, ".env"))).toBe(false);
    expect(await pathExists(join(releaseRoot, "node_modules/.cache"))).toBe(false);

    const outsideRoot = await tempDir("release-outside-");
    await writeFileAt(outsideRoot, "escape/index.js", "export const escape = true;\n");
    await symlink(
      join(outsideRoot, "escape"),
      join(buildRoot, "node_modules/escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(materializeReleaseTree({
      buildRoot,
      createdAt: "2026-08-23T00:00:00.000Z",
      gitCommit: "a".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "10.30.3",
      releaseId: "fixture-release",
      releaseRoot: await tempDir("release-root-"),
    })).rejects.toThrow(/outside/i);
  });

  it("rewrites TypeScript configs so the Linux release has no Windows references", async () => {
    const buildRoot = await tempDir("release-build-");
    const releaseRoot = await tempDir("release-root-");
    await writeBuildRootFixture(buildRoot);
    await writeFileAt(buildRoot, "tsconfig.json", JSON.stringify({
      files: [],
      references: [{ path: "infra/linux" }, { path: "infra/windows" }],
    }));
    await writeFileAt(buildRoot, "tsconfig.test.json", JSON.stringify({
      compilerOptions: {
        paths: {
          "dsh-linux-production-runtime": ["infra/linux/src/index.ts"],
          "dsh-lark-service-runtime": ["infra/windows/src/index.ts"],
        },
      },
    }));

    const manifest = await materializeReleaseTree({
      buildRoot,
      createdAt: "2026-08-29T00:00:00.000Z",
      gitCommit: "c".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "10.30.3",
      releaseId: "fixture-release",
      releaseRoot,
    });

    const rootConfig = JSON.parse(await readFile(join(releaseRoot, "tsconfig.json"), "utf8"));
    const testConfig = JSON.parse(await readFile(join(releaseRoot, "tsconfig.test.json"), "utf8"));
    expect(rootConfig.references).toEqual([{ path: "infra/linux" }]);
    expect(testConfig.compilerOptions.paths).not.toHaveProperty("dsh-lark-service-runtime");

    for (const relativePath of ["tsconfig.json", "tsconfig.test.json"]) {
      const content = await readFile(join(releaseRoot, relativePath));
      const entry = manifest.entries.find((candidate) => candidate.path === relativePath);
      expect(entry?.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(entry?.size).toBe(content.byteLength);
    }
  });

  it("writes deterministic tar archives with only directory and regular-file entries", async () => {
    const buildRoot = await tempDir("release-build-");
    const firstRoot = await tempDir("release-root-");
    const secondRoot = await tempDir("release-root-");
    await writeBuildRootFixture(buildRoot);

    await materializeReleaseTree({
      buildRoot,
      createdAt: "2026-08-23T00:00:00.000Z",
      gitCommit: "b".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "10.30.3",
      releaseId: "fixture-release",
      releaseRoot: firstRoot,
    });
    await materializeReleaseTree({
      buildRoot,
      createdAt: "2026-08-23T00:00:00.000Z",
      gitCommit: "b".repeat(40),
      nodeVersion: "24.19.0",
      pnpmVersion: "10.30.3",
      releaseId: "fixture-release",
      releaseRoot: secondRoot,
    });

    const firstArchive = join(await tempDir("release-artifact-"), "fixture-release.tar");
    const secondArchive = join(await tempDir("release-artifact-"), "fixture-release.tar");
    const first = await writeReleaseArchive(firstRoot, firstArchive);
    const second = await writeReleaseArchive(secondRoot, secondArchive);
    const types = tarTypeFlags(await readFile(firstArchive));

    expect(first.sha256).toBe(second.sha256);
    expect(types.every((flag) => flag === "0" || flag === "5")).toBe(true);
  });

  it("archives long nested directory paths with the USTAR prefix field", async () => {
    const releaseRoot = await tempDir("release-root-");
    const longDirectory = [
      "apps",
      "admin",
      "node_modules",
      "dsh-lark-admin-bundle",
      "node_modules",
      "dsh-knowledge-postgres",
      "node_modules",
      "dsh-knowledge",
      "node_modules",
      "dsh-lark-contracts",
      "src",
      "__snapshots__",
    ].join("/");
    const longFileName = "getchatcompletionfieldoptionscountsv1observabilitychatcompletionfieldsfieldnameoptionscountspost.d.ts";
    await writeFileAt(releaseRoot, `${longDirectory}/${longFileName}`, "export {}\n");

    const archivePath = join(await tempDir("release-artifact-"), "long-path.tar");
    await expect(writeReleaseArchive(releaseRoot, archivePath)).resolves.toMatchObject({ entries: expect.any(Number) });
    expect(tarTypeFlags(await readFile(archivePath))).toContain("x");
  });
});

async function writeBuildRootFixture(root: string): Promise<void> {
  await writeFileAt(root, "package.json", JSON.stringify({
    packageManager: "pnpm@10.30.3",
    devDependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" },
  }));
  await writeFileAt(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await writeFileAt(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  await writeFileAt(root, "scripts/verify-dsh-brand.mjs", "console.log('brand ok');\n");
  await writeFileAt(root, "scripts/validate-linux-release.mjs", "console.log('release ok');\n");
  await writeFileAt(root, "skills/trust-manifest.json", "{\"schemaVersion\":1}\n");
  await writeFileAt(root, "skills/cdg-bridge/SKILL.md", "---\nname: cdg-bridge\ndescription: cdg\n---\n");
  await writeFileAt(root, "skills/lark-browser/SKILL.md", "---\nname: lark-browser\ndescription: browser\n---\n");
  await writeFileAt(root, "presets/lark-standard/preset.json", "{\"name\":\"lark-standard\"}\n");
  await writeFileAt(root, "apps/auth/dist/main.js", "console.log('auth');\n");
  await writeFileAt(root, "apps/browser/dist/main.js", "console.log('browser');\n");
  await writeFileAt(root, "apps/preview/dist/main.js", "console.log('preview');\n");
  await writeFileAt(root, "apps/lark-worker/dist/main.js", "console.log('worker');\n");
  await writeFileAt(root, "apps/lark-gateway/dist/main.js", "console.log('gateway');\n");
  await writeFileAt(root, "apps/admin/dist/main.js", "console.log('admin');\n");
  await writeFileAt(root, "apps/migration/dist/main.js", "console.log('migration');\n");
  await writeFileAt(root, "apps/admin-web/dist/index.html", "<!doctype html>\n");
  await writeFileAt(root, "apps/lark-worker/full.overlay.yml", "rows: []\n");
  await writeFileAt(root, "apps/lark-worker/full-port0.overlay.yml", "rows: []\n");
  await writeFileAt(root, "apps/lark-worker/boot-check.overlay.yml", "rows: []\n");
  await writeFileAt(root, "apps/lark-worker/lightweight.overlay.yml", "rows: []\n");
  await writeFileAt(root, "apps/lark-worker/web-port0.overlay.yml", "rows: []\n");
  await writeFileAt(root, "apps/admin/boot-check.overlay.yml", "rows: []\n");
  await writeFileAt(root, "infra/linux/overlays/worker.production.yml", "rows: []\n");
  await writeFileAt(root, "infra/linux/overlays/gateway.production.yml", "rows: []\n");
  await writeFileAt(root, "infra/linux/overlays/admin.production.yml", "rows: []\n");
  await writeFileAt(root, "infra/linux/systemd/dsh-browser.service", "[Service]\nExecStart=/bin/true\n");
  await writeFileAt(root, "infra/linux/systemd/dsh-preview.service", "[Service]\nExecStart=/bin/true\n");
  await writeFileAt(root, "infra/linux/systemd/dsh-podman-ready.service", "[Service]\nExecStart=/bin/true\n");
  await writeFileAt(root, "packages/browser/browser/lib/index.js", "export {};\n");
  await writeFileAt(root, "packages/browser/tool-browser/lib/index.js", "export {};\n");
  await writeFileAt(root, "packages/lark/tool-cdg/lib/index.js", "export {};\n");
  await writeFileAt(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html", "<title>MewClaw Harness</title>\n");
}

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

async function writeFileAt(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await ensureDir(dirname(target));
  await writeFile(target, contents, "utf8");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function tarTypeFlags(buffer: Buffer): string[] {
  const flags: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((value) => value === 0)) break;
    flags.push(String.fromCharCode(block[156] || 0));
    const size = Number.parseInt(block.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return flags;
}
