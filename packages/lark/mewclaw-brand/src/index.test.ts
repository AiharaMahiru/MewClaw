import { describe, expect, it } from "vitest";

import {
  apply,
  FAVICON_SVG,
  MEWCLAW_MARK_VIEWBOX,
  renderMewClawBrandMark,
} from "./index.js";

type ElementNode = {
  type: string;
  props: Record<string, unknown> | null;
  children: unknown[];
};

const fakeReact = {
  createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode {
    return { type, props, children };
  },
};

describe("dsh-lark-mewclaw-brand", () => {
  it("使用指定的 MewClaw 商标几何", () => {
    const mark = renderMewClawBrandMark(fakeReact, { size: 104, className: "hero-mark" }) as ElementNode;

    expect(mark.type).toBe("svg");
    expect(mark.props).toMatchObject({
      width: 104,
      height: 104,
      viewBox: MEWCLAW_MARK_VIEWBOX,
      className: "hero-mark mewclaw-brand-mark",
      shapeRendering: "geometricPrecision",
      "aria-hidden": "true",
    });
    expect(mark.children.map((child) => (child as ElementNode).type)).toEqual(["circle", "path", "path", "path", "path", "path", "g", "g", "path"]);
    expect(JSON.stringify(mark)).toContain("M256 132 C244 132");
    expect(JSON.stringify(mark)).toContain("mewclaw-mark-ink");
    expect(JSON.stringify(mark)).toContain("mewclaw-mark-cutout");
    expect(JSON.stringify(mark)).not.toContain("rotate(45 120 120)");
    expect(JSON.stringify(mark)).not.toContain("mask");
  });

  it("不引用 DeepSeek 鱼形组件或外部资源", () => {
    const mark = renderMewClawBrandMark(fakeReact, { size: 24 }) as ElementNode;
    expect(JSON.stringify(mark)).not.toContain("FishLogo");
    expect(JSON.stringify(mark)).not.toContain("https://");
  });

  it("通过 WebServer 扩展点提供标题、语言、favicon 与 manifest", () => {
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
    let transform: ((html: string) => string) | undefined;
    const ctx = {
      effect(callback: () => unknown): void { callback(); },
      webServer: {
        tapIndex(callback: (html: string) => string): () => void { transform = callback; return () => undefined; },
        register(route: typeof routes[number]): () => void { routes.push(route); return () => undefined; },
      },
    } as never;
    apply(ctx);
    const html = transform?.('<html lang="en"><head><title>DeepSeek Harness</title></head><body></body></html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>MewClaw Harness</title>");
    expect(html).not.toContain("grid-template-columns");
    expect(html).not.toContain("mewclaw-hero-mark{width");
    expect(html).toContain("data-mewclaw-brand");
    expect(routes.map(({ path }) => path)).toEqual(["/mewclaw-brand/favicon.svg", "/mewclaw-brand/manifest.webmanifest"]);
    expect(FAVICON_SVG).toContain('viewBox="0 0 512 512"');
    expect(FAVICON_SVG).toContain("@media(prefers-color-scheme:dark)");
    expect(FAVICON_SVG).toContain("--bg:#181717;--ink:#fff");
    expect(html).toContain("body[data-ds-dark-theme] .mewclaw-brand-mark");
    expect(html).toContain("mewclaw-hero-copy");
    expect(html).not.toContain("@keyframes mewclaw-hero-copy");
    expect(html).toContain("span:has(.mewclaw-hero-brand)+span{display:none}");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).toContain('class="mewclaw-boot"');
    expect(html).toContain('sessionStorage.getItem("mewclaw.boot.v1")');
    expect(html).toContain('sessionStorage.setItem("mewclaw.boot.v1","1")');
    expect(html).toContain("setTimeout(remove,1600)");
    expect(html).toContain("pointer-events:none");
    // 移动适配覆盖层样式（§6 移动适配）：抽屉断点对齐上游 narrow <1024，
    // 顶栏收纳保留 ≤768 小屏阈值
    expect(html).toContain("@media(max-width:1023px)");
    expect(html).toContain("@media(max-width:768px)");
    expect(html).toContain('[class*="_sidebarCol"]{position:fixed');
    expect(html).toContain('[class*="_centerCol"]{grid-column:1/-1}');
    expect(html).toContain("translateX(-110%)");
    expect(html).toContain("html.mewclaw-rail-open");
    // 移动端抽屉不透明 + 顶栏收纳（按容器隐藏桌面专属控件，与语言无关）
    expect(html).toContain("background-color:rgb(28 28 35)!important");
    expect(html).toContain('[class*="_titleRow"] [class*="_headerActions"]');
    expect(html).toContain('[class*="_titleRow"] [class*="_headerUtilities"]');
    // 文件预览顶部工具栏的 flex 收缩链：窄屏下父级与编辑器容器允许收缩，
    // 路径输入框让出固定操作按钮，避免工具栏把页面撑出视口。
    expect(html).toContain(':is([data-dsh-panel-host],[data-sidebar-right-panel]) :is([class*="_paneContent"],[class*="_paneTab"],[class*="_editor"]){min-width:0;max-width:100%}');
    expect(html).toContain(':is([data-dsh-panel-host],[data-sidebar-right-panel]) [class*="_editorHeader"]{min-width:0;width:100%;max-width:100%;box-sizing:border-box;gap:4px;padding-inline:4px;overflow:hidden}');
    expect(html).toContain(':is([data-dsh-panel-host],[data-sidebar-right-panel]) [class*="_editorPathInput"]{flex:1 1 0;min-width:0;width:0;max-width:100%');
    // 官方展开按钮只在折叠态渲染，品牌层不得把它全局隐藏。
    // push 面板必须保持官方 top:0/bottom:0 几何，不留顶部灰条、不压缩高度；
    // 官方自动 fullscreen 断点（viewportWidth < 768）则显式铺满移动视口。
    expect(html).not.toContain("[data-sidebar-right-expand]{display:none!important}");
    expect(html).toContain('[data-sidebar-right-panel="push"]{top:0!important;bottom:0!important}');
    expect(html).toContain('@media(max-width:767.98px){[data-sidebar-right-panel="fullscreen"]{position:fixed!important;inset:0!important;width:100%!important;max-width:none!important}}');
    expect(html).not.toContain('top:38px!important');
    expect(html).not.toContain('[aria-label="Open right sidebar"]');
    // 液态玻璃下坞面板与官方右侧栏均抬回不透明面：backdrop-filter 在部分
    // 移动端 WebView 声明支持却不渲染，可读性不能依赖模糊真实生效。
    expect(html).toContain('html[data-mew-glass] :is([data-dsh-panel-host] :is([data-dsh-panel],[data-dsh-float-window]),[data-sidebar-right-panel],[data-sidebar-right-float-host] > :first-child){background-color:var(--mew-canvas)}');
    // 侧栏开合控制器（§6 移动适配）：左上角菜单键 + 左缘热区滑动 + 外点关闭
    expect(html).toContain("data-mewclaw-rail");
    expect(html).toContain("mewclaw-rail-edge");
    expect(html).toContain("mewclaw-rail-fab");
    expect(html).toContain('aria-label","Menu"');
    expect(html).toContain('[class*="_titleRow"]{padding-left:48px!important}');
    // 菜单键仅在抽屉关闭时可见——不再依赖已移除的 body 折叠属性
    expect(html).toContain("html.mewclaw-rail-open .mewclaw-rail-fab{display:none}");
    expect(html).not.toContain("data-dsh-sidebar-collapsed");
    // 折叠判定锚定 AppFrame 的 data-sidebar-collapsed， MutationObserver 兜底复位
    expect(html).toContain('document.querySelector("[data-sidebar-collapsed]")');
    expect(html).toContain('attributeFilter:["data-sidebar-collapsed"]');
    expect(html).toContain("touch-action:pan-y");
    expect(html).toContain("pointerdown");
    expect(html).toContain("touchstart");
    expect(html).toContain("touchmove");
  });
});
