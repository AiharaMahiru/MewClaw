/**
 * dsh-lark-uploads prepare 测试：统一内容检测（无扩展名图片 → 视觉；
 * 文本 → 有界内容块；未知二进制 → 明确类型）、摄入路径（有界等待/成功
 * 与失败块）、检索候选块、附件路径块、边界警示、lark/run/context 先落盘。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, scopeKey, type RunAttachment, type Scope } from "dsh-lark-contracts";
import type { LarkVision } from "dsh-lark-vision";
import type { Knowledge, KnowledgeHit } from "dsh-knowledge";

import { apply, type LarkUploads } from "./index.js";

let uploadsRoot: string;
let workspace: string;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-lark-prepare-"));
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

const CONTENT = "# 手册内容\n\n这是附件文本。";

function attachmentOf(): RunAttachment {
  const sha = createHash("sha256").update(CONTENT).digest("hex");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "manual.md",
    mimeType: "text/markdown",
    sha256: sha,
    size: Buffer.byteLength(CONTENT),
    encryption: "none",
    storageKey: `${scopeKey(scope)}/11111111-1111-4111-8111-111111111111-${sha}.md`,
  };
}

async function seed(attachment: RunAttachment, content: string = CONTENT): Promise<void> {
  const dir = join(uploadsRoot, scopeKey(scope));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, attachment.storageKey.split("/")[1]!), content, "utf8");
}

/** 在 .uploads 落真实图片附件（sharp 生成，无扩展名 + octet-stream 声明）。 */
async function seedImageAttachment(): Promise<{ attachment: RunAttachment; bytes: Buffer }> {
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  const sha = createHash("sha256").update(bytes).digest("hex");
  const attachment: RunAttachment = {
    id: "44444444-4444-4444-8444-444444444444",
    fileName: "image",
    mimeType: "application/octet-stream",
    sha256: sha,
    size: bytes.length,
    encryption: "none",
    storageKey: `${scopeKey(scope)}/44444444-4444-4444-8444-444444444444-${sha}`,
  };
  const dir = join(uploadsRoot, scopeKey(scope));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, attachment.storageKey.split("/")[1]!), bytes);
  return { attachment, bytes };
}

function makeHit(): KnowledgeHit {
  return {
    docId: "22222222-2222-4222-8222-222222222222" as never,
    documentKey: "notes",
    name: "notes.md",
    version: 1,
    visibility: "user_private",
    chunk: 0,
    text: "知识片段",
    score: 0.8,
    citation: { source: "x", snippet: "知识片段", score: 0.8 },
  };
}

/** 组装插件：mock knowledge/vision/cdgBridge（无 cdgBridge = 明文语义）。 */
function makeUploads(knowledge: Partial<Knowledge>, vision?: LarkVision, cdgBridge?: unknown): LarkUploads {
  const ctx = {
    knowledge,
    ...(vision ? { larkVision: vision } : {}),
    ...(cdgBridge ? { cdgBridge } : {}),
    provide: vi.fn((_name: string, value: unknown) => { provided = value; }),
    logger: { warn: vi.fn() },
  };
  let provided: unknown;
  apply(ctx as never, { uploadsRoot });
  return provided as LarkUploads;
}

