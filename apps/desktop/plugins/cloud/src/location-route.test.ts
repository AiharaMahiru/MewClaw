import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocationPreference } from './location.js';
import { locationRoute } from './location-route.js';

it('模式控制面拒绝跨源与无授权请求，重启失败恢复偏好', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mewclaw-location-route-'));
  const preference = new LocationPreference(home);
  let denied: number | undefined;
  const restart = vi.fn(async () => { throw new Error('restart unavailable'); });
  const server = createServer(locationRoute({ preference, reject: () => denied, restart }));
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
    const response = await fetch(url, { method: 'POST', body, headers: { origin: url } });
    expect(response.status).toBe(409);
    expect(restart).toHaveBeenCalledOnce();
    expect(new LocationPreference(home).location).toBe('cloud');
    expect(await (await fetch(url)).json()).toEqual({ location: 'cloud' });
    let restartAfterResponse = false;
    restart.mockImplementation(async () => (() => { restartAfterResponse = true; }) as never);
    const accepted = await fetch(url, { method: 'POST', body, headers: { origin: url } });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ location: 'local', restarting: true });
    await vi.waitFor(() => expect(restartAfterResponse).toBe(true));
    expect(new LocationPreference(home).location).toBe('local');
    expect((await fetch(url, { method: 'POST', body, headers: { origin: url } })).status).toBe(409);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
