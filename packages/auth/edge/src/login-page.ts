const AUTH_STYLES = `
:root {
  color-scheme: light dark;
  font-family: var(--dsw-font-family);
  --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --dsw-alias-bg-base: #eef4f5;
  --dsw-alias-bg-layer-1: #fff;
  --dsw-alias-bg-layer-2: #fff;
  --dsw-alias-bg-module-platform: #f3f7f7;
  --dsw-alias-bg-mask-1: #0000003d;
  --dsw-alias-border-l1: #16333b0d;
  --dsw-alias-border-l2: #16333b1f;
  --dsw-alias-border-l3: #16333b33;
  --dsw-alias-brand-primary: #0a2630;
  --dsw-alias-button-primary-fill: #0a2630;
  --dsw-alias-button-primary-hover: #123b45;
  --dsw-alias-interactive-bg-hover: #0a819112;
  --dsw-alias-interactive-bg-hover-solid: #edf6f6;
  --dsw-alias-label-caption: #95a4a8;
  --dsw-alias-label-dimmed: #dbe4e6;
  --dsw-alias-label-primary: #10262c;
  --dsw-alias-label-primary-foreground: #fff;
  --dsw-alias-label-secondary: #566a70;
  --dsw-alias-label-tertiary: #71858a;
  --dsw-alias-state-business-primary: #087f91;
  --dsw-alias-state-error-primary: #c93636;
  --dsw-alias-state-success-primary: #15805d;
  --dsw-accent: #20b8c7;
  --dsw-accent-strong: #009dde;
  --dsw-shadow-lv3: 0 34px 90px rgb(13 45 53 / 17%);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-auth-theme="light"]) {
    color-scheme: dark;
    --dsw-alias-bg-base: #151517;
    --dsw-alias-bg-layer-1: #232324;
    --dsw-alias-bg-layer-2: #2c2c2e;
    --dsw-alias-bg-module-platform: #2c2c2e;
    --dsw-alias-bg-mask-1: #00000080;
    --dsw-alias-border-l1: #ffffff0f;
    --dsw-alias-border-l2: #ffffff1f;
    --dsw-alias-border-l3: #ffffff29;
    --dsw-alias-brand-primary: #f9fafb;
    --dsw-alias-button-primary-fill: #f9fafb;
    --dsw-alias-button-primary-hover: #ebeef2;
    --dsw-alias-interactive-bg-hover: #ffffff14;
    --dsw-alias-interactive-bg-hover-solid: #2c2c2e;
    --dsw-alias-label-caption: #81858c;
    --dsw-alias-label-dimmed: #43454a;
    --dsw-alias-label-primary: #f9fafb;
    --dsw-alias-label-primary-foreground: #0f1115;
    --dsw-alias-label-secondary: #cfd3d6;
    --dsw-alias-label-tertiary: #adb2b8;
    --dsw-alias-state-business-primary: #4176e6;
    --dsw-alias-state-error-primary: #f25a5a;
    --dsw-alias-state-success-primary: #4ed17e;
    --dsw-shadow-lv3: 0 20px 50px rgb(0 0 0 / 38%);
  }
}

:root[data-auth-theme="dark"] {
  color-scheme: dark;
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-module-platform: #2c2c2e;
  --dsw-alias-bg-mask-1: #00000080;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-border-l3: #ffffff29;
  --dsw-alias-brand-primary: #f9fafb;
  --dsw-alias-button-primary-fill: #f9fafb;
  --dsw-alias-button-primary-hover: #ebeef2;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-interactive-bg-hover-solid: #2c2c2e;
  --dsw-alias-label-caption: #81858c;
  --dsw-alias-label-dimmed: #43454a;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-primary-foreground: #0f1115;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-state-business-primary: #4176e6;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-state-success-primary: #4ed17e;
  --dsw-shadow-lv3: 0 20px 50px rgb(0 0 0 / 38%);
}

:root[data-auth-theme="light"] { color-scheme: light; }
* { box-sizing: border-box; }
html { min-width: 320px; min-height: 100%; background: var(--dsw-alias-bg-base); }
body { min-width: 320px; min-height: 100dvh; margin: 0; overflow-x: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .4; }

.auth-page { min-height: 100dvh; display: grid; place-items: center; padding: 32px 20px; }
.auth-shell { width: min(420px, 100%); }
.auth-card { min-width: 0; padding: 32px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 20px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 18px 50px rgb(13 45 53 / 12%); }
.auth-header { display: flex; align-items: center; margin-bottom: 28px; }
.brand { display: inline-flex; align-items: center; gap: 11px; color: var(--dsw-alias-label-primary); text-decoration: none; }
.brand-mark { display: inline-flex; width: 48px; flex: 0 0 auto; align-items: center; justify-content: center; }
.brand-mark svg { display: block; width: 48px; height: auto; }
.brand-name { font-size: 14px; line-height: 20px; font-weight: 650; letter-spacing: .01em; }
.auth-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 650; letter-spacing: -.02em; }
.auth-subtitle { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }
.form-stack { display: grid; gap: 16px; margin-top: 24px; }
.field { display: grid; gap: 8px; }
.field label { color: #344b51; font-size: 13px; line-height: 18px; font-weight: 600; }
.field input { width: 100%; height: 48px; padding: 0 15px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; outline: none; background: #fbfdfd; color: var(--dsw-alias-label-primary); font-size: 16px; transition: border-color .18s ease, box-shadow .18s ease, background .18s ease; }
.field input::placeholder { color: var(--dsw-alias-label-caption); }
.field input:hover { border-color: var(--dsw-alias-border-l3); }
.field input:focus { border-color: var(--dsw-alias-state-business-primary); background: #fff; box-shadow: 0 0 0 4px rgb(8 127 145 / 12%); }
.input-wrap { position: relative; }
.input-wrap input { padding-right: 62px; }
.password-toggle { position: absolute; top: 2px; right: 4px; min-width: 50px; height: 44px; padding: 0 8px; border: 0; border-radius: 9px; background: transparent; color: var(--dsw-alias-state-business-primary); font-size: 12px; font-weight: 650; }
.password-toggle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.password-toggle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.actions { display: grid; gap: 10px; margin-top: 20px; }
.pair-actions { display: grid; gap: 14px; margin-top: 20px; }
.pair-actions .actions { margin-top: 0; }
.button { display: inline-flex; width: 100%; min-height: 48px; align-items: center; justify-content: center; padding: 0 18px; border: 1px solid transparent; border-radius: 12px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; font-weight: 650; text-decoration: none; transition: transform .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease, color .18s ease; }
.button:active:not(:disabled) { transform: translateY(1px); }
.button:focus-visible, .text-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.button.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); box-shadow: 0 10px 22px rgb(10 38 48 / 18%); }
.button.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); box-shadow: 0 13px 28px rgb(10 38 48 / 23%); transform: translateY(-1px); }
.button.secondary { border-color: var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.button.secondary:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover-solid); }
.button.is-loading { position: relative; color: transparent; }
.button.is-loading::after { content: ""; position: absolute; width: 16px; height: 16px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; color: var(--dsw-alias-label-primary-foreground); animation: auth-spin .7s linear infinite; }
.button.secondary.is-loading::after { color: var(--dsw-alias-label-primary); }
@keyframes auth-spin { to { transform: rotate(360deg); } }
.divider { display: flex; align-items: center; gap: 12px; margin: 22px 0 0; color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px; }
.divider::before, .divider::after { height: 1px; flex: 1; background: var(--dsw-alias-border-l2); content: ""; }
.auth-message { min-height: 22px; margin: 16px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.auth-message[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
.auth-message[data-state="success"] { color: var(--dsw-alias-state-success-primary); }
.auth-links { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; }
.text-button { min-height: 44px; padding: 0 2px; border: 0; background: transparent; color: var(--dsw-alias-state-business-primary); font-size: 13px; line-height: 20px; font-weight: 600; text-align: left; }
.text-button:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.mode-note { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.account-note { margin-top: 20px; padding: 13px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.account-note strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.status-card { text-align: center; }
.status-mark { display: grid; width: 40px; height: 40px; margin: 0 auto 18px; place-items: center; border: 1px solid var(--dsw-alias-border-l3); border-radius: 14px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-business-primary); font-size: 18px; font-weight: 600; }
.status-card .auth-subtitle { margin-left: auto; margin-right: auto; max-width: 36ch; }
.status-card .button { margin-top: 24px; }
.hidden { display: none !important; }

@media (max-width: 520px) {
  html, body { background: #fff; }
  .auth-page { display: block; padding: 0; }
  .auth-shell { width: 100%; }
  .auth-card { min-height: 100dvh; padding: 28px 24px 40px; border: 0; border-radius: 0; box-shadow: none; }
  .auth-header { margin-bottom: 38px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;

const BRAND = `<a class="brand" href="/" aria-label="返回 MewClaw Harness 登录"><span class="brand-mark" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs><mask id="mewclaw-login-v-under"><rect width="240" height="240" fill="#fff"/><path d="M76 90h28" stroke="#000" stroke-width="18"/><path d="M136 150h28" stroke="#000" stroke-width="18"/></mask></defs><g transform="rotate(45 120 120)" fill="none" stroke="currentColor" stroke-width="16"><rect x="35" y="90" width="170" height="60" rx="30"/><rect x="90" y="35" width="60" height="170" rx="30" mask="url(#mewclaw-login-v-under)"/></g></svg></span><span class="brand-name">MewClaw Harness</span></a>`;

export type AuthTheme = "light" | "dark" | "system";

const LOGIN_SCRIPT = `
(() => {
  const $ = (id) => document.getElementById(id);
  let mode = "login";
  let busy = false;
  let verificationPayload = null;
  const csrf = () => {
    const value = (document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || "";
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const message = (text, state = "neutral") => {
    const node = $("message");
    node.textContent = text;
    node.dataset.state = state;
  };
  const setBusy = (value) => {
    busy = value;
    [$("submit"), $("toggle"), $("forgot"), $("password-toggle"), $("verify-submit"), $("resend"), $("verify-back")].forEach((button) => {
      if (button) button.disabled = value;
    });
    [$("submit"), $("verify-submit"), $("resend")].forEach((button) => { if (button) button.classList.toggle("is-loading", value); });
  };
  const render = () => {
    const register = mode === "register";
    $("title").textContent = register ? "创建账户" : "登录";
    $("name-wrap").classList.toggle("hidden", !register);
    $("name").required = register;
    $("password").autocomplete = register ? "new-password" : "current-password";
    $("submit").textContent = register ? "注册并发送验证码" : "登录";
    $("toggle").textContent = register ? "已有账户，返回登录" : "创建新账户";
    $("forgot").classList.toggle("hidden", register);
    $("form").classList.remove("hidden");
    $("verify-form").classList.add("hidden");
    setPasswordVisible(false);
  };
  const setPasswordVisible = (visible) => {
    const input = $("password");
    const button = $("password-toggle");
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "隐藏" : "显示";
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  };
  const showVerification = (payload) => {
    verificationPayload = payload;
    $("form").classList.add("hidden");
    $("verify-form").classList.remove("hidden");
    $("toggle").classList.add("hidden");
    $("forgot").classList.add("hidden");
    $("title").textContent = "验证邮箱";
    $("verification-email").textContent = payload.email;
    $("verification-code").value = "";
    $("verification-code").focus();
  };
  $("toggle").onclick = () => { if (busy) return; mode = mode === "login" ? "register" : "login"; message(""); render(); };
  $("password-toggle").onclick = () => setPasswordVisible($("password").type === "password");
  $("forgot").onclick = async () => {
    const email = $("email").value.trim();
    if (!email) { message("请先填写邮箱。", "error"); $("email").focus(); return; }
    const button = $("forgot");
    button.disabled = true;
    try {
      const response = await fetch("/auth/forgot", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ email }) });
      message(response.ok ? "如果邮箱存在，重置链接已发送。" : "请求失败，请稍后再试。", response.ok ? "success" : "error");
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    button.disabled = false;
  };
  $("verify-back").onclick = () => { if (busy) return; verificationPayload = null; $("toggle").classList.remove("hidden"); $("forgot").classList.toggle("hidden", mode === "register"); render(); message(""); };
  $("resend").onclick = async () => {
    if (busy || !verificationPayload) return;
    setBusy(true);
    try {
      const response = await fetch("/auth/register", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify(verificationPayload) });
      message(response.ok ? "新的验证码已发送。" : "验证码发送失败，请稍后重试。", response.ok ? "success" : "error");
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
  $("verify-form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !verificationPayload) return;
    setBusy(true);
    try {
      const response = await fetch("/auth/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ email: verificationPayload.email, code: $("verification-code").value }) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) { message("验证成功，正在打开工作台……", "success"); setTimeout(() => { location.href = "/"; }, 150); }
      else message(body.error === "INVALID_VERIFICATION_CODE" ? "请输入 6 位数字验证码。" : body.error === "VERIFICATION_CODE_INVALID" ? "验证码错误或已过期。" : "验证失败，请稍后重试。", "error");
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const register = mode === "register";
    const payload = { email: $("email").value, password: $("password").value, ...(register ? { displayName: $("name").value } : {}) };
    setBusy(true);
    try {
      const response = await fetch(register ? "/auth/register" : "/auth/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        if (register) {
          showVerification(payload);
          message("验证码已发送，请检查邮箱。", "success");
        } else {
          message("登录成功，正在打开工作台……", "success");
          setTimeout(() => { location.href = "/"; }, 150);
        }
      } else {
        message(body.error === "EMAIL_NOT_VERIFIED" ? "请先完成邮箱验证码验证。" : body.error === "MAIL_DELIVERY_FAILED" ? "验证码发送失败，请稍后重试。" : "请求失败，请检查输入后重试。", "error");
      }
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
  render();
})();`;

function documentPage(title: string, content: string, script = "", theme: AuthTheme = "light", pageClass = "", cardClass = ""): string {
  const safeTitle = escapeHtml(title);
  const scriptTag = script ? `<script>${script}</script>` : "";
  const themeAttribute = theme === "system" ? "" : ` data-auth-theme="${theme}"`;
  const pageClassAttribute = pageClass ? ` ${pageClass}` : "";
  const cardClassAttribute = cardClass ? ` ${cardClass}` : "";
  return `<!doctype html><html lang="zh-CN"${themeAttribute}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#eef4f5"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>${safeTitle} - MewClaw Harness</title><style>${AUTH_STYLES}</style></head><body><main class="auth-page${pageClassAttribute}"><div class="auth-shell"><section class="auth-card${cardClassAttribute}"><header class="auth-header">${BRAND}</header>${content}</section></div></main>${scriptTag}</body></html>`;
}

export function loginPage(): string {
  const content = `<h1 id="title" class="auth-title">登录</h1><form id="form" class="form-stack"><div id="name-wrap" class="field hidden"><label for="name">显示名称</label><input id="name" autocomplete="name" maxlength="120"></div><div class="field"><label for="email">邮箱</label><input id="email" type="email" autocomplete="email" required maxlength="320" placeholder="name@example.com"></div><div class="field"><label for="password">密码</label><div class="input-wrap"><input id="password" type="password" autocomplete="current-password" required minlength="12" maxlength="256" placeholder="至少 12 个字符"><button id="password-toggle" class="password-toggle" type="button" aria-label="显示密码" aria-pressed="false">显示</button></div></div><button id="submit" class="button primary" type="submit">登录</button></form><form id="verify-form" class="form-stack hidden"><p class="auth-subtitle">验证码已发送到 <strong id="verification-email"></strong></p><div class="field"><label for="verification-code">邮箱验证码</label><input id="verification-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="6 位数字"></div><button id="verify-submit" class="button primary" type="submit">验证并进入工作台</button><button id="resend" class="button secondary" type="button">重新发送验证码</button><button id="verify-back" class="text-button" type="button">更换邮箱</button></form><p id="message" class="auth-message" role="status" aria-live="polite"></p><div class="auth-links"><button id="toggle" class="text-button" type="button">创建新账户</button><button id="forgot" class="text-button" type="button">忘记密码</button></div>`;
  return documentPage("登录", content, LOGIN_SCRIPT, "light");
}

export function pairPage(token: string, currentUser?: { email: string; displayName: string }, switchAccount = false): string {
  const safeToken = escapeScript(token);
  const switchUrl = `/auth/pair?token=${encodeURIComponent(token)}&switch=1`;
  const content = currentUser && !switchAccount ? currentPairContent(currentUser, switchUrl) : guestPairContent(switchAccount);
  const script = currentUser && !switchAccount ? pairConfirmScript(safeToken) : pairGuestScript(safeToken);
  return documentPage("绑定飞书账户", `<div class="eyebrow">飞书配对</div><h1 class="auth-title">绑定飞书账户</h1><p class="auth-subtitle">绑定后，飞书会话将访问同一个 Web 工作区和会话历史。</p>${content}`, script);
}

function currentPairContent(currentUser: { email: string; displayName: string }, switchUrl: string): string {
  return `<div class="account-note">当前已登录 Web 账户：<strong>${escapeHtml(currentUser.displayName)}</strong><br>${escapeHtml(currentUser.email)}<br><span>确认后，当前飞书用户和这次飞书会话将绑定到此账户。</span></div><div class="pair-actions"><form id="confirm" class="actions"><button class="button primary" type="submit">确认绑定飞书账户</button></form><a class="button secondary" href="${escapeHtml(switchUrl)}">切换到已绑定 Web 账户</a></div><p id="message" class="auth-message" role="status" aria-live="polite"></p>`;
}

function guestPairContent(switchAccount: boolean): string {
  const note = switchAccount ? "当前 Web 账户与飞书绑定不一致：已有账户请登录已绑定的 Web 账户；没有账户请注册并验证邮箱。" : "当前未登录 Web 账户：已有账户请登录并绑定；没有账户请注册并验证邮箱。";
  return `<div class="account-note">${note}</div><form id="form" class="form-stack"><div class="field"><label for="email">邮箱</label><input id="email" type="email" autocomplete="email" required maxlength="320" placeholder="name@example.com"></div><div class="field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required minlength="12" maxlength="256" placeholder="至少 12 个字符"></div><div id="name-wrap" class="field hidden"><label for="name">显示名称</label><input id="name" autocomplete="name" maxlength="120"></div><button id="submit" class="button primary" type="submit">登录并绑定</button></form><form id="verify-form" class="form-stack hidden"><p class="auth-subtitle">验证码已发送到 <strong id="verification-email"></strong></p><div class="field"><label for="verification-code">邮箱验证码</label><input id="verification-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="6 位数字"></div><button id="verify-submit" class="button primary" type="submit">验证并绑定</button><button id="resend" class="button secondary" type="button">重新发送验证码</button><button id="verify-back" class="text-button" type="button">更换邮箱</button></form><div class="actions"><button id="toggle" class="button secondary" type="button">注册新账户</button></div><p id="message" class="auth-message" role="status" aria-live="polite"></p>`;
}

function pairConfirmScript(safeToken: string): string {
  return `(() => { const $ = (id) => document.getElementById(id); const csrf = () => decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || ""); const errorText = (code) => code === "FEISHU_IDENTITY_CONFLICT" ? "该飞书账户已绑定到其他 Web 账户。" : code === "FEISHU_SESSION_CONFLICT" ? "当前飞书会话已绑定到其他 Web 账户。" : code === "PAIRING_INVALID" ? "链接已失效，请回到飞书重新发送 /login。" : "绑定失败，请重新获取飞书链接。"; $("confirm").onsubmit = async (event) => { event.preventDefault(); const button = $("confirm").querySelector("button"); button.disabled = true; button.classList.add("is-loading"); try { const response = await fetch("/auth/pair/confirm", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ token: ${safeToken} }) }); const body = await response.json().catch(() => ({})); if (response.ok) { $("message").textContent = "绑定成功，正在打开工作台……"; $("message").dataset.state = "success"; setTimeout(() => { location.href = "/"; }, 150); } else { $("message").textContent = errorText(body.error); $("message").dataset.state = "error"; } } catch { $("message").textContent = "网络异常，请检查连接后重试。"; $("message").dataset.state = "error"; } button.disabled = false; button.classList.remove("is-loading"); }; })();`;
}

function pairGuestScript(safeToken: string): string {
  return `
(() => {
  const $ = (id) => document.getElementById(id);
  const pairToken = ${safeToken};
  let mode = "login";
  let busy = false;
  let verificationPayload = null;
  const csrf = () => decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || "");
  const message = (text, state = "neutral") => { $("message").textContent = text; $("message").dataset.state = state; };
  const setBusy = (value) => {
    busy = value;
    [$("submit"), $("toggle"), $("verify-submit"), $("resend"), $("verify-back")].forEach((button) => { if (button) button.disabled = value; });
    [$("submit"), $("verify-submit"), $("resend")].forEach((button) => { if (button) button.classList.toggle("is-loading", value); });
  };
  const errorText = (code) => code === "INVALID_CREDENTIALS" ? "邮箱或密码错误。" : code === "INVALID_EMAIL" ? "请输入有效邮箱。" : code === "INVALID_PASSWORD" ? "密码长度必须为 12 至 256 个字符。" : code === "INVALID_VERIFICATION_CODE" ? "请输入 6 位数字验证码。" : code === "VERIFICATION_CODE_INVALID" ? "验证码错误或已过期。" : code === "ACCOUNT_EXISTS" ? "该邮箱已有账户，请切换到登录并绑定。" : code === "FEISHU_IDENTITY_CONFLICT" ? "该飞书账户已绑定到其他 Web 账户。" : code === "FEISHU_SESSION_CONFLICT" ? "当前飞书会话已绑定到其他 Web 账户。" : code === "PAIRING_INVALID" ? "链接已失效，请回到飞书重新发送 /login。" : code === "MAIL_DELIVERY_FAILED" ? "验证码暂时发送失败，请稍后重试。" : "请求失败，请检查输入或重新获取飞书链接。";
  const setMode = (next) => {
    mode = next;
    $("name-wrap").classList.toggle("hidden", mode !== "register");
    $("name").required = mode === "register";
    $("submit").textContent = mode === "register" ? "注册并发送验证码" : "登录并绑定";
    $("toggle").textContent = mode === "register" ? "已有账户，返回登录" : "注册新账户";
  };
  const showVerification = (payload) => {
    verificationPayload = payload;
    $("form").classList.add("hidden");
    $("verify-form").classList.remove("hidden");
    $("toggle").classList.add("hidden");
    $("verification-email").textContent = payload.email;
    $("verification-code").value = "";
    $("verification-code").focus();
    message("验证码已发送，请检查邮箱。", "success");
  };
  $("toggle").onclick = () => { if (busy) return; setMode(mode === "login" ? "register" : "login"); message(""); };
  $("verify-back").onclick = () => { if (busy) return; verificationPayload = null; $("form").classList.remove("hidden"); $("verify-form").classList.add("hidden"); $("toggle").classList.remove("hidden"); setMode(mode); message(""); };
  $("resend").onclick = async () => {
    if (busy || !verificationPayload) return;
    setBusy(true);
    try {
      const response = await fetch("/auth/pair/register", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ ...verificationPayload, token: pairToken }) });
      const result = await response.json().catch(() => ({}));
      message(response.ok ? "新的验证码已发送。" : errorText(result.error), response.ok ? "success" : "error");
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
  $("verify-form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !verificationPayload) return;
    setBusy(true);
    try {
      const response = await fetch("/auth/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ email: verificationPayload.email, code: $("verification-code").value, pairingToken: pairToken }) });
      const result = await response.json().catch(() => ({}));
      if (response.ok) { message("验证成功，正在打开工作台……", "success"); setTimeout(() => { location.href = result.pairingBound ? "/" : "/auth/pair?token=" + encodeURIComponent(pairToken); }, 150); }
      else message(errorText(result.error), "error");
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const body = { token: pairToken, email: $("email").value, password: $("password").value, ...(mode === "register" ? { displayName: $("name").value } : {}) };
    setBusy(true);
    try {
      const response = await fetch(mode === "register" ? "/auth/pair/register" : "/auth/pair/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        if (mode === "register") showVerification({ email: body.email, password: body.password, displayName: body.displayName });
        else { message("登录成功，正在打开工作台……", "success"); setTimeout(() => { location.href = "/"; }, 150); }
      } else { message(errorText(result.error), "error"); if (result.error === "ACCOUNT_EXISTS") setMode("login"); }
    } catch { message("网络异常，请检查连接后重试。", "error"); }
    setBusy(false);
  };
})();`;
}

export function resetPage(token: string): string {
  const safeToken = escapeScript(token);
  const content = `<div class="eyebrow">账户安全</div><h1 class="auth-title">重置密码</h1><p class="auth-subtitle">设置一个新的登录密码，完成后将直接进入工作台。</p><form id="form" class="form-stack"><div class="field"><label for="password">新密码</label><input id="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password" placeholder="至少 12 个字符"></div><div class="field"><label for="confirm">确认密码</label><input id="confirm" type="password" minlength="12" maxlength="256" required autocomplete="new-password" placeholder="再次输入新密码"></div><button class="button primary" type="submit">保存新密码</button></form><p id="message" class="auth-message" role="status" aria-live="polite"></p>`;
  const script = `(() => { const $ = (id) => document.getElementById(id); const csrf = () => decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/) || [])[1] || ""); $("form").onsubmit = async (event) => { event.preventDefault(); const password = $("password").value; if (password !== $("confirm").value) { $("message").textContent = "两次密码不一致。"; $("message").dataset.state = "error"; return; } const button = $("form").querySelector("button"); button.disabled = true; button.classList.add("is-loading"); try { const response = await fetch("/auth/password/reset", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ token: ${safeToken}, password }) }); const body = await response.json().catch(() => ({})); if (response.ok) { $("message").textContent = "密码已更新，正在进入工作台……"; $("message").dataset.state = "success"; setTimeout(() => { location.href = "/"; }, 150); } else { $("message").textContent = body.error === "RESET_TOKEN_INVALID" ? "链接无效或已过期。" : "请求失败，请稍后重试。"; $("message").dataset.state = "error"; } } catch { $("message").textContent = "网络异常，请检查连接后重试。"; $("message").dataset.state = "error"; } button.disabled = false; button.classList.remove("is-loading"); }; })();`;
  return documentPage("重置密码", content, script);
}

export function messagePage(title: string, message: string, status = 200): { status: number; html: string } {
  const tone = status >= 400 ? "error" : "success";
  const mark = status >= 400 ? "!" : "i";
  const content = `<div class="status-card"><div class="status-mark" aria-hidden="true">${mark}</div><h1 class="auth-title">${escapeHtml(title)}</h1><p class="auth-subtitle">${escapeHtml(message)}</p><a class="button secondary" href="/">返回登录</a></div>`;
  return { status, html: documentPage(title, `<div data-tone="${tone}">${content}</div>`) };
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function escapeScript(value: string): string { return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"); }
