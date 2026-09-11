/** 模式在 Host 生命周期内不可变，避免旧请求跨越云端/本地边界。 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionLocation = 'cloud' | 'local';
export function parseLocation(value: unknown): SessionLocation {
  if (value !== 'cloud' && value !== 'local') throw new Error('INVALID_LOCATION');
  return value;
}

export class LocationPreference {
  readonly location: SessionLocation;
  private readonly path: string;
  constructor(private readonly home: string) {
    this.path = join(home, 'mewclaw-location.json');
    try { this.location = parseLocation(JSON.parse(readFileSync(this.path, 'utf8')).location); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.location = 'cloud';
    }
  }

  async save(value: SessionLocation): Promise<void> {
    const location = parseLocation(value);
    await mkdir(this.home, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ location }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}
