import { useCallback, useEffect, useMemo, useState } from "react";

import { clearToken, logout } from "./api.js";
import { fetchCurrentUser, type CurrentUser } from "./auth-session.js";
import { Icon, type IconName } from "./components/Icon.js";
import { BillingPage } from "./pages/BillingPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { KnowledgePage } from "./pages/KnowledgePage.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { UsersPage } from "./pages/UsersPage.js";
import { pathForRoute, routeFromPath, type AppRoute } from "./route.js";

const NAVIGATION: Array<{ route: AppRoute; label: string; group: string; icon: IconName }> = [
  { route: "dashboard", label: "总览", group: "工作台", icon: "dashboard" },
  { route: "users", label: "用户", group: "管理", icon: "users" },
  { route: "sessions", label: "登录会话", group: "管理", icon: "sessions" },
  { route: "billing", label: "用量与额度", group: "管理", icon: "billing" },
  { route: "conversations", label: "运行观察", group: "运行", icon: "activity" },
  { route: "knowledge", label: "知识库", group: "运行", icon: "knowledge" },
];

function Page({ route, onUnauthorized }: { route: AppRoute; onUnauthorized: () => void }) {
  if (route === "users") return <UsersPage onUnauthorized={onUnauthorized} />;
  if (route === "sessions") return <SessionsPage onUnauthorized={onUnauthorized} />;
  if (route === "billing") return <BillingPage onUnauthorized={onUnauthorized} />;
  if (route === "conversations") return <ConversationsPage onUnauthorized={onUnauthorized} />;
  if (route === "knowledge") return <KnowledgePage onUnauthorized={onUnauthorized} />;
  return <DashboardPage onUnauthorized={onUnauthorized} />;
}

function groupNavigation() {
  const groups = new Map<string, typeof NAVIGATION>();
  for (const item of NAVIGATION) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups.entries()];
}

function Brand() {
  return <span className="hHd-Xa_brandIdentity" aria-hidden="true">
    <span className="hHd-Xa_brandMark"><svg className="mewclaw-brand-mark" xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 512 512" shapeRendering="geometricPrecision"><circle className="mewclaw-mark-bg" cx="256" cy="256" r="256" /><path className="mewclaw-mark-ink" d="M256 132 C244 132 233 137 222 146 C208 136 196 120 184 96 C179 88 169 90 166 98 C154 130 142 172 134 200 C128 214 125 230 126 246 C123.8 281.9 38.5 324.3 51.2 351.5 A226 226 0 0 0 460.8 351.5 C473.5 324.3 388.2 281.9 386 246 C387 230 384 214 378 200 C358 130 370 172 346 98 C343 90 333 88 328 96 C316 120 304 136 290 146 C279 137 268 132 256 132 Z" /><path className="mewclaw-mark-cutout" fill="none" strokeWidth="62" strokeLinecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8" /><path className="mewclaw-mark-ink" fill="none" strokeWidth="34" strokeLinecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8" /><path className="mewclaw-mark-cutout" fill="none" strokeWidth="62" strokeLinecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3" /><path className="mewclaw-mark-ink" fill="none" strokeWidth="34" strokeLinecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3" /><g className="mewclaw-mark-ink" fill="none" strokeWidth="10" strokeLinecap="round"><path d="M128 276 L44 252" /><path d="M126 300 L50 296" /></g><g className="mewclaw-mark-cutout" fill="none" strokeWidth="15" strokeLinecap="round"><path d="M174 266 Q204 300 234 266" /><path d="M278 266 Q308 300 338 266" /></g><path className="mewclaw-mark-cutout" d="M247 312 L265 312 L256 325 Z" strokeWidth="7" strokeLinejoin="round" /></svg></span>
    <span className="hHd-Xa_brandName">MewClaw Harness</span>
  </span>;
}

function routeLabel(route: AppRoute): string {
  return NAVIGATION.find((item) => item.route === route)?.label ?? "总览";
}

