/**
 * 物化测试：scope 归属（storageKey 前缀）、路径逃逸、摘要不符、
 * CDG 解密路径、工作区包含。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, scopeKey, type RunAttachment, type Scope } from "dsh-lark-contracts";

import { materializeAttachment } from "./materialize.js";

let uploadsRoot: string;
let workspace: string;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-lark-upload-"));
  uploadsRoot = join(base, ".uploads");
  workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
});
afterEach(async () => {
  await rm(join(uploadsRoot, ".."), { recursive: true, force: true });
});

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

const CONTENT = "# 附件内容";

function attachmentOf(overrides: Partial<RunAttachment> = {}): RunAttachment {
  const sha = createHash("sha256").update(CONTENT).digest("hex");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "notes.md",
    mimeType: "text/markdown",
    sha256: sha,
    size: Buffer.byteLength(CONTENT),
    encryption: "none",
    storageKey: `${scopeKey(scope)}/11111111-1111-4111-8111-111111111111-${sha}.md`,
    ...overrides,
  };
}

/** 在 .uploads 落一个真实源文件（网关落盘形态）。 */
async function seedSource(attachment: RunAttachment, content: string = CONTENT): Promise<void> {
  const dir = join(uploadsRoot, scopeKey(scope));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, attachment.storageKey.split("/")[1]!), content, "utf8");
}

describe("materializeAttachment", () => {
  it("物化成功：落工作区 uploads/<id>/<name>", async () => {
    const attachment = attachmentOf();
    await seedSource(attachment);
    const result = await materializeAttachment({ uploadsRoot }, scope, attachment, workspace);
    expect(result.path).toBe(join(workspace, "uploads", attachment.id, "notes.md"));
  });

  it("直接调用时也拒绝非法大小预算", async () => {
    await expect(materializeAttachment({ uploadsRoot, maxBytes: 0 }, scope, attachmentOf(), workspace))
      .rejects.toThrow(/大小上限/);
  });

  it("storageKey 不带本 scope 前缀 → 拒绝", async () => {
    const other: Scope = { ...scope, conversationId: makeConversationId("oc_2") };
    const attachment = attachmentOf({ storageKey: `${scopeKey(other)}/x-${"a".repeat(64)}.md` });
    await expect(materializeAttachment({ uploadsRoot }, scope, attachment, workspace))
      .rejects.toThrow(/不属于当前 scope/);
  });

  it("摘要不符 → 拒绝", async () => {
    const attachment = attachmentOf({ sha256: "b".repeat(64) });
    await seedSource(attachment);
    await expect(materializeAttachment({ uploadsRoot }, scope, attachment, workspace))
      .rejects.toThrow(/摘要与声明不符/);
  });

  it("源缺失 → 拒绝；CDG 加密但无桥接 → 拒绝", async () => {
    const missing = attachmentOf();
    await expect(materializeAttachment({ uploadsRoot }, scope, missing, workspace))
      .rejects.toThrow(/不是常规文件|不存在|ENOENT/i);

    const encrypted = attachmentOf({ encryption: "cdg" });
    await seedSource(encrypted);
    await expect(materializeAttachment({ uploadsRoot }, scope, encrypted, workspace))
      .rejects.toThrow(/CDG 加密但桥接未配置/);
  });

  it("CDG 解密路径：调用桥接 decrypt 落工作区", async () => {
    // sha 是存储（加密）字节的摘要——网关保存时按落盘字节计算。
    const encryptedBytes = "encrypted-bytes";
    const sha = createHash("sha256").update(encryptedBytes).digest("hex");
    const encrypted: RunAttachment = {
      ...attachmentOf(),
      id: "22222222-2222-4222-8222-222222222222",
      encryption: "cdg",
      sha256: sha,
      size: Buffer.byteLength(encryptedBytes),
      storageKey: `${scopeKey(scope)}/22222222-2222-4222-8222-222222222222-${sha}.dat`,
    };
    await seedSource(encrypted, encryptedBytes);
    const decrypt = async (_source: string, destination: string) => {
      await writeFile(destination, CONTENT, "utf8");
    };
    const cdgBridge = { inspect: async () => true, decrypt };
    const result = await materializeAttachment(
      { uploadsRoot, cdgBridge },
      scope,
      encrypted,
      workspace,
    );
    expect(result.path).toBe(join(workspace, "uploads", encrypted.id, "notes.md"));
  });
});
