import { describe, expect, it, vi } from "vitest";

import { blockedAddress, UrlPolicy } from "./index.js";

describe("UrlPolicy", () => {
  it("仅允许解析到公网地址的 HTTP/HTTPS", async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const policy = new UrlPolicy(resolver);
    await expect(policy.assertAllowed("https://example.com/path", true)).resolves.toMatchObject({ hostname: "example.com" });
    expect(resolver).toHaveBeenCalledWith("example.com");
  });

  it("拒绝凭证、元数据主机与混合 DNS 结果", async () => {
    const policy = new UrlPolicy(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(policy.assertAllowed("https://user:pass@example.com", true)).rejects.toThrow("凭证");
    await expect(policy.assertAllowed("http://metadata.google.internal", true)).rejects.toThrow();
    await expect(policy.assertAllowed("https://example.com", true)).rejects.toThrow();
  });

  it.each(["127.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "2001:db8::1"])("拒绝受保护地址 %s", (address) => {
    expect(blockedAddress(address)).toBe(true);
  });
});