describe("dsh-lark-uploads.prepare 内容检测", () => {
  it("非法输入预算在服务注册前 fail loud", () => {
    const ctx = { knowledge: {}, provide: vi.fn(), logger: { warn: vi.fn() } };
    expect(() => apply(ctx as never, { uploadsRoot, maxTextFileBytes: 0 })).toThrow(/maxTextFileBytes/);
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it("无扩展名图片（octet-stream 声明）：按真实内容进入视觉分析（PNG 统一解码）", async () => {
    const { attachment, bytes } = await seedImageAttachment();
    const analyze = vi.fn(async ({ dataUrl }: { dataUrl: string }) => {
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
      const decoded = Buffer.from(dataUrl.split(",")[1]!, "base64");
      expect(decoded.equals(bytes)).toBe(true);
      return "<visual_analysis>\n描述：已识别图片\n</visual_analysis>";
    });
    const uploads = makeUploads({}, { available: () => true, analyze });

    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "描述图片",
      attachments: [attachment],
      autoRetrieve: false,
    });

    expect(analyze).toHaveBeenCalledOnce();
    expect(blocks.join("\n")).toContain("描述：已识别图片");
  });

  it("图片 + 视觉不可用：fail closed 降级块", async () => {
    const { attachment } = await seedImageAttachment();
    const uploads = makeUploads({}, { available: () => false, analyze: vi.fn() });
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "描述图片",
      attachments: [attachment],
      autoRetrieve: false,
    });
    expect(blocks.join("\n")).toContain("图片无法分析（视觉模型不可用）");
  });

  it("文本附件注入有界内容块（带来源与 MIME）", async () => {
    const attachment = attachmentOf();
    await seed(attachment);
    const uploads = makeUploads({ retrieve: vi.fn(async () => []) });
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "总结这个文件",
      attachments: [attachment],
    });
    const joined = blocks.join("\n");
    expect(joined).toContain("<attachment_content>");
    expect(joined).toContain("来源：manual.md（text/markdown）");
    expect(joined).toContain("这是附件文本。");
  });

  it("未知二进制附件：明确类型与限制，不猜测加密/损坏", async () => {
    // 普通 zip（非 Office）→ binary。
    const bytes = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x01, 0x00]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const attachment: RunAttachment = {
      ...attachmentOf(),
      id: "55555555-5555-4555-8555-555555555555",
      fileName: "bundle",
      mimeType: "application/octet-stream",
      sha256: sha,
      size: bytes.length,
      storageKey: `${scopeKey(scope)}/55555555-5555-4555-8555-555555555555-${sha}`,
    };
    const dir = join(uploadsRoot, scopeKey(scope));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${attachment.id}-${sha}`), bytes);
    const uploads = makeUploads({ retrieve: vi.fn(async () => []) });
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "看看这个文件",
      attachments: [attachment],
    });
    const joined = blocks.join("\n");
    expect(joined).toContain("<attachment_content>");
    expect(joined).toContain("类型：application/zip（.zip）");
    expect(joined).toContain("暂无文本解析器");
    expect(joined).not.toMatch(/加密|损坏/);
  });

  it("CDG 加密图片：先解密再按明文识别并进入视觉分析", async () => {
    const bytes = await sharp({
      create: { width: 6, height: 6, channels: 3, background: { r: 0, g: 128, b: 255 } },
    }).png().toBuffer();
    const sha = createHash("sha256").update(bytes).digest("hex");
    const attachment: RunAttachment = {
      id: "77777777-7777-4777-8777-777777777777",
      fileName: "secret.png",
      mimeType: "application/octet-stream",
      sha256: sha,
      size: bytes.length,
      encryption: "cdg",
      storageKey: `${scopeKey(scope)}/77777777-7777-4777-8777-777777777777-${sha}`,
    };
    const dir = join(uploadsRoot, scopeKey(scope));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${attachment.id}-${sha}`), bytes);
    const decrypt = async (_source: string, destination: string) => {
      await writeFile(destination, bytes);
    };
    const analyze = vi.fn(async ({ dataUrl }: { dataUrl: string }) => {
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
      return "<visual_analysis>\n描述：CDG 解密后识别\n</visual_analysis>";
    });
    const uploads = makeUploads(
      {},
      { available: () => true, analyze },
      { inspect: async () => true, decrypt },
    );
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "描述图片",
      attachments: [attachment],
      autoRetrieve: false,
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(blocks.join("\n")).toContain("CDG 解密后识别");
  });
});

