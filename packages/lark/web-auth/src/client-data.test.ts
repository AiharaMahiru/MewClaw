import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAccountModelProfile,
  decodeAccountModelProfiles,
  deleteAccountModelProfile,
  setAccountModelDefault,
  updateAccountModelProfile,
} from "./client-data.js";

const profile = {
  id: "profile-1",
  displayName: "我的 DeepSeek",
  baseUrl: "https://api.example.test/v1",
  modelIds: ["deepseek-chat", "deepseek-reasoner"],
  defaultModel: "deepseek-chat",
  keyConfigured: true,
  revision: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("账户模型配置数据层", () => {
  it("解码公开模型配置并兼容旧响应缺少默认项", () => {
    const decoded = decodeAccountModelProfiles({ profiles: [profile], defaultProfileId: profile.id });
    expect(decoded).toEqual({ profiles: [profile], defaultProfileId: profile.id });
    expect(JSON.stringify(decoded)).not.toContain("apiKey");

    expect(decodeAccountModelProfiles({ profiles: [profile] }).defaultProfileId).toBeNull();
    expect(() => decodeAccountModelProfiles({ profiles: [profile], defaultProfileId: 1 })).toThrow("invalid response");
  });

  it("创建配置时携带 CSRF、同源凭证和 API Key", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("", { status: 201 }));
    installRequest(request);

    await createAccountModelProfile({
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      modelIds: profile.modelIds,
      defaultModel: profile.defaultModel,
      apiKey: "test-api-key",
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/auth/models");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      modelIds: profile.modelIds,
      defaultModel: profile.defaultModel,
      apiKey: "test-api-key",
    });
  });

  it("编辑时不发送空白 API Key", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    installRequest(request);

    await updateAccountModelProfile(profile.id, {
      expectedRevision: profile.revision,
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      modelIds: profile.modelIds,
      defaultModel: profile.defaultModel,
      apiKey: "   ",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`/auth/models/${profile.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: profile.revision,
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      modelIds: profile.modelIds,
      defaultModel: profile.defaultModel,
    });
  });

  it("删除时提交乐观锁版本", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    installRequest(request);

    await deleteAccountModelProfile(profile.id, profile.revision);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`/auth/models/${profile.id}`);
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: profile.revision });
  });

  it("设为默认项使用独立端点和空对象请求体", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    installRequest(request);

    await setAccountModelDefault(profile.id);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`/auth/models/${profile.id}/default`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it("保留服务端模型配置错误码供界面展示", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "MODEL_PROFILE_CONFLICT" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));
    installRequest(request);

    await expect(setAccountModelDefault(profile.id)).rejects.toThrow("MODEL_PROFILE_CONFLICT");
  });
});

function installRequest(request: typeof fetch): void {
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("document", { cookie: "dsh_csrf=csrf-token" });
}
