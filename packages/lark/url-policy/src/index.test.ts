import { describe, expect, it, vi } from "vitest";

import { blockedAddress, guardedLookup, UrlPolicy, type ConnectLookupCallback } from "./index.js";

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

describe("guardedLookup", () => {
  const call = (lookup: ReturnType<typeof guardedLookup>, hostname: string, all = false) =>
    new Promise<{ address: unknown; family?: number | undefined }>((resolvePromise, reject) => {
      const callback: ConnectLookupCallback = (error, address, family) =>
        error ? reject(error) : resolvePromise({ address, family });
      lookup(hostname, { all }, callback);
    });

  it("放行公网解析结果的首个地址", async () => {
    const lookup = guardedLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
    await expect(call(lookup, "example.com")).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("all=true（autoSelectFamily）回传全部安全地址", async () => {
    const lookup = guardedLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
    await expect(call(lookup, "example.com", true)).resolves.toEqual({
      address: [{ address: "93.184.216.34", family: 4 }, { address: "1.1.1.1", family: 4 }],
      family: undefined,
    });
  });

  it("解析结果任一命中受保护地址则整体拒绝", async () => {
    const lookup = guardedLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(call(lookup, "rebind.example")).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("元数据主机与解析失败同样拒绝", async () => {
    await expect(call(guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }]), "metadata.google.internal")).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(call(guardedLookup(async () => { throw new Error("dns down"); }), "example.com")).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(call(guardedLookup(async () => []), "example.com")).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});