describe("dsh-lark-uploads.prepare 摄入", () => {
  it("摄入意图：物化 + 提取 + 摄入成功块 + 事件先落盘", async () => {
    const attachment = attachmentOf();
    await seed(attachment);
    const appended: Array<{ type: string; payload: { blocks: string[] } }> = [];
    const session = { append: vi.fn((type: string, payload: { blocks: string[] }) => { appended.push({ type, payload }); }) };
    const knowledge = {
      ingest: vi.fn(async () => ({ runId: "r1", status: "processing" as const })),
      ingestionRun: vi.fn(async () => ({ runId: "r1", status: "completed" as const, documentId: "d1", errorCode: null })),
    };
    const uploads = makeUploads(knowledge as never);

    const { blocks } = await uploads.prepare({
      scope,
      session: session as never,
      workspace,
      message: "把这个文件添加到知识库",
      attachments: [attachment],
    });

    expect(knowledge.ingest).toHaveBeenCalledWith(scope, expect.objectContaining({
      documentKey: attachment.sha256,
      sourceMime: "text/markdown",
      sourceName: "manual.md",
    }), "user_private");
    // 摄入源写回 .uploads 归属目录（重索引原始源语义）。
    const sourcePath = (knowledge.ingest as ReturnType<typeof vi.fn>).mock.calls[0]![1].sourcePath as string;
    expect(sourcePath.startsWith(join(uploadsRoot, scopeKey(scope)))).toBe(true);

    expect(blocks.join("\n")).toContain("<knowledge_ingestion>");
    expect(blocks.join("\n")).toContain("stored=1");
    expect(blocks.join("\n")).toContain("<authorized_attachments>");
    expect(blocks.at(-1)).toContain("不可信数据");
    // 模型可见 ⟺ 已落盘：块先写事件。
    expect(appended).toEqual([{ type: "lark/run/context", payload: { scope, blocks } }]);
  });

  it("摄入任务失败：失败块而非抛错（运行继续）", async () => {
    const attachment = attachmentOf();
    await seed(attachment);
    const knowledge = {
      ingest: vi.fn(async () => ({ runId: "r1", status: "processing" as const })),
      ingestionRun: vi.fn(async () => ({ runId: "r1", status: "failed" as const, errorCode: "EMBEDDING_FAILED", documentId: null })),
    };
    const uploads = makeUploads(knowledge as never);
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "请把这个文件添加到知识库",
      attachments: [attachment],
    });
    expect(blocks.join("\n")).toContain("failed=EMBEDDING_FAILED");
    expect(blocks.join("\n")).toContain("stored=0");
  });

  it("未支持二进制 + 摄入意图：UNSUPPORTED_MIME 失败块（明确类型，不误称）", async () => {
    const bytes = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x01, 0x00]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const attachment: RunAttachment = {
      ...attachmentOf(),
      id: "66666666-6666-4666-8666-666666666666",
      fileName: "bundle",
      mimeType: "application/octet-stream",
      sha256: sha,
      size: bytes.length,
      storageKey: `${scopeKey(scope)}/66666666-6666-4666-8666-666666666666-${sha}`,
    };
    const dir = join(uploadsRoot, scopeKey(scope));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${attachment.id}-${sha}`), bytes);
    const knowledge = { ingest: vi.fn(), ingestionRun: vi.fn() };
    const uploads = makeUploads(knowledge as never);
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "把这个文件添加到知识库",
      attachments: [attachment],
    });
    expect(knowledge.ingest).not.toHaveBeenCalled();
    expect(blocks.join("\n")).toContain("failed=UNSUPPORTED_MIME");
    expect(blocks.join("\n")).toContain("stored=0");
    expect(blocks.join("\n")).toContain("暂无文本解析器");
  });
});

describe("dsh-lark-uploads.prepare 检索", () => {
  it("无意图：检索候选块 + 附件路径块；不写摄入块", async () => {
    const attachment = attachmentOf();
    await seed(attachment);
    const knowledge = {
      retrieve: vi.fn(async () => [makeHit()]),
      ingest: vi.fn(),
    };
    const uploads = makeUploads(knowledge as never);
    const { blocks } = await uploads.prepare({
      scope,
      session: { append: vi.fn() } as never,
      workspace,
      message: "帮我总结这个附件",
      attachments: [attachment],
    });
    expect(knowledge.ingest).not.toHaveBeenCalled();
    expect(knowledge.retrieve).toHaveBeenCalledWith(scope, "帮我总结这个附件");
    expect(blocks.join("\n")).toContain("notes.md#chunk-0");
    expect(blocks.join("\n")).toContain("<authorized_attachments>");
  });
});
