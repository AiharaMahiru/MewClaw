import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { CONFIG_ID, resolveConfig } from "./config.js";
import * as host from "./index.js";
import { GLASS_TOKENS } from "./tokens.js";

describe("液态玻璃主题配置", () => {
  it("在输入边界显式解析默认值", () => {
    expect(resolveConfig()).toEqual({ enabled: true, defaultEnabled: true, refraction: true, displacementScale: 32, blurAmount: 0.12, saturation: 130, aberrationIntensity: 1, identityTimeoutMs: 5000 });
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });
  it.each([null, [], { unknown: 1 }, { enabled: "yes" }, { refraction: undefined },
    { displacementScale: NaN }, { displacementScale: 81 }, { blurAmount: -1 },
    { saturation: 181 }, { aberrationIntensity: Infinity }])("拒绝非法配置 %j", (input) => {
    expect(() => resolveConfig(input)).toThrow(TypeError);
  });
  it("所有覆盖都是公开 alias 并提供双色模式", () => {
    for (const [name, values] of Object.entries(GLASS_TOKENS)) {
      expect(name).toMatch(/^--dsw-(alias|specific)-/u);
      expect(Object.keys(values)).toEqual(["light", "dark"]);
    }
    expect(GLASS_TOKENS).toMatchSnapshot();
  });
});

describe("Cordis Host 生命周期", () => {
  it("卸载插件移除 HTML transform，其他变换保持原样", async () => {
    const ctx = new Context();
    const transforms = new Set<(html: string) => string>();
    // 只隔离网络服务器；插件加载和 effect 清理由真实 Cordis 管理。
    ctx.reflect.provide("webServer", { tapIndex: (transform: (html: string) => string) => {
      transforms.add(transform);
      return () => transforms.delete(transform);
    } });
    const fork = ctx.plugin(host, { blurAmount: 0.2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transforms.size).toBe(1);
    const html = [...transforms][0]!('<html><head><title>原品牌</title></head><body>原内容</body></html>');
    expect(html).toContain(CONFIG_ID);
    expect(html).toContain('"blurAmount":0.2');
    expect(html).toContain("<title>原品牌</title>");
    expect(html).toContain("<body>原内容</body>");
    await fork.dispose();
    expect(transforms.size).toBe(0);
    await ctx.fiber.dispose();
  });
  it("关闭时没有任何 Host 注册", () => {
    const ctx = new Context();
    expect(() => host.apply(ctx, { enabled: false })).not.toThrow();
    expect(() => host.apply(ctx, { saturation: 1 })).toThrow();
  });
});
