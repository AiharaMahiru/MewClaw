/** 无凭据渲染检查：保留账户功能，飞书独立展示并复用当前用户接口。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountIdentity, ReactApi, ResourceState } from "./client-contracts.js";
import { AccountCenterSection } from "./client-account.js";
import { FeishuConnectionsSection } from "./client-feishu.js";

const data = vi.hoisted(() => ({
  identities: { status: "ready", data: [] } as ResourceState<AccountIdentity[]>,
  unlink: vi.fn(async () => {}),
}));
vi.mock("./client-data.js", async (original) => ({
  ...await original<object>(),
  useAccountUser: () => ({ status: "ready", data: { displayName: "测试账户", email: "test@example.com", role: "user", defaultMode: "lightweight" } }),
  useAccountUsage: () => ({ status: "ready", data: { periodStart: "2026-09-01", quota: { monthlyLimitUsd: 10, usedUsd: 1, remainingUsd: 9 }, totals: { calls: 1, totalTokens: 123, inputTokens: 100, outputTokens: 23, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, models: [{ provider: "test", model: "test-model", calls: 1, totalUsd: 1 }] } }),
  useAccountModelProfiles: () => ({ status: "ready", data: { profiles: [], defaultProfileId: null } }),
  useIdentities: () => data.identities,
  unlinkIdentity: data.unlink,
}));
vi.mock("./client-bot-data.js", async original => ({ ...await original<object>(), useAccountBot: () => ({ status: "ready", data: null }) }));

type View = { type: string; props: Record<string, unknown>; children: unknown[] };
const React: ReactApi = {
  createElement(type, props, ...children) {
    return typeof type === "function" ? type(props as never) : { type, props: props ?? {}, children };
  },
  useEffect() {},
  useState<T>(initial: T): [T, (value: T) => void] { return [initial, () => {}]; },
};
function nodes(value: unknown): View[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const view = value as View;
  return [view, ...view.children.flatMap(nodes)];
}
function text(value: unknown): string { return JSON.stringify(value); }
afterEach(() => { vi.unstubAllGlobals(); data.unlink.mockClear(); data.identities = { status: "ready", data: [] }; });

describe("账户与飞书页面拆分", () => {
  it("账户保留模型与安全、使用新模式名称，不重复显示飞书入口", () => {
    const view = AccountCenterSection(React);
    expect(text(view)).toContain("日常助手");
    expect(text(view)).toContain("我的模型");
    expect(text(view)).toContain("安全与登录");
    expect(text(view)).not.toContain("飞书连接");
    expect(text(view)).not.toContain("用户与权限");
    const details = nodes(view).find((node) => node.props.className === "mewclaw-account-model-detail");
    expect(details?.type).toBe("details");
    expect(details?.props.open).toBeUndefined();
  });
  it("独立页面统一管理机器人，保留历史身份但不再引导部署级配对", () => {
    const view = text(FeishuConnectionsSection(React));
    expect(view).toContain("尚未绑定飞书身份");
    expect(view).not.toContain("/login");
    expect(view).not.toContain("部署级机器人");
    expect(view).not.toContain("保持独立运行");
    expect(view).toContain("机器人统一通过此页面管理");
    expect(view).toContain("App Secret");
    expect(view).toContain("保存配置");
    expect(view).toContain("尚未配置个人机器人");
    expect(nodes(FeishuConnectionsSection(React)).filter(node => ["h2", "h3", "button"].includes(node.type)).map(node => node.children.filter(child => typeof child === "string").join(""))).toMatchSnapshot();
  });
  it("读取失败时仍提供刷新", () => {
    data.identities = { status: "error" };
    const view = FeishuConnectionsSection(React);
    expect(text(view)).toContain("读取失败");
    const refresh = nodes(view).find((node) => node.type === "button" && node.children.includes("刷新"));
    expect(refresh?.props.disabled).toBe(false);
  });
  it("解绑仅提交当前展示身份，并缩略其ID", async () => {
    const identity: AccountIdentity = { provider: "feishu", subject: "ou_testing_identity_12345", unionId: null, createdAt: "2026-09-01" };
    data.identities = { status: "ready", data: [identity] };
    vi.stubGlobal("window", { confirm: () => true });
    const view = FeishuConnectionsSection(React);
    expect(text(view)).toContain("ou_tes...2345");
    const button = nodes(view).find((node) => node.type === "button" && node.children.includes("解绑"));
    (button?.props.onClick as () => void)();
    await vi.waitFor(() => expect(data.unlink).toHaveBeenCalledWith(identity));
  });
});
