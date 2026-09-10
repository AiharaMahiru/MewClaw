import { describe, it, vi, expect } from "vitest";
import { BotFleet } from "./bot-fleet.js";
import { parseFleetBots, type FleetBot } from "./bot-runtime.js";
const a: FleetBot = { userId: "11111111-1111-4111-8111-111111111111", id: "22222222-2222-4222-8222-222222222222", appId: "cli_1234567890abcdef", appSecret: "fake-secret", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test"], revision: 1 };
describe("多账号机器人实例生命周期", () => {
  it("一次启动失败按间隔重试同版本，不需用户改配置也不高频重启", async () => {
    let now = 0;
    const stop = vi.fn(async () => {});
    const start = vi.fn(() => ({ stop, state: () => "failed" as const }));
    const fleet = new BotFleet(start, 30000, () => now);
    await fleet.reconcile([a]); now = 29999; await fleet.reconcile([a]); expect(start).toHaveBeenCalledTimes(1);
    now = 30000; await fleet.reconcile([a]); expect(start).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(1);
    await fleet.reconcile([a]); expect(start).toHaveBeenCalledTimes(2);
    await fleet.close();
  });
  it("wire拒绝非法URL、目录标识及重复App", () => {
    expect(parseFleetBots({ bots: [a] })).toEqual([a]);
    expect(() => parseFleetBots({ bots: [a, a] })).toThrow();
    expect(() => parseFleetBots({ bots: [{ ...a, id: "../../unsafe" }] })).toThrow();
    expect(() => parseFleetBots({ bots: [{ ...a, domain: "http://localhost" }] })).toThrow();
  });
  it("两个owner不同实例；不重复创建；变更先停旧；关闭只处理个人实例", async () => {
    const events: string[] = [];
    const start = vi.fn((bot: FleetBot) => ({ stop: async () => { events.push(`stop:${bot.userId}:${bot.revision}`); }, state: () => "connected" as const }));
    const fleet = new BotFleet(bot => { events.push(`start:${bot.userId}:${bot.revision}`); return start(bot); });
    const b = { ...a, userId: "33333333-3333-4333-8333-333333333333", id: "44444444-4444-4444-8444-444444444444", appId: "cli_abcdef1234567890" };
    await fleet.reconcile([a, b]); await fleet.reconcile([a, b]);
    expect(start).toHaveBeenCalledTimes(2);
    await fleet.reconcile([{ ...a, revision: 2 }, b]);
    expect(events.slice(-2)).toEqual([`stop:${a.userId}:1`, `start:${a.userId}:2`]);
    await fleet.close(); expect(fleet.instances.size).toBe(0);
  });
});