export default function App() {
  const [route, setRoute] = useState(() => routeFromPath(window.location.pathname));
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("mewclaw-admin-theme") === "dark" ? "dark" : "light");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("mewclaw-admin-sidebar-collapsed") === "true");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [account, setAccount] = useState<CurrentUser | null>(null);
  const [accountUnavailable, setAccountUnavailable] = useState(false);
  const groups = useMemo(groupNavigation, []);

  useEffect(() => {
    const handlePopState = (): void => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.adminTheme = theme;
    if (theme === "dark") document.body.setAttribute("data-ds-dark-theme", "");
    else document.body.removeAttribute("data-ds-dark-theme");
    localStorage.setItem("mewclaw-admin-theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("mewclaw-admin-sidebar-collapsed", String(collapsed)); }, [collapsed]);
  const navigate = useCallback((next: AppRoute): void => {
    const path = pathForRoute(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setAccountMenuOpen(false);
    setRoute(next);
  }, []);
  const handleUnauthorized = useCallback((): void => { clearToken(); window.location.assign("/"); }, []);
  useEffect(() => {
    void fetchCurrentUser().then((user) => { setAccount(user); setAccountUnavailable(false); }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message === "UNAUTHORIZED") handleUnauthorized();
      else setAccountUnavailable(true);
    });
  }, [handleUnauthorized]);
  const handleLogout = async (): Promise<void> => {
    await logout().catch(() => undefined);
    clearToken();
    window.location.assign("/");
  };
  const accountInitial = account?.displayName.slice(0, 1) || (accountUnavailable ? "!" : "…");

  return <div className={`pI_x6G_frame admin-frame ${collapsed ? "admin-frame-collapsed" : ""}`} data-sidebar-collapsed={collapsed ? "" : undefined}>
    <div className="pI_x6G_sidebarCol">
      <aside className={`hHd-Xa_root hHd-Xa_quietBars ${collapsed ? "hHd-Xa_collapsed" : ""}`} aria-label="管理导航">
        <div className="hHd-Xa_logoRow">
          <button className="hHd-Xa_brand hHd-Xa_wide" type="button" aria-label="回到管理总览" onClick={() => navigate("dashboard")}><Brand /></button>
          <button className="hHd-Xa_iconButton hHd-Xa_toggle" type="button" aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} title={collapsed ? "展开侧边栏" : "收起侧边栏"} onClick={() => setCollapsed((value) => !value)}><Icon name="menu" /></button>
        </div>
        <a className="hHd-Xa_newSession" href="/" aria-label="返回工作台"><Icon name="arrow-left" size={14} /><span className="hHd-Xa_newSessionLabel hHd-Xa_wide">返回工作台</span></a>
        <div className="hHd-Xa_regionArea">
          <nav className="qDHVXG_root admin-nav" aria-label="管理页面">
            {groups.map(([group, items]) => <div className="admin-nav-group" key={group}>
              <div className="qDHVXG_sectionHeader"><span className="qDHVXG_sectionLabel hHd-Xa_wide">{group}</span></div>
              <div className="qDHVXG_listArea"><div className="qDHVXG_treeBody"><div className="admin-nav-list">
                {items.map((item) => <a key={item.route} href={pathForRoute(item.route)} className="cBrkua_entry admin-nav-item" aria-current={route === item.route ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(item.route); }}><span className="cBrkua_entryIcon"><Icon name={item.icon} size={14} /></span><span className="cBrkua_entryLabel hHd-Xa_wide">{item.label}</span></a>)}
              </div></div></div>
            </div>)}
          </nav>
        </div>
        <div className="hHd-Xa_footArea">
          <div className="hHd-Xa_settingsArea account-settings">
            {accountMenuOpen && <div className="account-menu" role="menu">
              <a href="/" role="menuitem" onClick={() => setAccountMenuOpen(false)}><Icon name="settings" size={15} />账户设置</a>
              <button type="button" role="menuitem" onClick={() => { setTheme((value) => value === "light" ? "dark" : "light"); setAccountMenuOpen(false); }}><Icon name={theme === "light" ? "moon" : "sun"} size={15} />{theme === "light" ? "深色主题" : "浅色主题"}</button>
              <button type="button" role="menuitem" onClick={() => void handleLogout()}><Icon name="logout" size={15} />退出登录</button>
            </div>}
            <button className="VOzbGW_trigger" type="button" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((value) => !value)}>
              <span className="mewclaw-settings-trigger" title={account?.displayName ?? "账户"}><span className="mewclaw-account-avatar" aria-hidden="true">{accountInitial}</span><span className="mewclaw-account-label hHd-Xa_wide">{account?.displayName || (accountUnavailable ? "账户不可用" : "账户设置")}</span></span>
            </button>
          </div>
        </div>
      </aside>
    </div>
    <div className="pI_x6G_centerCol">
      <main className="wSkVaW_root admin-main-root">
        <header className="wSkVaW_header admin-header"><nav className="admin-crumbs" aria-label="页面位置"><span>管理工作台</span><span className="admin-crumb-separator">/</span><strong>{routeLabel(route)}</strong></nav><a className="admin-header-link" href="/"><span>返回工作台</span><Icon name="arrow-right" size={14} /></a></header>
        <div className="wSkVaW_scrollBody admin-scroll-body"><div className="wSkVaW_viewArea"><div className="app-main"><Page route={route} onUnauthorized={handleUnauthorized} /></div></div></div>
      </main>
    </div>
  </div>;
}
