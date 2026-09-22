import type { CredentialCookie } from './types.js';

/** 仅保存当前 dsh Web origin 的 Cookie；不实现跨域或 Domain Cookie。 */
export class CookieJar {
  private readonly cookies = new Map<string, CredentialCookie>();

  static from(records: readonly CredentialCookie[]): CookieJar {
    const jar = new CookieJar();
    jar.replace(records);
    return jar;
  }

  replace(records: readonly CredentialCookie[]): void {
    this.cookies.clear();
    for (const record of records) if (validRecord(record)) this.cookies.set(record.name, { ...record });
    this.prune();
  }

  setFromHeaders(headers: Headers, requestUrl: URL): void {
    const source = headers as Headers & { getSetCookie?: () => string[] };
    const values = typeof source.getSetCookie === 'function'
      ? source.getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));
    for (const value of values) this.setFromHeader(value, requestUrl);
    this.prune();
  }

  setFromHeader(header: string, requestUrl: URL): void {
    const pieces = header.split(';').map(item => item.trim());
    const first = pieces.shift();
    if (!first) return;
    const separator = first.indexOf('=');
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const rawValue = first.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name)) return;
    const attributes = new Map<string, string | true>();
    for (const piece of pieces) {
      const index = piece.indexOf('=');
      const key = (index < 0 ? piece : piece.slice(0, index)).trim().toLowerCase();
      if (!key) continue;
      attributes.set(key, index < 0 ? true : piece.slice(index + 1).trim());
    }
    const domain = attributes.get('domain');
    // 远程客户端拒绝 Domain Cookie，避免意外把会话送到同主域的其他服务。
    if (typeof domain === 'string' && domain.length > 0) return;
    const pathValue = attributes.get('path');
    const path = typeof pathValue === 'string' && pathValue.startsWith('/') ? pathValue : '/';
    const secure = attributes.has('secure');
    if (secure && requestUrl.protocol !== 'https:') return;
    const maxAgeValue = attributes.get('max-age');
    let expiresAt: number | undefined;
    if (typeof maxAgeValue === 'string' && /^-?\d+$/u.test(maxAgeValue)) {
      const seconds = Number(maxAgeValue);
      expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
    } else {
      const expiresValue = attributes.get('expires');
      if (typeof expiresValue === 'string') {
        const timestamp = Date.parse(expiresValue);
        if (Number.isFinite(timestamp)) expiresAt = timestamp;
      }
    }
    if (expiresAt === 0) {
      this.cookies.delete(name);
      return;
    }
    const value = decodeCookieValue(rawValue);
    if (value === undefined) return;
    const record: CredentialCookie = { name, value, path, secure, ...(expiresAt === undefined ? {} : { expiresAt }) };
    this.cookies.set(name, record);
  }

  header(requestUrl: URL): string | undefined {
    this.prune();
    const secureTransport = requestUrl.protocol === 'https:' || requestUrl.protocol === 'wss:';
    const values = [...this.cookies.values()]
      .filter(cookie => (!cookie.secure || secureTransport) && pathMatches(requestUrl.pathname, cookie.path))
      .sort((left, right) => right.path.length - left.path.length)
      .map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`);
    return values.length > 0 ? values.join('; ') : undefined;
  }

  csrf(): string | undefined {
    this.prune();
    return this.cookies.get('dsh_csrf')?.value;
  }

  export(): CredentialCookie[] {
    this.prune();
    return [...this.cookies.values()].map(cookie => ({ ...cookie }));
  }

  clear(): void { this.cookies.clear(); }

  delete(name: string): void { this.cookies.delete(name); }

  private prune(): void {
    const now = Date.now();
    for (const [name, cookie] of this.cookies) if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.cookies.delete(name);
  }
}

function validRecord(value: unknown): value is CredentialCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string'
    && typeof record.value === 'string'
    && typeof record.path === 'string'
    && record.path.startsWith('/')
    && typeof record.secure === 'boolean'
    && (record.expiresAt === undefined || typeof record.expiresAt === 'number');
}

function decodeCookieValue(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/') return requestPath.startsWith('/');
  return requestPath === cookiePath || requestPath.startsWith(`${cookiePath}/`);
}

/** 兼容没有 Headers.getSetCookie() 的 Fetch 实现；服务端 Cookie 值不含逗号。 */
function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/u).map(item => item.trim()).filter(Boolean);
}
