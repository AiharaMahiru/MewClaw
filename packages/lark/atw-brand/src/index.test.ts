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

describe("dsh-lark-atw-brand", () => {
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
  });
});
