import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocationPreference } from './location.js';
import { locationRoute } from './location-route.js';

it('模式控制面拒绝跨源与无授权请求，并在同一进程内完成双向切换', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mewclaw-location-route-'));
  const preference = new LocationPreference(home);
  let denied: number | undefined;
  const server = createServer(locationRoute({ preference, reject: () => denied }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const url = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ location: 'local' });
  try {
    expect((await fetch(url, { method: 'POST', body })).status).toBe(403);
    denied = 403;
    expect((await fetch(url)).status).toBe(403);
    denied = undefined;
    const accepted = await fetch(url, { method: 'POST', body, headers: { origin: url } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ location: 'local', reload: true });
    expect(preference.location).toBe('local');
    expect(new LocationPreference(home).location).toBe('local');
    expect(await (await fetch(url)).json()).toEqual({ location: 'local' });
    const back = await fetch(url, { method: 'POST', body: JSON.stringify({ location: 'cloud' }), headers: { origin: url } });
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ location: 'cloud', reload: true });
    expect(preference.location).toBe('cloud');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
