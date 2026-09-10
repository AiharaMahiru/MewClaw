/**
 * 交付物收集测试（SPEC uploads.md §2 collect）：顶层扫描、排除与有界、
 * 运行前快照、差异收集、受限图片读取与事件写入（service 层）。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  scopeKey,
  type Scope,
} from "dsh-lark-contracts";

import {
  collectArtifacts,
  MAX_ARTIFACT_BYTES,
  readImageArtifact,
  snapshotArtifacts,
} from "./artifacts.js";

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("u"),
  conversationId: makeConversationId("oc_1"),
};

let workspaceRoot: string;
let workspace: string;
const tempDirs: string[] = [];

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "dsh-artifacts-"));
  workspace = join(workspaceRoot, scopeKey(scope));
  await mkdir(workspace, { recursive: true });
  tempDirs.push(workspaceRoot);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("collectArtifacts", () => {
  it("文件交付物：digest/bytes/name 正确；空文件跳过", async () => {
    const baseline = await snapshotArtifacts(workspace);
    await writeFile(join(workspace, "report.md"), "hello 产物", "utf8");
    await writeFile(join(workspace, "empty.txt"), "", "utf8");
    const artifacts = await collectArtifacts(scope, workspace, baseline);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;
    expect(artifact.name).toBe("report.md");
    expect(artifact.bytes).toBe(Buffer.byteLength("hello 产物"));
    expect(artifact.digest).toBe(createHash("sha256").update("hello 产物").digest("hex"));
    expect(artifact.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.scope).toEqual(scope);
  });

  it("目录永不作为交付物", async () => {
    const baseline = await snapshotArtifacts(workspace);
    await mkdir(join(workspace, "bundle", "nested"), { recursive: true });
    await writeFile(join(workspace, "bundle", "a.txt"), "aaa", "utf8");
    await writeFile(join(workspace, "bundle", "nested", "b.txt"), "bbb", "utf8");
    await expect(collectArtifacts(scope, workspace, baseline)).resolves.toEqual([]);
  });

  it("排除：物化输入目录 uploads/ 与点前缀条目不收集", async () => {
    const baseline = await snapshotArtifacts(workspace);
    await mkdir(join(workspace, "uploads"), { recursive: true });
    await writeFile(join(workspace, "uploads", "input.bin"), "input", "utf8");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".hidden"), "x", "utf8");
    await writeFile(join(workspace, "real.txt"), "y", "utf8");
    const artifacts = await collectArtifacts(scope, workspace, baseline);
    expect(artifacts.map((item) => item.name)).toEqual(["real.txt"]);
  });

  it("有界：超 30 MiB 文件跳过；条数封顶 10（按名称排序取前 10）", async () => {
    const baseline = await snapshotArtifacts(workspace);
    await writeFile(join(workspace, "big.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(workspace, `f${String(index).padStart(2, "0")}.txt`), String(index), "utf8");
    }
    const artifacts = await collectArtifacts(scope, workspace, baseline);
    expect(artifacts).toHaveLength(10);
    expect(artifacts[0]!.name).toBe("f00.txt");
    expect(artifacts.some((item) => item.name === "big.bin")).toBe(false);
  });

  it("旧文件不重复交付；同名内容变化后才再次交付", async () => {
    await writeFile(join(workspace, "generated-old.png"), "old", "utf8");
    const baseline = await snapshotArtifacts(workspace);
    await writeFile(join(workspace, "generated-new.png"), "new", "utf8");
    expect((await collectArtifacts(scope, workspace, baseline)).map((item) => item.name))
      .toEqual(["generated-new.png"]);

    await writeFile(join(workspace, "generated-old.png"), "changed", "utf8");
    expect((await collectArtifacts(scope, workspace, baseline)).map((item) => item.name))
      .toEqual(["generated-new.png", "generated-old.png"]);
  });

  it("工作区不存在 = 无交付物（不抛错）", async () => {
    const ghost = join(workspace, "ghost");
    expect(await collectArtifacts(scope, ghost, await snapshotArtifacts(ghost))).toEqual([]);
  });

  it("只读取完整匹配的当前 Scope 图片 artifact", async () => {
    const baseline = await snapshotArtifacts(workspace);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzYQAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(workspace, "generated-image.png"), png);
    const artifact = (await collectArtifacts(scope, workspace, baseline))[0]!;

    await expect(readImageArtifact({ ...artifact, workspaceRoot })).resolves.toMatchObject({
      mimeType: "image/png",
      bytes: png,
    });
    await expect(readImageArtifact({ ...artifact, workspaceRoot, name: "../escape.png" })).resolves.toBeUndefined();
    await expect(readImageArtifact({ ...artifact, workspaceRoot, digest: "0".repeat(64) })).resolves.toBeUndefined();
    await expect(readImageArtifact({
      ...artifact,
      workspaceRoot,
      scope: { ...scope, conversationId: makeConversationId("oc_other") },
    })).resolves.toBeUndefined();

    const textBaseline = await snapshotArtifacts(workspace);
    await writeFile(join(workspace, "fake.png"), "not an image", "utf8");
    const textArtifact = (await collectArtifacts(scope, workspace, textBaseline))[0]!;
    await expect(readImageArtifact({ ...textArtifact, workspaceRoot })).resolves.toBeUndefined();
  });
});

describe("LarkUploads.collect（service 层）", () => {
  it("收集结果逐条写 lark/artifact/created；收集抛错只告警不抛", async () => {
    const { apply } = await import("./index.js");
    const appended: Array<{ type: string; data: unknown }> = [];
    const warns: string[] = [];
    const ctx = {
      knowledge: {},
      cdgBridge: undefined,
      larkVision: undefined,
      logger: { warn: (message: string) => warns.push(message), error: vi.fn() },
      provide: vi.fn(),
    };
    apply(ctx as never, { uploadsRoot: workspace });
    const service = (ctx.provide as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      snapshot: (input: { workspace: string }) => Promise<unknown>;
      collect: (input: { scope: Scope; session: { append: (type: string, data: unknown) => void }; workspace: string; baseline: unknown }) => Promise<void>;
    };
    const session = { append: (type: string, data: unknown) => appended.push({ type, data }) };
    const baseline = await service.snapshot({ workspace });
    await writeFile(join(workspace, "out.txt"), "交付", "utf8");
    await service.collect({ scope, session, workspace, baseline });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: "lark/artifact/created", data: { name: "out.txt" } });

    // 告警分支：workspace 是文件路径 → readdir 抛 ENOTDIR（非 ENOENT）→ 只告警不抛。
    appended.length = 0;
    const locked = join(workspace, "out.txt");
    await expect(service.collect({ scope, session, workspace: locked, baseline })).resolves.toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });
});
