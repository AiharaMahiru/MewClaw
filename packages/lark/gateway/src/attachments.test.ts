/**
 * 网关附件落盘与暂存测试（SPEC uploads.md §6 / lark-gateway §6）：
 * 下载流落盘（大小上限/SHA-256/storageKey 形态）、CDG 探测、
 * 暂存 TTL/上限/认领即清除。
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, scopeKey, type Scope } from "dsh-lark-contracts";

import { GatewayAttachments } from "./attachments.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-lark-gw-att-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

function streamOf(text: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([new TextEncoder().encode(text)]));
}

function streamOfChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(chunks.map((chunk) => new TextEncoder().encode(chunk))));
}

describe("GatewayAttachments：保存", () => {
  it("save：落 .uploads/<scopeKey>/<uuid>-<sha><ext> 并返回描述", async () => {
    const store = new GatewayAttachments({
      uploadsRoot: root,
      cdgBridge: { inspect: async () => false, decrypt: async () => undefined },
    });
    const attachment = await store.save(scope, { key: "file_1", fileName: "notes.md" }, streamOf("# 内容"));
    expect(attachment.fileName).toBe("notes.md");
    expect(attachment.encryption).toBe("none");
    expect(attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment.storageKey).toMatch(new RegExp(`^${scopeKey(scope)}/[0-9a-f-]{36}-[a-f0-9]{64}\\.md$`));
    const file = join(root, attachment.storageKey);
    expect(await readFile(file, "utf8")).toBe("# 内容");
  });
});

describe("GatewayAttachments：限制与探测", () => {
  it("非法资源限制在构造时 fail loud", () => {
    expect(() => new GatewayAttachments({ uploadsRoot: root, maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => new GatewayAttachments({ uploadsRoot: root, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => new GatewayAttachments({ uploadsRoot: root, maxPending: 0 })).toThrow(/maxPending/);
  });

  it("大小上限：超限抛错且不留半文件", async () => {
    const store = new GatewayAttachments({
      uploadsRoot: root,
      maxBytes: 8,
      cdgBridge: { inspect: async () => false, decrypt: async () => undefined },
    });
    await expect(store.save(scope, { key: "f", fileName: "big.txt" }, streamOf("0123456789")))
      .rejects.toThrow(/大小上限/);
    // 无文件残留（临时文件已随写入销毁）。
    await expect(readdir(join(root, scopeKey(scope)))).resolves.toEqual([]);
  });

  it("后续数据块超限时也清理已经写入的临时文件", async () => {
    const store = new GatewayAttachments({
      uploadsRoot: root,
      maxBytes: 8,
      cdgBridge: { inspect: async () => false, decrypt: async () => undefined },
    });
    await expect(store.save(scope, { key: "f", fileName: "big.txt" }, streamOfChunks(["1234", "56789"])))
      .rejects.toThrow(/大小上限/);
    await expect(readdir(join(root, scopeKey(scope)))).resolves.toEqual([]);
  });

  it("CDG 探测：桥接判定加密标记", async () => {
    const store = new GatewayAttachments({
      uploadsRoot: root,
      cdgBridge: { inspect: async () => true, decrypt: async () => undefined },
    });
    const attachment = await store.save(scope, { key: "f", fileName: "enc.dat" }, streamOf("x"));
    expect(attachment.encryption).toBe("cdg");
  });

  it("无桥接或探测失败：拒绝附件且清理临时文件", async () => {
    const noBridge = new GatewayAttachments({ uploadsRoot: root });
    await expect(noBridge.save(scope, { key: "f", fileName: "unknown.dat" }, streamOf("x")))
      .rejects.toThrow(/CDG/);
    expect(await readdir(join(root, scopeKey(scope)))).toEqual([]);

    const inspect = vi.fn(async () => { throw new Error("inspect unavailable"); });
    const unavailable = new GatewayAttachments({
      uploadsRoot: root,
      cdgBridge: { inspect, decrypt: async () => undefined },
    });
    await expect(unavailable.save(scope, { key: "f", fileName: "unknown.dat" }, streamOf("y")))
      .rejects.toThrow(/inspect unavailable/);
    expect(await readdir(join(root, scopeKey(scope)))).toEqual([]);
  });
});

describe("GatewayAttachments：暂存", () => {
  it("暂存：TTL 过期和上限淘汰会清理未认领源文件，认领即取走", async () => {
    const store = new GatewayAttachments({
      uploadsRoot: root,
      ttlMs: 50,
      maxPending: 2,
      cdgBridge: { inspect: async () => false, decrypt: async () => undefined },
    });
    const a1 = await store.save(scope, { key: "f", fileName: "1.txt" }, streamOf("1"));
    const a2 = await store.save(scope, { key: "f", fileName: "2.txt" }, streamOf("2"));
    const a3 = await store.save(scope, { key: "f", fileName: "3.txt" }, streamOf("3"));
    await store.stage(scope, [a1, a2, a3]);

    // 上限 2：最旧的 a1 被丢弃，且没有运行会再引用它。
    await expect(readFile(join(root, a1.storageKey))).rejects.toThrow();
    const claimed = await store.claim(scope);
    expect(claimed.map((item) => item.fileName)).toEqual(["2.txt", "3.txt"]);
    // 认领后清空。
    await expect(store.claim(scope)).resolves.toEqual([]);

    // TTL 过期。
    const a4 = await store.save(scope, { key: "f", fileName: "4.txt" }, streamOf("4"));
    await store.stage(scope, [a4]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(store.claim(scope)).resolves.toEqual([]);
    await expect(readFile(join(root, a4.storageKey))).rejects.toThrow();
  });
});
