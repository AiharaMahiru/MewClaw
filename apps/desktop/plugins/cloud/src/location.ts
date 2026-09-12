/** 进程内的云端/本地位置状态；持久化后立即对当前 WebServer 生效。 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionLocation = 'cloud' | 'local';
export function parseLocation(value: unknown): SessionLocation {
  if (value !== 'cloud' && value !== 'local') throw new Error('INVALID_LOCATION');
  return value;
}

export type LocationChangeListener = (next: SessionLocation, previous: SessionLocation) => void | Promise<void>;

export class LocationPreference {
  private current: SessionLocation;
  private readonly path: string;
  private readonly listeners = new Set<LocationChangeListener>();

  constructor(private readonly home: string) {
    this.path = join(home, 'mewclaw-location.json');
    try { this.current = parseLocation(JSON.parse(readFileSync(this.path, 'utf8')).location); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.current = 'cloud';
    }
  }

  get location(): SessionLocation { return this.current; }

  subscribe(listener: LocationChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async save(value: SessionLocation): Promise<void> {
    const location = parseLocation(value);
    if (location === this.current) return;
    await mkdir(this.home, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ location }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
    const previous = this.current;
    this.current = location;
    try {
      for (const listener of this.listeners) await listener(location, previous);
    } catch (error) {
      this.current = previous;
      await this.write(previous);
      throw error;
    }
  }

  private async write(location: SessionLocation): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ location }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}
