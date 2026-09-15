import { describe, expect, it } from "vitest";

import { apply } from "./index.js";

describe("dsh-lark-mewclaw-brand-desktop", () => {
  it("与 Web 品牌一致但不注入移动适配样式", () => {
    const routes: Array<{ path: string }> = [];
    let transform: ((html: string) => string) | undefined;
    const ctx = {
      effect(callback: () => unknown): void { callback(); },
      webServer: {
        tapIndex(callback: (html: string) => string): () => void { transform = callback; return () => undefined; },
        register(route: { path: string }): () => void { routes.push(route); return () => undefined; },
      },
    } as never;
    apply(ctx);
    const html = transform?.('<html lang="en"><head><title>DeepSeek Harness</title></head><body></body></html>');
    expect(html).toContain("<title>MewClaw Harness</title>");
    expect(html).toContain("data-mewclaw-brand");
    expect(html).toContain("mewclaw-hero-copy");
    expect(html).toContain('class="mewclaw-boot"');
    // 桌面变体不携带移动断点覆盖
    expect(html).not.toContain("@media(max-width:768px)");
    expect(html).not.toContain("_sidebarCol");
    expect(routes.map(({ path }) => path)).toEqual(["/mewclaw-brand/favicon.svg", "/mewclaw-brand/manifest.webmanifest"]);
  });
});
