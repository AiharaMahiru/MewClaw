/** 无账号、无模型请求的 Electron 本地会话界面冒烟。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const candidate = resolve(process.argv[2]);
const mode = process.argv[3] ?? 'advanced';
const dev = process.argv.includes('--dev');
const directoryTest = process.argv.includes('--directory');
const home = await mkdtemp(join(tmpdir(), 'mewclaw-local-ui-'));
await mkdir(join(home, 'userdata'));
await writeFile(join(home, 'mewclaw-location.json'), JSON.stringify({ location: 'local' }));
await writeFile(join(home, 'settings.yaml'), `dsh-desktop:\n  mode: ${mode}\n  port: 0\n  openBrowser: false\n`);
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const inspectorPort = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const executable = dev ? join(candidate, 'node_modules/electron/dist/electron.exe') : join(candidate, 'release/desktop.6/win-unpacked/MewClaw.exe');
const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [...(directoryTest ? [`--inspect=${inspectorPort}`] : []), ...(dev ? [join(candidate, 'launcher.mjs')] : []), `--user-data-dir=${join(home, 'userdata')}`, `--remote-debugging-port=${port}`], {
  cwd: candidate, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const rendererErrors = [];
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });

async function connect(url, pageUrl = '') {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Runtime.exceptionThrown' || (value.method === 'Log.entryAdded' && value.params?.entry?.level === 'error')
      || (value.method === 'Runtime.consoleAPICalled' && value.params?.type === 'error')) rendererErrors.push({ page: pageUrl.split('?')[0], ...value });
    if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
  });
  return { socket, send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP_TIMEOUT')); }, 5000);
      pending.set(next, value => { clearTimeout(timer); resolve(value); });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  } };
}

let client;
let connectedId;
let passed = false;
async function waitForLocation(expected) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      const page = pages.find(value => value.type === 'page' && value.url.startsWith('http://127.0.0.1:'));
      if (page) {
        if (!client || connectedId !== page.id || client.socket.readyState !== WebSocket.OPEN) {
          client?.socket.close(); client = await connect(page.webSocketDebuggerUrl, page.url); connectedId = page.id;
        }
        const result = await client.send('Runtime.evaluate', { expression: "fetch('/api/mewclaw-desktop/location').then(r=>r.json()).then(v=>v.location)", awaitPromise: true, returnByValue: true });
        if (result.result?.result?.value === expected) return;
      }
    } catch { /* 重启期间端口短暂关闭。 */ }
    await delay(500);
  }
  throw new Error(`LOCATION_RESTART_TIMEOUT_${expected}`);
}
try {
  const deadline = Date.now() + 45000;
  let text = '';
  let readyChecks = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('ELECTRON_EXITED');
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
    const page = pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')) ?? pages.find(page => page.type === 'page');
    if (page) {
      if (!client || connectedId !== page.id) {
        client?.socket.close(); client = await connect(page.webSocketDebuggerUrl, page.url); connectedId = page.id;
        await client.send('Runtime.enable'); await client.send('Log.enable');
      }
      const result = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      text = result.result?.result?.value ?? '';
      if (text.includes('确认跳过')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='确认跳过')?.click()" });
      else if (text.includes('跳过设置')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='跳过设置')?.click()" });
      if (text.includes('内测声明')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='继续')?.click()" });
      if (text.includes('打开本地目录') && text.includes('新建会话') && text.includes('选择工作区') && !text.includes('内测声明') && !text.includes('Failed to load plugins')) readyChecks++;
      else readyChecks = 0;
      if (readyChecks >= 3) { passed = true; break; }
    }
    await delay(500);
  }
  if (client) {
    const capture = await client.send('Page.captureScreenshot');
    if (capture.result?.data) await writeFile(join(home, 'local-ui.png'), Buffer.from(capture.result.data, 'base64'));
    await writeFile(join(home, 'body.txt'), text);
  }
  if (!passed) throw new Error('LOCAL_SIDEBAR_NOT_RENDERED');
  const state = await client.send('Runtime.evaluate', { expression: `fetch('/api/mewclaw-desktop/location').then(r=>r.json()).then(v=>v.location)`, awaitPromise: true, returnByValue: true });
  if (state.result?.result?.value !== 'local') throw new Error('WRONG_LOCAL_RUNTIME');
  const layout = await client.send('Runtime.evaluate', { expression: "new URL(location.href).searchParams.get('dsh-desktop-mode')", returnByValue: true });
  if (layout.result?.result?.value !== mode) throw new Error(`WRONG_LAYOUT_${layout.result?.result?.value}`);
  if (directoryTest) {
    const folder = join(home, 'authorized-workspace');
    await mkdir(folder);
    const targets = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`).then(r => r.json());
    const inspector = await connect(targets[0].webSocketDebuggerUrl);
    const patched = await inspector.send('Runtime.evaluate', { expression: `(()=>{const {dialog}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(folder)}]});return true})()`, awaitPromise: true, returnByValue: true });
    inspector.socket.close();
    if (patched.result?.result?.value !== true) throw new Error(`TEST_PICKER_NOT_INSTALLED ${JSON.stringify(patched)}`);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('button[title="打开本地目录"]').click()` });
    await delay(5000);
    const body = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    await writeFile(join(home, 'directory-body.txt'), body.result?.result?.value ?? '');
    await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
    const editable = await client.send('Runtime.evaluate', { expression: `!!document.querySelector('[contenteditable="true"],textarea:not([disabled])')`, returnByValue: true });
    if (!editable.result?.result?.value) throw new Error('DIRECTORY_COMPOSER_DISABLED');
    console.log('DIRECTORY_COMPOSER_EDITABLE');
  }
  await delay(3000);
  await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
  console.log(`RENDERER_ERRORS ${rendererErrors.length}`);
  if (rendererErrors.length) throw new Error('RENDERER_ERRORS_FOUND');
  if (process.argv.includes('--switch')) {
    await client.send('Runtime.evaluate', { expression: "document.querySelector('button[title=\"云端会话\"]').click()" });
    await waitForLocation('cloud');
    console.log('LOCATION_SWITCH_OK local-to-cloud');
    await client.send('Runtime.evaluate', { expression: "void fetch('/api/mewclaw-desktop/location',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({location:'local'})})" });
    await waitForLocation('local');
    console.log('LOCATION_SWITCH_OK cloud-to-local');
  }
  console.log(`LOCAL_UI_OK ${mode} ${dev ? 'development-runtime' : 'Release'} evidence=${home}`);
} catch (error) {
  console.error(String(error));
  const sanitized = output.replace(/([?&]token=)[^\s"&]+/g, '$1[redacted]').replace(/dsh-auth-[^\s";]+/g, '[redacted]');
  await writeFile(join(home, 'startup.log'), sanitized);
  console.error(`LOCAL_UI_FAILED evidence=${home}`);
  process.exitCode = 1;
} finally {
  if (client) { await client.send('Browser.close').catch(() => {}); client.socket.close(); }
  if (child.exitCode === null) child.kill();
}
