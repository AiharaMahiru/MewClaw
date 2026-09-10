import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UrlPolicyError extends Error {
  constructor(message = "URL 被安全策略拒绝") {
    super(message);
    this.name = "UrlPolicyError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface ResolvedUrl {
  url: URL;
  addresses: readonly ResolvedAddress[];
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data",
]);

const METADATA_ADDRESSES = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
]);

export class UrlPolicy {
  constructor(private readonly resolveDns: DnsResolver = systemResolver) {}

  async assertAllowed(input: string, topLevel: boolean): Promise<URL> {
    return (await this.resolveAllowed(input, topLevel)).url;
  }

  async resolveAllowed(input: string, topLevel: boolean): Promise<ResolvedUrl> {
    let url: URL;
    try { url = new URL(input); } catch { throw new UrlPolicyError("URL 格式非法"); }
    if (!topLevel && (url.protocol === "data:" || url.protocol === "blob:")) return { url, addresses: [] };
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlPolicyError("仅允许 HTTP/HTTPS");
    if (url.username || url.password) throw new UrlPolicyError("URL 不得包含凭证");
    const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
    if (!hostname || METADATA_HOSTS.has(hostname) || hostname.endsWith(".metadata.google.internal")) {
      throw new UrlPolicyError();
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolveDns(hostname).catch(() => { throw new UrlPolicyError("DNS 解析失败"); });
    if (addresses.length === 0 || addresses.some(({ address }) => blockedAddress(address))) throw new UrlPolicyError();
    return { url, addresses };
  }
}

async function systemResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export function blockedAddress(input: string): boolean {
  const address = stripBrackets(input).toLowerCase().split("%")[0] || "";
  if (METADATA_ADDRESSES.has(address)) return true;
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0) || a >= 224;
  }
  if (isIP(address) !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = bytes.every((value) => value === 0);
  const loopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const uniqueLocal = (first & 0xfe) === 0xfc;
  const linkLocal = first === 0xfe && (second & 0xc0) === 0x80;
  const multicast = first === 0xff;
  const mapped = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const documentation = first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const transition = first === 0x20 && ((second === 0x01 && bytes[2] === 0 && bytes[3] === 0) || second === 0x02);
  const globalUnicast = (first & 0xe0) === 0x20;
  return allZero || loopback || uniqueLocal || linkLocal || multicast || !globalUnicast || documentation || transition
    || (mapped && blockedAddress(bytes.slice(12).join(".")));
}

function ipv6Bytes(input: string): number[] | undefined {
  const [leftInput, rightInput = ""] = input.split("::", 2);
  if (input.split("::").length > 2) return undefined;
  const left = ipv6Groups(leftInput || "");
  const right = ipv6Groups(rightInput);
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function ipv6Groups(input: string): number[] | undefined {
  if (!input) return [];
  const parts = input.split(":");
  const result: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      if (isIP(part) !== 4) return undefined;
      const values = part.split(".").map(Number);
      result.push(((values[0] ?? 0) << 8) | (values[1] ?? 0), ((values[2] ?? 0) << 8) | (values[3] ?? 0));
    } else {
      if (!/^[\da-f]{1,4}$/i.test(part)) return undefined;
      result.push(Number.parseInt(part, 16));
    }
  }
  return result;
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
