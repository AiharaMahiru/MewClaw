import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocationPreference, parseLocation } from './location.js';

describe('会话位置偏好', () => {
  it('拒绝任意位置及对象', () => {
    for (const value of ['desktop', '', '../local', {}, null]) expect(() => parseLocation(value)).toThrow('INVALID_LOCATION');
  });
  it('持久化后立即更新当前实例，供页面刷新使用', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mewclaw-location-'));
    try {
      const current = new LocationPreference(home);
      expect(current.location).toBe('cloud');
      const changes: string[] = [];
      current.subscribe((next, previous) => { changes.push(`${previous}->${next}`); });
      await current.save('local');
      expect(current.location).toBe('local');
      expect(changes).toEqual(['cloud->local']);
      expect(new LocationPreference(home).location).toBe('local');
      expect(JSON.parse(await readFile(join(home, 'mewclaw-location.json'), 'utf8'))).toEqual({ location: 'local' });
      await writeFile(join(home, 'mewclaw-location.json'), '{broken');
      expect(() => new LocationPreference(home)).toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
