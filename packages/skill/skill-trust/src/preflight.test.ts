/**
 * 预检核心测试（SPEC skill-trust.md §8）：
 * 缺失条目/摘要不符/通配/符号链接/逃逸全部拒绝；通过用例；manifest 缺失 fail loud。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preflightSkills, SkillTrustError, type TrustManifest } from "./preflight.js";

let root: string | undefined;

async function setup(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "dsh-lark-trust-"));
  return root;
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

/** 建一个技能目录 + 正确 manifest。 */
async function seeded(): Promise<{ root: string; manifestPath: string }> {
  const base = await setup();
  const skills = join(base, "skills");
  await mkdir(join(skills, "demo"), { recursive: true });
  await writeFile(join(skills, "demo", "SKILL.md"), [
    "---",
    "name: demo",
    "description: demo skill",
    "version: 1.0.0",
    "capabilities:",
    "  filesystem:",
    "    - workspace",
    "---",
    "# demo",
    "",
  ].join("\n"), "utf8");
  const manifestPath = join(base, "manifest.json");
  const manifest: TrustManifest = {
    version: 1,
    skills: {
      demo: {
        version: "1.0.0",
        digest: "", // 占位，测试内重算。
        capabilities: { filesystem: ["workspace"], network: [] },
      },
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { root: base, manifestPath };
}

async function updateManifest(
  manifestPath: string,
  update: (entry: TrustManifest["skills"][string]) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TrustManifest;
  update(manifest.skills.demo!);
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
}

/** 重算摘要写入 manifest（通过用例的基线）。 */
async function correctDigest(manifestPath: string, skillsRoot: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readdir } = await import("node:fs/promises");
  const hash = createHash("sha256");
  const dir = join(skillsRoot, "demo");
  const entries = await readdir(dir);
  for (const name of [...entries].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(join(dir, name)));
  }
  const digest = hash.digest("hex");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TrustManifest;
  manifest.skills.demo!.digest = digest;
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return digest;
}

async function useOfficialMetadataNamespace(skillsRoot: string): Promise<void> {
  const path = join(skillsRoot, "demo", "SKILL.md");
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace([
    "version: 1.0.0",
    "capabilities:",
    "  filesystem:",
    "    - workspace",
  ].join("\n"), [
    "metadata:",
    "  dsh:",
    "    version: 1.0.0",
    "    capabilities:",
    "      filesystem:",
    "        - workspace",
  ].join("\n")), "utf8");
}

describe("真实仓库技能清单（SPEC skills.md §8）", () => {
  it("生成器产物与预检一致：skills/trust-manifest.json 全绿", async () => {
    const report = await preflightSkills({
      manifestPath: "skills/trust-manifest.json",
      skillsRoot: "skills",
    });
    expect(report).toEqual({ ok: true, failures: [] });
  });

  it("清单覆盖全部技能目录（无 missing-entry）", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const entries = await readdir("skills", { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const manifest = JSON.parse(await readFile("skills/trust-manifest.json", "utf8")) as TrustManifest;
    for (const name of dirs) {
      expect(manifest.skills[name]).toBeDefined();
      expect(manifest.skills[name]!.version).toBeTruthy();
    }
    expect(dirs.length).toBeGreaterThan(0);
  });
});

function registerIntegrityTests(): void {
  it("通过用例：摘要/版本一致 → ok", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("篡改任一字节 → digest-mismatch 拒绝", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await writeFile(join(root, "skills", "demo", "extra.md"), "tampered", "utf8");
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "digest-mismatch" });
  });

  it("SKILL.md version 与 manifest 不一致 → version-mismatch 拒绝", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await updateManifest(manifestPath, (entry) => { entry.version = "2.0.0"; });
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "version-mismatch" });
  });

  it("官方 metadata.dsh 版本与能力声明 → ok", async () => {
    const { root, manifestPath } = await seeded();
    const skillsRoot = join(root, "skills");
    await useOfficialMetadataNamespace(skillsRoot);
    await correctDigest(manifestPath, skillsRoot);
    const report = await preflightSkills({ manifestPath, skillsRoot });
    expect(report).toEqual({ ok: true, failures: [] });
  });

  it("顶层与 metadata.dsh 双声明 → fail closed", async () => {
    const { root, manifestPath } = await seeded();
    const skillsRoot = join(root, "skills");
    await useOfficialMetadataNamespace(skillsRoot);
    const path = join(skillsRoot, "demo", "SKILL.md");
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace(
      "description: demo skill\nmetadata:",
      "description: demo skill\nversion: 1.0.0\ncapabilities: {}\nmetadata:",
    ), "utf8");
    await correctDigest(manifestPath, skillsRoot);
    const report = await preflightSkills({ manifestPath, skillsRoot });
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "version-mismatch" });
  });
}

function registerCapabilityTests(): void {
  it.each([
    ["少报", {}],
    ["多报", { filesystem: ["workspace"], network: ["example.com"] }],
  ])("manifest capabilities %s → capability-mismatch 拒绝", async (_case, capabilities) => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await updateManifest(manifestPath, (entry) => { entry.capabilities = capabilities; });
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "capability-mismatch" });
  });

  it("SKILL.md capability 类型非法 → capability-mismatch 拒绝", async () => {
    const { root, manifestPath } = await seeded();
    const path = join(root, "skills", "demo", "SKILL.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("  filesystem:\n    - workspace", "  network: example.com"), "utf8");
    await correctDigest(manifestPath, join(root, "skills"));
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "capability-mismatch" });
  });
}

function registerFilesystemTests(): void {
  it("manifest 缺条目 → missing-entry 拒绝", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await mkdir(join(root, "skills", "rogue"));
    await writeFile(join(root, "skills", "rogue", "SKILL.md"), "x", "utf8");
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "rogue", reasonCode: "missing-entry" });
  });

  it("符号链接 → 拒绝（symlink）", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await writeFile(join(root, "skills", "demo", "evil.md"), "x", "utf8");
    await writeFile(join(root, "outside.md"), "outside", "utf8");
    await symlink(join(root, "outside.md"), join(root, "skills", "demo", "link.md"));
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures.some((failure) => failure.name === "demo")).toBe(true);
  });

  it("skills 根目录的符号链接 → 拒绝（symlink）", async () => {
    const { root, manifestPath } = await seeded();
    await correctDigest(manifestPath, join(root, "skills"));
    await writeFile(join(root, "outside-skill.md"), "outside", "utf8");
    await symlink(join(root, "outside-skill.md"), join(root, "skills", "rogue-link.md"));
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "rogue-link.md", reasonCode: "symlink" });
  });

  it("manifest 通配能力声明 → capability-mismatch 拒绝", async () => {
    const { root, manifestPath } = await seeded();
    await updateManifest(manifestPath, (entry) => { entry.capabilities.network = ["*"]; });
    await correctDigest(manifestPath, join(root, "skills"));
    const report = await preflightSkills({ manifestPath, skillsRoot: join(root, "skills") });
    expect(report.failures).toContainEqual({ name: "demo", reasonCode: "capability-mismatch" });
  });
}

function registerManifestFailureTest(): void {
  it("manifest 缺失 → SkillTrustError（fail loud）", async () => {
    const base = await setup();
    await expect(preflightSkills({ manifestPath: join(base, "nope.json"), skillsRoot: join(base, "skills") }))
      .rejects.toThrow(SkillTrustError);
  });
}

describe("preflightSkills", () => {
  registerIntegrityTests();
  registerCapabilityTests();
  registerFilesystemTests();
  registerManifestFailureTest();
});
