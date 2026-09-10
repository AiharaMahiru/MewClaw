import { describe, expect, it } from "vitest";

import { loginPage, messagePage, pairPage, resetPage } from "./login-page.js";

describe("auth pages", () => {
  it("uses the official Web visual system across all page types", () => {
    const pages = [loginPage(), pairPage("pair-token"), resetPage("reset-token"), messagePage("提示", "完成").html];
    for (const page of pages) {
      expect(page).toContain("color-scheme: light dark");
      expect(page).toContain("--dsw-alias-bg-base: #eef4f5");
      expect(page).toContain("@media (prefers-color-scheme: dark)");
      expect(page).toContain("class=\"auth-card\"");
      expect(page).toContain("MewClaw Harness");
      expect(page).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
      expect(page).toContain('viewBox="0 0 512 512"');
      expect(page).toContain('shape-rendering="geometricPrecision"');
      expect(page).toContain("mewclaw-mark-ink");
      expect(page).toContain("mewclaw-mark-cutout");
      expect(page).toContain("--mewclaw-mark-bg: #181717");
      expect(page).toContain("class=\"auth-shell\"");
      expect(page).toContain("class=\"auth-header\"");
      expect(page).toContain("viewport");
      expect(page).toContain('class="window-bar"');
      expect(page).toContain('class="auth-boot"');
      expect(page).toContain('sessionStorage.getItem("mewclaw.boot.v1")');
      expect(page).toContain("backdrop-filter: blur(28px)");
      expect(page).toContain("pointer-events: none");
    }
  });

  it("keeps email login and pairing controls available", () => {
    const login = loginPage();
    expect(login).toContain("/auth/register");
    expect(login).toContain("/auth/login");
    expect(login).toContain("x-csrf-token");
    expect(login).toContain('<html lang="zh-CN"><head>');
    expect(login).toContain(".auth-page { position: relative; min-height: 100dvh;");
    expect(login).toContain("width: min(438px, 100%);");
    expect(login).toContain("@media (max-width: 520px)");
    expect(login).toContain('id="password-toggle"');
    expect(login).toContain('aria-label="显示密码"');
    expect(login).not.toContain("让智能协作");
    expect(login).not.toContain("工作区数据相互隔离");
    expect(login).not.toContain("安全访问");
    expect(login).toContain("prefers-reduced-motion");
    expect(login).not.toContain("官方 dsh Web");
    expect(login).not.toContain("dsh Web");
    expect(login).not.toContain("使用飞书快捷注册 / 登录");
    expect(login).not.toContain("/auth/feishu/start");

    const guestPair = pairPage("pair-token");
    expect(guestPair).toContain("/auth/pair/login");
    expect(guestPair).toContain("/auth/pair/register");
    expect(guestPair).toContain('const pairToken = "pair-token"');
    expect(guestPair).toContain("已有账户请登录");
    expect(guestPair).toContain("ACCOUNT_EXISTS");
    expect(guestPair).toContain("PAIRING_INVALID");

    const currentPair = pairPage("pair-token", { email: "user@example.com", displayName: "User" });
    expect(currentPair).toContain("确认绑定飞书账户");
    expect(currentPair).toContain("/auth/pair/confirm");
    expect(currentPair).toContain("当前已登录 Web 账户");
    expect(currentPair).toContain("pair-actions");
    expect(currentPair).toContain("gap: 14px");
    expect(currentPair).toContain("切换到已绑定 Web 账户");
    expect(currentPair).toContain("switch=1");

    const switchPair = pairPage("pair-token", { email: "user@example.com", displayName: "User" }, true);
    expect(switchPair).toContain("已有账户请登录");
    expect(switchPair).not.toContain("确认绑定飞书账户");
  });

  it("escapes user-facing page values and script tokens", () => {
    const page = messagePage("<标题>", "<消息> & 说明").html;
    expect(page).toContain("&lt;标题&gt;");
    expect(page).toContain("&lt;消息&gt; &amp; 说明");
    expect(page).not.toContain("<h1 class=\"auth-title\"><标题>");

    const pair = pairPage("</script><script>alert(1)</script>");
    expect(pair).not.toContain("</script><script>alert(1)</script>");
    expect(pair).toContain("\\u003c/script\\u003e");

    const reset = resetPage("opaque-token");
    expect(reset).toContain("opaque-token");
    expect(reset).toContain("/auth/password/reset");
  });

});
