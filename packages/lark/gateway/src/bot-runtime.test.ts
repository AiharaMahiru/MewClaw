import { describe, it, expect, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkRunClient } from "dsh-lark-run-client";
import type { CdgBridge } from "dsh-cdg-bridge";
import { startBot, type FleetBot } from "./bot-runtime.js";
const mocks = vi.hoisted(() => ({ roots: [] as Context[], sent: [] as string[] }));
vi.mock("dsh-lark-ws", async original => ({ ...await original<object>(), name: "test-ws", inject: ["credentials"], apply(ctx: Context) { mocks.roots.push(ctx); ctx.emit("lark/connection", { state: "connected" }); } }));
vi.mock("dsh-lark", async original => ({ ...await original<object>(), createLarkApi: (options: { appId: string }) => ({ sendMessage: async () => { mocks.sent.push(options.appId); return "om_test"; }, updateMessage: async () => {} }) }));

describe("真实Cordis多机器人组合", () => {
  it("注册独立事件和凭证Provider，消息仅到对应App，停用后不再发送", async () => {
    const parent = new Context();
    const stateDir = await mkdtemp(join(tmpdir(), "mewclaw-bot-runtime-"));
    const runClient = { submit: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })), claimCronDeliveries: async () => [] } as unknown as LarkRunClient;
    await parent.plugin({ apply(ctx: Context) { ctx.provide("larkRunClient", runClient); ctx.provide("cdgBridge", {} as CdgBridge); } });
    const a: FleetBot = { userId: "11111111-1111-4111-8111-111111111111", id: "22222222-2222-4222-8222-222222222222", appId: "cli_1234567890abcdef", appSecret: "fake-a", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test"], revision: 1 };
    const b = { ...a, userId: "33333333-3333-4333-8333-333333333333", id: "44444444-4444-4444-8444-444444444444", appId: "cli_abcdef1234567890", appSecret: "fake-b" };
    const claim = vi.fn(async (_bot: FleetBot, _scope: unknown, _generation: number) => {});
    const options = { stateDir, uploadsRoot: join(stateDir, "uploads"), maxResourceBytes: 1000, claim };
    const first = startBot(parent, a, options); const second = startBot(parent, b, options);
    try {
      await Promise.all([first.ready, second.ready]);
      await vi.waitFor(() => expect(mocks.roots).toHaveLength(2));
      expect(first.state()).toBe("connected"); expect(second.state()).toBe("connected");
      const [one, two] = mocks.roots;
      expect(one!.root).not.toBe(two!.root); expect(one!.root).not.toBe(parent);
      const message = { eventId: "evt_test", messageId: "om_inbound", userId: "ou_test", chatId: "oc_test", chatType: "p2p", text: "hello", resources: [] };
      one!.emit("lark/message/received", message as never);
      await vi.waitFor(() => expect(runClient.submit).toHaveBeenCalledTimes(1));
      expect(mocks.sent).toEqual([a.appId]);
      expect(claim.mock.calls[0]?.[0]).toMatchObject({ userId: a.userId });
      expect((runClient.submit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].scope).toMatchObject({ tenantId: a.userId, botId: a.appId, deploymentId: a.id });
      await first.stop();
      one!.emit("lark/message/received", { ...message, eventId: "evt_stopped" } as never);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(runClient.submit).toHaveBeenCalledTimes(1);
      two!.emit("lark/message/received", { ...message, eventId: "evt_second" } as never);
      await vi.waitFor(() => expect(runClient.submit).toHaveBeenCalledTimes(2));
      expect(mocks.sent).toContain(b.appId);
    } finally { await first.stop(); await second.stop(); await parent.fiber.dispose(); }
  });
});
