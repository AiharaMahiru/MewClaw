import { describe, expect, it } from "vitest";
import { parsePublishArgs } from "./index.js";

describe("share_web 参数", () => {
  it("接受命令、容器端口和 TTL", () => {
    expect(parsePublishArgs({ command: " npm run dev ", port: 5173, ttl_minutes: 90 }))
      .toEqual({ command: "npm run dev", port: 5173, ttlMinutes: 90 });
  });

  it.each([
    [{ command: "", port: 3000 }, /command/],
    [{ command: "x", port: 0 }, /port/],
    [{ command: "x", port: 65536 }, /port/],
    [{ command: "x", port: 3000, ttl_minutes: 0 }, /ttl_minutes/],
  ])("拒绝非法输入 %#", (input, error) => {
    expect(() => parsePublishArgs(input)).toThrow(error);
  });
});
