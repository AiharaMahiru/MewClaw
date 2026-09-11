import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocationPreference, parseLocation } from './location.js';

describe('会话位置偏好', () => {
  it('拒绝任意位置及对象', () => {
    for (const value of ['desktop', '', '../local', {}, null]) expect(() => parseLocation(value)).toThrow('INVALID_LOCATION');
  });
  it('只改变下一次启动，当前实例的路由保持固定', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mewclaw-location-'));
    try {
      const current = new LocationPreference(home);
      expect(current.location).toBe('cloud');
      await current.save('local');
      expect(current.location).toBe('cloud');
      expect(new LocationPreference(home).location).toBe('local');
      expect(JSON.parse(await readFile(join(home, 'mewclaw-location.json'), 'utf8'))).toEqual({ location: 'local' });
      await writeFile(join(home, 'mewclaw-location.json'), '{broken');
      expect(() => new LocationPreference(home)).toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
