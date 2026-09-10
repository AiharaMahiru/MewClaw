import { describe, expect, it, vi } from "vitest";

import { blockedAddress, UrlPolicy } from "./url-policy.js";

describe("UrlPolicy", () => {
  it("仅允许解析到公网地址的 HTTP/HTTPS", async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const policy = new UrlPolicy(resolver);
    await expect(policy.assertAllowed("https://example.com/path", true)).resolves.toMatchObject({ hostname: "example.com" });
    expect(resolver).toHaveBeenCalledWith("example.com");
  });

  it("拒绝凭证、非 HTTP 协议、元数据主机与混合 DNS 结果", async () => {
    const policy = new UrlPolicy(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(policy.assertAllowed("https://user:pass@example.com", true)).rejects.toThrow("凭证");
    await expect(policy.assertAllowed("file:///etc/passwd", true)).rejects.toThrow("HTTP/HTTPS");
    await expect(policy.assertAllowed("http://metadata.google.internal", true)).rejects.toThrow();
    await expect(policy.assertAllowed("https://example.com", true)).rejects.toThrow();
  });

  it("data/blob 只可作为子资源", async () => {
    const policy = new UrlPolicy(async () => []);
    await expect(policy.assertAllowed("data:text/plain,ok", false)).resolves.toMatchObject({ protocol: "data:" });
    await expect(policy.assertAllowed("blob:https://example.com/id", false)).resolves.toMatchObject({ protocol: "blob:" });
    await expect(policy.assertAllowed("data:text/plain,ok", true)).rejects.toThrow();
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.0.2.1",
    "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "100.100.100.200", "::", "::1", "2001:db8::1", "2002::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
  ])("拒绝受保护地址 %s", (address) => {
    expect(blockedAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"])("接受公网地址 %s", (address) => {
    expect(blockedAddress(address)).toBe(false);
  });
});
