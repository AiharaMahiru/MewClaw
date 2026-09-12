/** 可选 overlay 必须由官方解析器装配，不仅检查 YAML 文本。 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { describe, expect, it } from "vitest";

describe("主题可选组合", () => {
  it("默认 Web 不启用，追加 overlay 后仅增加自有主题行", () => {
    const require = createRequire(import.meta.url);
    const base = loadOverlayPatches("theme-test", require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"));
    const web = loadOverlayPatches("theme-test", require.resolve("dsh-lark-web-bundle/cordis.patch.yml"));
    const overlay = loadOverlayPatches("theme-test", fileURLToPath(new URL("../../../../config/liquid-glass.patch.yml", import.meta.url)));
    const original = composeEntries([base, web], () => undefined);
    const themed = composeEntries([base, web, overlay], () => undefined);
    expect(original.some((row) => row.name === "dsh-lark-liquid-glass")).toBe(false);
    const added = themed.find((row) => row.id === "mewclaw-liquid-glass");
    expect(added).toMatchObject({ name: "dsh-lark-liquid-glass", config: { enabled: true, refraction: true } });
    expect(themed.filter((row) => row.id !== "mewclaw-liquid-glass")).toEqual(original);
    const bundleRequire = createRequire(require.resolve("dsh-lark-web-bundle/package.json"));
    expect(bundleRequire.resolve("dsh-lark-liquid-glass").replaceAll("\\", "/")).toContain("packages/ui/liquid-glass/lib/index.js");
  });
});
