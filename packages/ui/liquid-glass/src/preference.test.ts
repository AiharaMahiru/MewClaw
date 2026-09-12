import { describe, expect, it, vi } from "vitest";
import { GlassPreference, parseAccountId } from "./preference.js";

const alice = parseAccountId({ user: { id: "alice" } });
const bob = parseAccountId({ user: { id: "bob" } });
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

describe("个人主题控制面板", () => {
  it("刷新后恢复，其他账号不继承开关", () => {
    const local = storage();
    const a = new GlassPreference(true); a.bind(alice, local); a.setEnabled(false);
    const refreshed = new GlassPreference(true); refreshed.bind(alice, local);
    expect(refreshed.getSnapshot().enabled).toBe(false);
    const b = new GlassPreference(true); b.bind(bob, local);
    expect(b.getSnapshot().enabled).toBe(true);
  });
  it("只采纳当前账号的 storage 通知，清空则恢复默认", () => {
    const preference = new GlassPreference(true); preference.bind(alice, storage());
    preference.acceptStorage("mewclaw.liquid-glass.v1.bob", "off");
    expect(preference.getSnapshot().enabled).toBe(true);
    preference.acceptStorage("mewclaw.liquid-glass.v1.alice", "off");
    expect(preference.getSnapshot().enabled).toBe(false);
    preference.acceptStorage(null, null);
    expect(preference.getSnapshot().enabled).toBe(true);
  });
  it("无效值和存储读写错误不能误报保存成功", () => {
    const local = storage(); local.setItem("mewclaw.liquid-glass.v1.alice", "broken");
    const preference = new GlassPreference(true); preference.bind(alice, local);
    expect(preference.getSnapshot().notice).toContain("无效");
    preference.bind(alice, { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    preference.setEnabled(false);
    expect(preference.getSnapshot()).toMatchObject({ enabled: false, notice: expect.stringContaining("保存失败") });
    preference.bind(alice, { getItem: () => { throw new Error("denied"); }, setItem: () => {} });
    expect(preference.getSnapshot().notice).toContain("无法读取");
  });
  it("身份未就绪时不写入，订阅可独立释放", () => {
    const preference = new GlassPreference(true); const listener = vi.fn();
    const release = preference.subscribe(listener);
    preference.setEnabled(true);
    expect(listener).not.toHaveBeenCalled();
    preference.useSession("身份不可用"); release(); preference.setEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(preference.getSnapshot()).toMatchObject({ loading: false, enabled: false, notice: expect.stringContaining("仅当前页面") });
  });
  it.each([null, {}, { user: {} }, { user: { id: "" } }, { user: { id: "../another" } }, { user: { id: 1 } }])("拒绝非身份协议响应 %j", (input) => {
    expect(() => parseAccountId(input)).toThrow(TypeError);
  });
});
