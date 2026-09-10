import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { resolveOverlayArguments } from "./overlay-args.js";

describe("Gateway overlay arguments", () => {
  it("resolves repeated production overlays from the working directory", () => {
    expect(resolveOverlayArguments([
      "--patch",
      "infra/linux/overlays/gateway.production.yml",
      "--patch",
      "/staged/extra.yml",
    ], "/release")).toEqual([
      resolve("/release", "infra/linux/overlays/gateway.production.yml"),
      "/staged/extra.yml",
    ]);
  });

  it("fails loud when a patch argument is missing", () => {
    expect(() => resolveOverlayArguments(["--patch"], "D:/release")).toThrow(/requires a file path/);
    expect(() => resolveOverlayArguments(["--patch", "--patch"], "D:/release")).toThrow(/requires a file path/);
  });
});
