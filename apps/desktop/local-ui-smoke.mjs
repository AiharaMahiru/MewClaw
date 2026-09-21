/** 无账号、无模型请求的 Electron 本地会话界面冒烟。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const { releaseDirectoryName } = createRequire(import.meta.url)('./release-path.cjs');

const candidate = resolve(process.argv[2]);
const mode = process.argv[3] ?? 'advanced';
const dev = process.argv.includes('--dev');
const directoryTest = process.argv.includes('--directory');
const home = await mkdtemp(join(tmpdir(), 'mewclaw-local-ui-'));
await mkdir(join(home, 'userdata'));
await writeFile(join(home, 'mewclaw-location.json'), JSON.stringify({ location: 'local' }));
await writeFile(join(home, 'settings.yaml'), `dsh-desktop:\n  mode: ${mode}\n  port: 0\n  openBrowser: false\n`);
// 目录用例需要本地会话带可解析模型：桥接目录来自云端账号，冒烟以 loopback mock 顶替
// /auth/models 并注入会话 cookie。MEWCLAW_CLOUD_MODEL_ORIGIN 只改模型桥接，页面 /auth
// 代理仍走真实云端（不影响 --switch 的云端访问）。
let mockCatalogHits = 0;
let mockServer;
let mockOrigin;
if (directoryTest) {
  mockServer = createHttpServer((req, res) => {
    if ((req.url ?? '').startsWith('/auth/models')) {
      mockCatalogHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ profiles: [], defaultProfileId: null,
        sharedModels: [{ provider: 'deepseek-official', model: 'deepseek-smoke-v1', name: 'DeepSeek Smoke V1',
          reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }],
          defaultReasoningEffort: 'high' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"NOT_FOUND"}');
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  mockOrigin = `http://127.0.0.1:${mockServer.address().port}`;
}
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const inspectorPort = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const candidateVersion = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')).version;
const executable = dev ? join(candidate, 'node_modules/electron/dist/electron.exe')
  : join(candidate, 'release', releaseDirectoryName(candidateVersion), 'win-unpacked', 'MewClaw.exe');
const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...(mockOrigin ? { MEWCLAW_CLOUD_MODEL_ORIGIN: mockOrigin } : {}) };
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
    const entry = value.params?.entry;
    // 冒烟注入的是假会话，页面 /auth/* 仍代理真实云端：上游抖动产生的资源错误与本用例无关；
    // file:// 原生向导页 meta CSP 提示是 Chromium 既有噪声。其余错误一律计入。
    const ignorable = value.method === 'Log.entryAdded' && entry
      && ((entry.source === 'network' && /^https?:\/\/[^/]+\/auth\//.test(entry.url ?? ''))
        || (entry.source === 'security' && /frame-ancestors/.test(entry.text ?? '')));
    if (!ignorable && (value.method === 'Runtime.exceptionThrown' || (value.method === 'Log.entryAdded' && entry?.level === 'error')
      || (value.method === 'Runtime.consoleAPICalled' && value.params?.type === 'error'))) rendererErrors.push({ page: pageUrl.split('?')[0], ...value });
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
      // 2.0.10 的跳过确认弹层与向导页都含"跳过设置"按钮：优先点 dialog 内的，命中不到再回退最后一个同名按钮。
      if (text.includes('确认跳过')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='确认跳过')?.click()" });
      else if (text.includes('跳过设置')) await client.send('Runtime.evaluate', { expression: "(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='跳过设置');(bs.find(b=>b.closest('[role=\"dialog\"],dialog,[data-state=\"open\"]'))??bs.at(-1))?.click()})()" });
      if (text.includes('内测声明')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='继续')?.click()" });
      const hasNewSessionLabel = text.includes('新建会话') || text.includes('新会话');
      if (text.includes('打开本地目录') && hasNewSessionLabel && text.includes('选择工作区') && !text.includes('内测声明') && !text.includes('Failed to load plugins')) readyChecks++;
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
    // 桥接目录需要会话 cookie：注入后一次已认证的同站 GET '/' 触发快照与本地默认模型重排
    //（'/api/mewclaw-desktop/*' 与 '/_dsh/*' 在快照前分流，'/auth/*' 依赖真实上游，都不能用）。
    // 页面可能仍在过渡，注入在轮询里幂等重放直到目录被拉取。
    const syncDeadline = Date.now() + 25000;
    let syncedText = '';
    while (Date.now() < syncDeadline) {
      const probe = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      syncedText = probe.result?.result?.value ?? '';
      if (mockCatalogHits > 0 && syncedText.includes('DeepSeek Smoke V1')) break;
      await client.send('Runtime.evaluate', { expression: "document.cookie='dsh_session=smoke-local;path=/';document.cookie='dsh_csrf=smoke-local;path=/';fetch('/').then(r=>r.status).catch(()=>0)", awaitPromise: true });
      await delay(500);
    }
    if (mockCatalogHits === 0) throw new Error(`LOCAL_MODEL_CATALOG_NOT_FETCHED cookie=${syncedText.length}`);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('button[title="打开本地目录"]').click()` });
    const editDeadline = Date.now() + 15000;
    let editable = false;
    while (Date.now() < editDeadline) {
      const probe = await client.send('Runtime.evaluate', { expression: `!!document.querySelector('[contenteditable="true"],textarea:not([disabled])')`, returnByValue: true });
      if (probe.result?.result?.value) { editable = true; break; }
      await delay(500);
    }
    const body = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    await writeFile(join(home, 'directory-body.txt'), body.result?.result?.value ?? '');
    await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
    if (!editable) throw new Error('DIRECTORY_COMPOSER_DISABLED');
    console.log('DIRECTORY_COMPOSER_EDITABLE');
    // 思考强度滑条：本地与云端同一 dsh-lark-model-seat——点模型芯片开弹层，
    // 胶囊轨道在 .mwseat-menu 内（mock 目录带 reasoningEfforts）。
    const seatDeadline = Date.now() + 10000;
    let seatReady = false;
    while (Date.now() < seatDeadline) {
      const probe = await client.send('Runtime.evaluate', { expression: "(()=>{const t=document.querySelector('.mwseat-trigger');return t?t.textContent.trim():null})()", returnByValue: true });
      if (probe.result?.result?.value?.includes('DeepSeek Smoke V1')) { seatReady = true; break; }
      await delay(500);
    }
    if (!seatReady) {
      const debug = await client.send('Runtime.evaluate', { expression: `(()=>{const g=globalThis.__DSH_BOOT__;return {entries:(g?.entries??[]).map(e=>e.id),hasSeat:!!document.querySelector('.mwseat-trigger'),style:!!document.getElementById('dsh-lark-model-seat'),dockNames:[...document.querySelectorAll('[data-slot]')].map(e=>e.getAttribute('data-slot'))}})()`, returnByValue: true });
      throw new Error(`MODEL_SEAT_MISSING ${JSON.stringify(debug.result?.result?.value)}`);
    }
    await client.send('Runtime.evaluate', { expression: "document.querySelector('.mwseat-trigger')?.click()" });
    const sliderDeadline = Date.now() + 8000;
    let slider = null;
    while (Date.now() < sliderDeadline) {
      const probe = await client.send('Runtime.evaluate', { expression: "(()=>{const s=document.querySelector('.mwseat-menu [role=\"slider\"]');return s?{label:s.getAttribute('aria-valuetext'),max:s.getAttribute('aria-valuemax'),text:s.parentElement?.textContent}:null})()", returnByValue: true });
      slider = probe.result?.result?.value ?? null;
      if (slider) break;
      await delay(400);
    }
    if (!slider) throw new Error('EFFORT_SLIDER_MISSING');
    if (slider.label !== '高' || slider.max !== '2') throw new Error(`EFFORT_SLIDER_WRONG ${JSON.stringify(slider)}`);
    console.log(`EFFORT_SLIDER_OK ${slider.label}`);
    await client.send('Runtime.evaluate', { expression: 'document.body.click()' });
    // preset roster：本地模式下拉应与云端同款四项（remoteExportList 复刻 Edge
    // 过滤+改名，客户端字典再对 system preset 做 i18n 覆盖）。
    const roster = await client.send('Runtime.evaluate', { expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/标准模式|轻量|全功能|创造|PTC|极简|优化|助手|执行/.test(x.textContent));b?.click();return new Promise(r=>setTimeout(()=>{const items=[...document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"],li')].map(x=>x.textContent.trim()).filter(Boolean);document.body.click();r(items)},600))})()`, awaitPromise: true, returnByValue: true });
    const rosterText = JSON.stringify(roster.result?.result?.value ?? []);
    for (const expected of ['日常助手', '创造模式', '高效执行', '标准模式']) {
      if (!rosterText.includes(expected)) throw new Error(`PRESET_MISSING_${expected} ${rosterText.slice(0, 400)}`);
    }
    for (const hidden of ['飞书轻量', '飞书全功能', '全能优化', 'PTC', '极简']) {
      if (rosterText.includes(hidden)) throw new Error(`PRESET_LEAKED_${hidden} ${rosterText.slice(0, 400)}`);
    }
    console.log('PRESET_ROSTER_OK 4');
  }
  await delay(3000);
  await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
  console.log(`RENDERER_ERRORS ${rendererErrors.length}`);
  if (rendererErrors.length) throw new Error('RENDERER_ERRORS_FOUND');
  if (process.argv.includes('--switch')) {
    await client.send('Runtime.evaluate', { expression: "(document.querySelector('button[title=\"云端模式\"],button[aria-label=\"云端模式\"]')||Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='云端'))?.click()" });
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
  mockServer?.close();
}
