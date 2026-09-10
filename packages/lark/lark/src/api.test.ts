/**
 * createLarkApi 测试（SPEC lark.md §8）：mock 官方 SDK 传输层，
 * 覆盖成功路径、错误分类、资源上限与品牌化 ID。
 */
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeChatId, makeMessageId, makeUserId } from "dsh-lark-contracts";

import { createLarkApi } from "./api.js";
import { LarkApiError } from "./errors.js";
import { renderMarkdownCard } from "./cards.js";

// SDK mock：所有调用记录到 mocks.*，测试按用例设定返回值。
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  imageCreate: vi.fn(),
  patch: vi.fn(),
  resourceGet: vi.fn(),
  membersGet: vi.fn(),
  tokenInternal: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class MockClient {
    auth = {
      v3: {
        tenantAccessToken: { internal: mocks.tokenInternal },
      },
    };
    im = {
      v1: {
        message: { create: mocks.create, patch: mocks.patch },
        image: { create: mocks.imageCreate },
        messageResource: { get: mocks.resourceGet },
        chatMembers: { get: mocks.membersGet },
      },
    };
  }
  return { Client: MockClient };
});

const api = createLarkApi({ appId: "cli_x", appSecret: "secret", maxResourceBytes: 1024 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendMessage", () => {
  it("文本消息：chat_id 接收 + text 载荷，返回品牌化 messageId", async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: "om_1" } });
    const messageId = await api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "你好" });
    expect(messageId).toBe("om_1");
    expect(mocks.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "你好" }) },
    });
  });

  it("markdown 卡片消息：interactive 载荷", async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: "om_2" } });
    const card = renderMarkdownCard("# 标题");
    await api.sendMessage(makeChatId("oc_1"), { kind: "markdown-card", card });
    const call = mocks.create.mock.calls[0]![0] as { data: { msg_type: string; content: string } };
    expect(call.data.msg_type).toBe("interactive");
    expect(JSON.parse(call.data.content)).toEqual(card);
  });

  it("平台错误码 → 分类错误（令牌过期）", async () => {
    mocks.create.mockResolvedValue({ code: 99991663 });
    await expect(api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "x" }))
      .rejects.toMatchObject({ code: "LARK_TOKEN_FAILED" });
  });

  it("限流错误携带 retry-after", async () => {
    mocks.create.mockResolvedValue({ code: 53001 });
    await expect(api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "x" }))
      .rejects.toMatchObject({ code: "LARK_RATE_LIMITED" });
  });

  it("网络异常（无平台码）→ LARK_NETWORK", async () => {
    mocks.create.mockRejectedValue(new TypeError("fetch failed"));
    await expect(api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "x" }))
      .rejects.toMatchObject({ code: "LARK_NETWORK" });
  });

  it("平台返回无效 message_id 时拒绝跨边界 ID", async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: "om_\n1" } });
    await expect(api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "x" }))
      .rejects.toMatchObject({ code: "LARK_API_FAILED" });
  });
});

describe("sendMessageToUser", () => {
  it("使用 open_id 发送并返回平台校验后的 P2P chatId", async () => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: "om_user", chat_id: "oc_user" } });
    const result = await api.sendMessageToUser(makeUserId("ou_1"), { kind: "text", text: "处理中" });

    expect(result).toEqual({ messageId: "om_user", chatId: "oc_user" });
    expect(mocks.create).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: { receive_id: "ou_1", msg_type: "text", content: JSON.stringify({ text: "处理中" }) },
    });
  });

  it.each([
    { message_id: "om_\nunsafe", chat_id: "oc_user" },
    { message_id: "om_user", chat_id: "oc_\nunsafe" },
    { message_id: "om_user" },
  ])("平台返回非法 message_id/chat_id 时 fail closed", async (data) => {
    mocks.create.mockResolvedValue({ code: 0, data });
    await expect(api.sendMessageToUser(makeUserId("ou_1"), { kind: "text", text: "x" }))
      .rejects.toMatchObject({ code: "LARK_API_FAILED" });
  });
});

