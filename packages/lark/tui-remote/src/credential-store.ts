import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CredentialStore, StoredCredential } from './types.js';

/** 进程内凭证存储，适合测试或由宿主自行管理密钥的场景。 */
export class MemoryCredentialStore implements CredentialStore {
  private value: StoredCredential | undefined;

  constructor(initial?: StoredCredential) { this.value = clone(initial); }

  async load(): Promise<StoredCredential | undefined> { return clone(this.value); }
  async save(value: StoredCredential): Promise<void> { this.value = clone(value); }
  async clear(): Promise<void> { this.value = undefined; }
}

/**
 * 本地会话 Cookie 文件：目录 0700、文件 0600、原子替换。
 *
 * 文件只包含会话 Cookie 和 endpoint，不接收密码、API Key 或 Worker token。
 * 若宿主有系统钥匙串，应实现 CredentialStore 并替换此实现。
 */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = defaultCredentialPath()) { this.path = path; }

  async load(): Promise<StoredCredential | undefined> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error('REMOTE_CREDENTIAL_READ_FAILED');
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!validStoredCredential(value)) return undefined;
      return clone(value);
    } catch {
      return undefined;
    }
  }

  async save(value: StoredCredential): Promise<void> {
    if (!validStoredCredential(value)) throw new Error('REMOTE_CREDENTIAL_INVALID');
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await chmod(directory, 0o700); } catch { /* Windows 无 POSIX mode 时继续。 */ }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await chmod(temporary, 0o600); } catch { /* Windows 无 POSIX mode 时继续。 */ }
      await rename(temporary, this.path);
      try { await chmod(this.path, 0o600); } catch { /* Windows 无 POSIX mode 时继续。 */ }
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error('REMOTE_CREDENTIAL_WRITE_FAILED');
    }
  }

  async clear(): Promise<void> {
    try { await rm(this.path, { force: true }); }
    catch { throw new Error('REMOTE_CREDENTIAL_CLEAR_FAILED'); }
  }
}

export function defaultCredentialPath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME?.trim();
  return join(configRoot || join(homedir(), '.config'), 'dsh-tui', 'remote-session.json');
}

function validStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.endpoint !== 'string' || !Array.isArray(record.cookies)) return false;
  return record.cookies.every(cookie => {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) return false;
    const item = cookie as Record<string, unknown>;
    return typeof item.name === 'string' && typeof item.value === 'string'
      && typeof item.path === 'string' && item.path.startsWith('/')
      && typeof item.secure === 'boolean'
      && (item.expiresAt === undefined || typeof item.expiresAt === 'number');
  });
}

function clone(value: StoredCredential | undefined): StoredCredential | undefined {
  if (!value) return undefined;
  return { endpoint: value.endpoint, cookies: value.cookies.map(cookie => ({ ...cookie })) };
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
