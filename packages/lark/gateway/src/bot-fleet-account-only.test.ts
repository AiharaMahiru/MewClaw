import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCredentials } from "./bot-credentials.js";
import { apply } from "./bot-fleet.js";
import { startBot } from "./bot-runtime.js";

vi.mock("./bot-runtime.js", async importOriginal => ({
  ...await importOriginal<object>(),
  startBot: vi.fn(() => ({ state: () => "connected", stop: vi.fn(async () => {}) })),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("账号配置是唯一机器人来源", () => {
  it("即使宿主保留旧App凭据，也仅按账号清单启动；空清单停止连接", async () => {
    const appId = "cli_1234567890abcdef";
    const bot = { userId: "11111111-1111-4111-8111-111111111111", id: "22222222-2222-4222-8222-222222222222", appId, appSecret: "fake-account-secret", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test"], revision: 1 };
    let bots: typeof bot[] = [];
    const request = vi.fn<typeof fetch>(async (_url, options) => Response.json(options?.method === "POST" ? { ok: true } : { bots }));
    vi.stubGlobal("fetch", request);
    const ctx = new Context();
    const credentials = new BotCredentials(ctx, new Map([["AUTH_PAIRING_TOKEN", "fake-token"], ["LARK_APP_ID", appId], ["LARK_APP_SECRET", "fake-legacy-secret"]]));
    const resolve = vi.spyOn(credentials, "resolve");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      apply(ctx, { authEndpoint: "http://127.0.0.1:13080/internal/feishu-bots", tokenEnv: "AUTH_PAIRING_TOKEN", stateDir: "/tmp/fake-bot-state", uploadsRoot: "/tmp/fake-bot-uploads", pollIntervalMs: 1000 });
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      expect(startBot).not.toHaveBeenCalled();
      bots = [bot];
      await vi.waitFor(() => expect(startBot).toHaveBeenCalledTimes(1), { timeout: 2500 });
      expect(vi.mocked(startBot).mock.calls[0]?.[1]).toEqual(bot);
      expect(resolve.mock.calls.every(([ref]) => ref === "AUTH_PAIRING_TOKEN")).toBe(true);
      const instance = vi.mocked(startBot).mock.results[0]!.value;
      bots = [];
      await vi.waitFor(() => expect(instance.stop).toHaveBeenCalledTimes(1), { timeout: 2500 });
      expect(log.mock.calls.map(([message]) => message)).toEqual([
        "[lark-account-bot-fleet] 账号机器人配置已同步：0 个启用实例",
        "[lark-account-bot-fleet] 账号机器人配置已同步：1 个启用实例",
        "[lark-account-bot-fleet] 账号机器人配置已同步：0 个启用实例",
      ]);
    } finally { await ctx.fiber.dispose(); log.mockRestore(); }
  });
});