describe("图片上传与发送", () => {
  it("上传图片后以标准 image 消息发送", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    mocks.imageCreate.mockResolvedValue({ image_key: "img_v2_abc" });
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: "om_image" } });

    const imageKey = await api.uploadImage(bytes);
    await api.sendMessage(makeChatId("oc_1"), { kind: "image", imageKey });

    expect(mocks.imageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: Buffer.from(bytes) },
    });
    expect(mocks.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_1",
        msg_type: "image",
        content: JSON.stringify({ image_key: "img_v2_abc" }),
      },
    });
  });

  it("无效 image_key 或空图片字节 fail closed", async () => {
    mocks.imageCreate.mockResolvedValue({ image_key: "img_\nunsafe" });
    await expect(api.uploadImage(Uint8Array.from([1]))).rejects.toMatchObject({ code: "LARK_API_FAILED" });
    await expect(api.uploadImage(new Uint8Array())).rejects.toMatchObject({ code: "LARK_RESOURCE_INVALID" });
  });
});

describe("updateMessage", () => {
  it("成功更新消息内容", async () => {
    mocks.patch.mockResolvedValue({ code: 0 });
    await expect(api.updateMessage(makeMessageId("om_1"), { kind: "text", text: "更新" }))
      .resolves.toBeUndefined();
    expect(mocks.patch).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { content: JSON.stringify({ text: "更新" }) },
    });
  });
});

describe("downloadResource", () => {
  it("字节流转为 Web ReadableStream，返回字节数", async () => {
    mocks.resourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from(Buffer.from("abc")),
      headers: { "content-length": "3" },
    });
    const resource = await api.downloadResource(makeMessageId("om_1"), "file_1", "file");
    expect(resource.bytes).toBe(3);
    const reader = resource.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString()).toBe("abc");
  });

  it("content-length 超出上限 → LARK_RESOURCE_INVALID", async () => {
    mocks.resourceGet.mockResolvedValue({
      getReadableStream: () => Readable.from(Buffer.alloc(2048)),
      headers: { "content-length": "2048" },
    });
    await expect(api.downloadResource(makeMessageId("om_1"), "file_1", "file"))
      .rejects.toMatchObject({ code: "LARK_RESOURCE_INVALID" });
  });
});

describe("getChatMembers", () => {
  it("成员映射为品牌化 openId", async () => {
    mocks.membersGet.mockResolvedValue({
      code: 0,
      data: { items: [{ member_id: "ou_1", name: "张三" }, { member_id: "ou_2" }] },
    });
    const members = await api.getChatMembers(makeChatId("oc_1"));
    expect(members).toEqual([{ openId: "ou_1", name: "张三" }, { openId: "ou_2" }]);
  });

  it("跳过平台返回的非法成员 ID", async () => {
    mocks.membersGet.mockResolvedValue({
      code: 0,
      data: { items: [{ member_id: "ou_1" }, { member_id: "ou_\n2" }, { member_id: "o".repeat(257) }] },
    });
    await expect(api.getChatMembers(makeChatId("oc_1"))).resolves.toEqual([{ openId: "ou_1" }]);
  });
});

describe("getToken", () => {
  it("返回令牌与过期时间", async () => {
    mocks.tokenInternal.mockResolvedValue({ code: 0, data: { tenant_access_token: "t-abc", expire: 7200 } });
    const token = await api.getToken();
    expect(token.token).toBe("t-abc");
    expect(token.expiresAtMs).toBeGreaterThan(Date.now() + 7000 * 1000);
  });

  it("令牌获取失败 → LARK_AUTH_FAILED", async () => {
    mocks.tokenInternal.mockResolvedValue({ code: 99991665 });
    await expect(api.getToken()).rejects.toMatchObject({ code: "LARK_AUTH_FAILED" });
  });
});

describe("错误透传", () => {
  it("已是 LarkApiError 原样透传", async () => {
    const failure = new LarkApiError("LARK_PERMISSION_DENIED", "无权限");
    mocks.create.mockRejectedValue(failure);
    await expect(api.sendMessage(makeChatId("oc_1"), { kind: "text", text: "x" }))
      .rejects.toBe(failure);
  });
});
