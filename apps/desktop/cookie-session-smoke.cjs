/** 无账号凭证：通过真实代理与Electron验证重启保持、退出登录和再次重启。 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const [candidate, dataPath, action] = process.argv.slice(2);
app.setPath('userData', dataPath);
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function run() {
  const { CloudProxy } = await import(pathToFileURL(join(candidate, 'mewclaw-cloud/lib/proxy.js')).href);
  const upstream = createServer((req, res) => {
    if (req.url === '/login') res.setHeader('set-cookie', [
      '__Host-dsh_session=fake; Path=/; Secure; HttpOnly; SameSite=Lax',
      'dsh_csrf=fake; Path=/; Secure; SameSite=Lax',
    ]);
    if (req.url === '/logout') res.setHeader('set-cookie', [
      '__Host-dsh_session=; Path=/; Secure; HttpOnly; Max-Age=0',
      'dsh_csrf=; Path=/; Secure; Max-Age=0',
    ]);
    res.end('<!doctype html><title>Session test</title>');
  });
  const proxy = new CloudProxy({ origin: await listen(upstream), timeoutMs: 5000, sessionRetentionSeconds: 3600 });
  const server = createServer((req, res) => proxy.http(req, res));
  const origin = await listen(server);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:desktop-cookie-smoke', sandbox: true } });
  try {
    await window.loadURL(origin + (action === 'login' ? '/login' : '/'));
    const cookies = await window.webContents.session.cookies.get({ url: origin });
    const authenticated = cookies.some(cookie => cookie.name === '__Host-dsh_session' && cookie.httpOnly && cookie.secure && !cookie.session);
    const csrf = cookies.some(cookie => cookie.name === 'dsh_csrf');
    if (authenticated !== (action !== 'check-logout') || csrf !== (action !== 'check-logout')) throw new Error('COOKIE_RESTART_ASSERTION_FAILED');
    if (action === 'logout') await window.loadURL(origin + '/logout');
    await window.webContents.session.cookies.flushStore();
    console.log('DESKTOP_SESSION_' + action.toUpperCase() + '_OK');
  } finally {
    window.destroy(); proxy.dispose();
    server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close();
    app.quit();
  }
}
run().catch(() => { console.error('DESKTOP_SESSION_SMOKE_FAILED'); app.exit(1); });
