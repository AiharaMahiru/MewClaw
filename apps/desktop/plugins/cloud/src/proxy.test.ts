import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { CloudProxy, cloudOrigin } from './proxy.js';

const servers: Server[] = [];
const proxies: CloudProxy[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const proxy of proxies.splice(0)) proxy.dispose();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function fixture(handler: RequestListener): Promise<{ origin: string; proxy: CloudProxy; cloud: string }> {
  const cloud = await listen(createServer(handler));
  const proxy = new CloudProxy({ origin: cloud, timeoutMs: 1000 }); proxies.push(proxy);
  const origin = await listen(createServer((req, res) => proxy.http(req, res)));
  return { origin, proxy, cloud };
}

describe('桌面固定云端传输', () => {
  it('拒绝带凭证、路径及非回环明文上游', () => {
    for (const value of ['https://u:p@example.com', 'https://example.com/path', 'http://example.com', 'https://example.com/?x=1']) expect(() => cloudOrigin(value)).toThrow();
    expect(cloudOrigin('https://chat.rwr.ink').origin).toBe('https://chat.rwr.ink');
  });
  it('不发送本地令牌与 Cookie，保留云端 CSRF 对和请求正文', async () => {
    const { origin, cloud } = await fixture(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString() }));
    });
    const response = await fetch(`${origin}/?token=LOCAL&dsh-desktop-mode=compatibility`, {
      method: 'POST', headers: { cookie: 'dsh-auth-local=SECRET; dsh_session=CLOUD; dsh_csrf=CSRF', 'x-csrf-token': 'CSRF', 'x-dsh-desktop-renderer': 'LOCAL', origin, 'content-type': 'application/json' }, body: '{"hello":true}',
    });
    const value = await response.json();
    expect(value.headers.cookie).toBe('dsh_session=CLOUD; dsh_csrf=CSRF');
    expect(value.headers['x-csrf-token']).toBe('CSRF');
    expect(value.headers['x-dsh-desktop-renderer']).toBeUndefined();
    expect(value.headers.origin).toBe(cloud);
    expect(value.url).toBe('/'); expect(value.body).toBe('{"hello":true}');
  });
  it('保留密码重置等云端端点的 token 参数', async () => {
    const { origin } = await fixture((req, res) => res.end(req.url));
    expect(await (await fetch(`${origin}/auth/reset?token=CLOUD`)).text()).toBe('/auth/reset?token=CLOUD');
  });
  it('将远程设置与账号模型目录保持原路径转发到云端', async () => {
    const seen: string[] = [];
    const { origin } = await fixture((req, res) => { seen.push(req.url ?? ''); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    expect((await fetch(`${origin}/api/dsh-web-ui-settings/describe`)).status).toBe(200);
    expect((await fetch(`${origin}/auth/models`)).status).toBe(200);
    expect(seen).toEqual(['/api/dsh-web-ui-settings/describe', '/auth/models']);
  });
  it('同源重定向变为相对路径，保留安全 Cookie 属性', async () => {
    let cloud = '';
    const result = await fixture((_req, res) => { res.writeHead(302, { location: `${cloud}/auth/account`, 'set-cookie': 'dsh_session=value; Secure; HttpOnly; SameSite=Lax; Path=/' }); res.end(); });
    cloud = result.cloud;
    const response = await fetch(result.origin, { redirect: 'manual' });
    expect(response.headers.get('location')).toBe('/auth/account');
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly');
  });
  it('Provider 退出后拒绝新请求', async () => {
    const { origin, proxy } = await fixture((_req, res) => res.end('unexpected'));
    proxy.dispose(); proxy.dispose();
    expect((await fetch(origin)).status).toBe(503);
  });
});
