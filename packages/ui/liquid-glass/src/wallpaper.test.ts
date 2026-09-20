import { describe, expect, it } from "vitest";
import { wallpaper } from "./wallpaper.js";
import { SURFACE_STYLES } from "./surfaces.js";

describe("双色SVG壁纸与语义材质", () => {
  it("保持同构与本地资源，不携带脚本和外部引用", () => {
    const variants = [false, true].map((dark) => decodeURIComponent(wallpaper(dark)));
    expect(variants[0]).not.toEqual(variants[1]);
    for (const svg of variants) {
      expect(svg).toContain('viewBox="0 0 1600 1000"');
      expect(svg).not.toMatch(/<script|<image|href=|onload=/u);
      expect(svg.match(/<path/gu)).toHaveLength(3);
    }
  });
  it("样式限制在插件开关并提供可访问性降级", () => {
    expect(SURFACE_STYLES).toContain('html[data-mew-glass="on"]');
    expect(SURFACE_STYLES).toContain("prefers-reduced-transparency");
    expect(SURFACE_STYLES).toContain("forced-colors");
    expect(SURFACE_STYLES).not.toMatch(/MutationObserver|!important|\[class/u);
  });
  it("结构容器不使用背景模糊，fixed 弹层不被困进侧栏", () => {
    const blurred = SURFACE_STYLES.split("}").filter((rule) => rule.includes("backdrop-filter:blur"));
    expect(blurred.length).toBeGreaterThan(0);
    for (const rule of blurred) expect(rule).not.toMatch(/aside|\bnav\b/u);
  });
  it("横向 tablist 收编不碰 dockkit 面板条", () => {
    // dockkit 自管 stripFill/chrome 右缘布局；玻璃 fit-content 规则若命中
    // 会把右侧栏抽屉头按钮挤离右缘（移动端实测 strip 390→184px）。
    const tablistRules = SURFACE_STYLES.split("}").filter((rule) => rule.includes('[role="tablist"]'));
    expect(tablistRules.length).toBeGreaterThan(0);
    for (const rule of tablistRules) expect(rule).toContain(':not([data-dockkit-strip])');
  });
});
