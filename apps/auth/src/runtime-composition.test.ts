import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("独立 App 的 Cordis runtime 边界", () => {
  for (const app of ["auth", "browser", "preview"]) {
    it(`${app} 入口只装载环境、boot 组合并 dispose fiber`, async () => {
      const root = new URL(`../../${app}/`, import.meta.url);
      const main = await readFile(new URL("src/main.ts", root), "utf8");
      const composition = await readFile(new URL("cordis.yml", root), "utf8");
      expect(main).toContain("loadLayeredEnv");
      expect(main).toContain("await boot(");
      expect(main).toContain("ctx.fiber.dispose()");
      expect(main).not.toMatch(/new (?:AuthService|PostgresAuthStore|ChromiumRuntime|BrowserManager|PreviewManager|PodmanRuntime)\b/u);
      expect(main).not.toContain("createBrowserServer(");
      expect(main).not.toContain("createPreviewServer(");
      expect(main).not.toContain("createAuthEdgeServer(");
      expect(composition).toContain(`${app}-runtime`);
    });
  }
});
