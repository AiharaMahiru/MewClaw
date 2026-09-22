/** 无账号、无模型请求的 Electron 本地会话界面冒烟。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const { releaseDirectoryName } = createRequire(import.meta.url)('./release-path.cjs');

const candidate = resolve(process.argv[2]);
const mode = process.argv[3] ?? 'advanced';
const dev = process.argv.includes('--dev');
const wine = process.argv.includes('--wine');
const directoryTest = process.argv.includes('--directory');
const loginArg = process.argv.indexOf('--live-login');
let loginCredentials;
if (loginArg >= 0) {
  const path = resolve(process.argv[loginArg + 1]);
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error('CREDENTIAL_FILE_PERMISSIONS');
  const { email, password } = JSON.parse(await readFile(path, 'utf8'));
  loginCredentials = { email, password };
}
const liveLogin = !!loginCredentials;
const home = await mkdtemp(join(tmpdir(), 'mewclaw-local-ui-'));
await mkdir(join(home, 'userdata'));
await writeFile(join(home, 'mewclaw-location.json'), JSON.stringify({ location: liveLogin ? 'cloud' : 'local' }));
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
        sharedModels: [{ provider: 'deepseek-official', model: 'deepseek-smoke-v1', name: 'DeepSeek Smoke V1', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultReasoningEffort: 'high' }] }));
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
const executable = dev ? join(candidate, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  : join(candidate, 'release', releaseDirectoryName(candidateVersion), 'win-unpacked', 'MewClaw.exe');
const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...(mockOrigin ? { MEWCLAW_CLOUD_MODEL_ORIGIN: mockOrigin } : {}) };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [...(wine || (dev && process.getuid?.() === 0) ? ['--no-sandbox'] : []), ...(wine ? ['--disable-gpu'] : []), ...(directoryTest ? [`--inspect=${inspectorPort}`] : []), ...(dev ? [join(candidate, 'launcher.mjs')] : []), `--user-data-dir=${join(home, 'userdata')}`, `--remote-debugging-port=${port}`], {
  cwd: candidate, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const rendererErrors = [];
const graphEvents = [];
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });

async function connect(url, pageUrl = '') {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Network.eventSourceMessageReceived') {
      const frame = JSON.parse(value.params.data);
      if (frame.type === 'graph') graphEvents.push(frame.graph);
    }
    const entry = value.params?.entry;
    // 冒烟注入的是假会话，页面 /auth/* 仍代理真实云端：上游抖动产生的资源错误与本用例无关；
    // file:// 原生向导页 meta CSP 提示是 Chromium 既有噪声。其余错误一律计入。
    const ignorable = value.method === 'Log.entryAdded' && entry
      && ((entry.source === 'network' && /^https?:\/\/[^/]+\/auth\//.test(entry.url ?? ''))
        || (entry.source === 'security' && /frame-ancestors/.test(entry.text ?? '')));
    if (!ignorable && (value.method === 'Runtime.exceptionThrown' || (value.method === 'Log.entryAdded' && entry?.level === 'error')
      || (value.method === 'Runtime.consoleAPICalled' && value.params?.type === 'error'))) rendererErrors.push({ page: pageUrl.split('?')[0], ...value });
    if (pending.has(value.id)) {
      const request = pending.get(value.id);
      clearTimeout(request.timer);
      request.resolve(value);
      pending.delete(value.id);
    }
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP_CLOSED'));
    }
    pending.clear();
  });
  return { socket, send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) { reject(new Error('CDP_CLOSED')); return; }
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP_TIMEOUT_' + method)); }, 30000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  } };
}

let client;
let connectedId;
let passed = false;
let cloudModes;
let cloudUi;
async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error('UI_EVALUATION_FAILED');
  return result.result?.result?.value;
}
async function screenshot(name) {
  const capture = await client.send('Page.captureScreenshot');
  if (capture.result?.data) await writeFile(join(home, name + '.png'), Buffer.from(capture.result.data, 'base64'));
}
async function presetMenu(name) {
  // 位置控件先于模式菜单挂载；按可交互状态等待，避免在首屏水合中抢点。
  const readyDeadline = Date.now() + 15000;
  let opened = false;
  while (Date.now() < readyDeadline) {
    opened = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>/^(Standard mode|标准模式)$/.test(b.textContent.trim()));if(!button||button.disabled)return false;button.click();return true})()`);
    if (opened) break;
    await delay(200);
  }
  if (!opened) throw new Error('MODE_TRIGGER_MISSING');
  let text;
  while (Date.now() < readyDeadline) {
    text = await evaluate(`document.querySelector('[role="menu"]')?.innerText`);
    if (text && /高效执行/.test(text)) break;
    await delay(200);
  }
  if (!text || !/高效执行/.test(text)) throw new Error('WEB_PRESET_ROSTER_MISSING');
  await screenshot(name + '-modes');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  return text;
}
async function uiRoster() {
  return evaluate(`globalThis.__DSH_BOOT__.entries.map(e=>e.id).filter(id=>id.startsWith('@deepseek-ai/dsh-client-ui-')||id.startsWith('@linxin666/')||['dsh-context','dsh-better-sidebar'].includes(id)).sort()`);
}
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
        if (result.result?.result?.value === expected) {
          if (!liveLogin) return;
          const ready = await evaluate(`globalThis.__MEWCLAW_SESSION_LOCATION__===${JSON.stringify(expected)}&&!!document.querySelector('button[aria-label="${expected === 'local' ? '本地' : '云端'}模式"][aria-pressed="true"]')&&!document.body.innerText.includes('Failed to load plugins')`);
          if (ready) { await delay(1200); await screenshot(expected + '-switched'); return; }
        }
      }
    } catch { /* 重启期间端口短暂关闭。 */ }
    await delay(500);
  }
  throw new Error(`LOCATION_RESTART_TIMEOUT_${expected}`);
}
try {
  const deadline = Date.now() + (wine ? 120000 : liveLogin ? 90000 : 45000);
  let text = '';
  let readyChecks = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('ELECTRON_EXITED');
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
    const page = pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')) ?? pages.find(page => page.type === 'page');
    if (!page) { await delay(500); continue; }
    try {
      if (!client || connectedId !== page.id || client.socket.readyState !== WebSocket.OPEN) {
        client?.socket.close(); client = await connect(page.webSocketDebuggerUrl, page.url); connectedId = page.id;
        await client.send('Runtime.enable'); await client.send('Log.enable'); await client.send('Network.enable');
      }
      const result = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      text = result.result?.result?.value ?? '';
      if (liveLogin && loginCredentials && await evaluate(`!!document.querySelector('#email')&&!!document.querySelector('#password')`)) {
        await evaluate(`(()=>{const value=${JSON.stringify(loginCredentials)};document.querySelector('#email').value=value.email;document.querySelector('#password').value=value.password;document.querySelector('#email').closest('form').requestSubmit()})()`);
        loginCredentials = undefined;
      }
      if (liveLogin && await evaluate(`globalThis.__MEWCLAW_SESSION_LOCATION__==='cloud'&&!!document.querySelector('button[aria-label="本地模式"]')`)) {
        await screenshot('cloud-initial');
        cloudModes = await presetMenu('cloud');
        cloudUi = await uiRoster();
        await evaluate(`document.querySelector('button[aria-label="本地模式"]').click()`);
        await waitForLocation('local');
      }
      // 2.0.10 的跳过确认弹层与向导页都含"跳过设置"按钮：优先点 dialog 内的，命中不到再回退最后一个同名按钮。
      if (text.includes('确认跳过') || text.includes('Confirm skip')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>/^(确认跳过|Confirm skip)$/.test(button.textContent.trim()))?.click()" });
      else if (text.includes('跳过设置') || text.includes('Skip setup')) await client.send('Runtime.evaluate', { expression: "(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>/^(跳过设置|Skip setup)$/.test(b.textContent.trim()));(bs.find(b=>b.closest('[role=\"dialog\"],dialog,[data-state=\"open\"]'))??bs.at(-1))?.click()})()" });
      if (text.includes('内测声明') || text.includes('Internal Testing Notice')) await client.send('Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('button')).find(button=>/^(继续|Continue)$/.test(button.textContent.trim()))?.click()" });
      const actionsReady = await evaluate(`!!document.querySelector('button[aria-label="云端模式"]')&&!!document.querySelector('button[aria-label="本地模式"]')&&[...document.querySelectorAll('button')].some(b=>/新建会话|新会话|new (session|chat)/i.test(b.textContent+' '+b.title+' '+b.getAttribute('aria-label')))`);
      if (actionsReady && (text.includes('选择工作区') || /(?:select|choose) workspace/i.test(text)) && !text.includes('内测声明') && !text.includes('Internal Testing Notice') && !text.includes('Failed to load plugins')) readyChecks++;
      else readyChecks = 0;
      if (readyChecks >= 3) { passed = true; break; }
    } catch (error) {
      // 首次向导关闭后会建立主窗口；旧 target 的未完成请求随连接关闭而取消。
      if (error.message !== 'CDP_CLOSED') throw error;
      connectedId = undefined;
    }
    await delay(500);
  }
  if (client) {
    await writeFile(join(home, 'graph-events.json'), JSON.stringify(graphEvents, null, 2));
    const capture = await client.send('Page.captureScreenshot');
    if (capture.result?.data) await writeFile(join(home, 'local-ui.png'), Buffer.from(capture.result.data, 'base64'));
    await writeFile(join(home, 'body.txt'), text);
    const boot = await client.send('Runtime.evaluate', { expression: `({location:globalThis.__MEWCLAW_SESSION_LOCATION__,account:globalThis.__DSH_AUTH_EDGE__,boot:globalThis.__DSH_BOOT__})`, returnByValue: true });
    await writeFile(join(home, 'boot.json'), JSON.stringify(boot.result?.result?.value, null, 2));

  }
  if (!passed) throw new Error('LOCAL_SIDEBAR_NOT_RENDERED');
  if (liveLogin) {
    const localModes = await presetMenu('local');
    const localUi = await uiRoster();
    await writeFile(join(home, 'parity.json'), JSON.stringify({ cloudModes, localModes, cloudUi, localUi }, null, 2));
    if (cloudModes !== localModes) throw new Error('PRESET_ROSTER_DIFFERS');
    if (JSON.stringify(cloudUi) !== JSON.stringify(localUi)) throw new Error('UI_PLUGIN_ROSTER_DIFFERS');
  }
  const state = await client.send('Runtime.evaluate', { expression: `fetch('/api/mewclaw-desktop/location').then(r=>r.json()).then(v=>v.location)`, awaitPromise: true, returnByValue: true });
  if (state.result?.result?.value !== 'local') throw new Error('WRONG_LOCAL_RUNTIME');
  const layout = await client.send('Runtime.evaluate', { expression: "new URL(location.href).searchParams.get('dsh-desktop-mode')", returnByValue: true });
  if (layout.result?.result?.value !== mode) throw new Error(`WRONG_LAYOUT_${layout.result?.result?.value}`);
  if (directoryTest) {
    const folder = join(home, '授权 中文工作区');
    await mkdir(folder);
    // 桥接目录需要会话 cookie：注入后一次已认证的同站 GET '/' 触发快照与本地默认模型重排
    //（'/api/mewclaw-desktop/*' 与 '/_dsh/*' 在快照前分流，'/auth/*' 依赖真实上游，都不能用）。
    // 页面可能仍在过渡，注入在轮询里幂等重放直到目录被拉取。
    const syncDeadline = Date.now() + 25000;
    let syncedText = '';
    while (Date.now() < syncDeadline) {
      const probe = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      syncedText = probe.result?.result?.value ?? '';
      if (mockCatalogHits > 0) break;
      await client.send('Runtime.evaluate', { expression: (liveLogin ? '' : "document.cookie='dsh_session=smoke-local;path=/';document.cookie='dsh_csrf=smoke-local;path=/';") + "fetch('/').then(r=>r.status).catch(()=>0)", awaitPromise: true });
      await delay(500);
    }
    if (mockCatalogHits === 0) throw new Error(`LOCAL_MODEL_CATALOG_NOT_FETCHED cookie=${syncedText.length}`);
    // 使用与 Web 相同的工作区选择器：添加工作区 -> 路径栏 -> 打开。
    await client.send('Runtime.evaluate', { expression: `(()=>{if(document.querySelector('[aria-label="打开本地目录"]'))throw Error('SEPARATE_LOCAL_BUTTON');const buttons=[...document.querySelectorAll('button')];const add=buttons.find(b=>/添加工作区|Add workspace/i.test(b.textContent+' '+b.getAttribute('aria-label')));if(add)add.click();else buttons.find(b=>/选择工作区|Select workspace|Choose workspace/i.test(b.textContent))?.click()})()` });
    await delay(500);
    await client.send('Runtime.evaluate', { expression: `([...document.querySelectorAll('[role="menuitem"],button')].find(b=>/添加工作区|Add workspace/i.test(b.textContent)))?.click()` });
    await delay(800);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('button[aria-label="编辑路径"],button[aria-label="Edit path"]')?.click()` });
    await delay(300);
    const pathInput = await client.send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector('input[aria-label="编辑路径"],input[aria-label="Edit path"]');if(!el)return false;el.focus();el.select();return true})()`, returnByValue: true });
    if (!pathInput.result?.result?.value) throw new Error('WORKSPACE_PATH_INPUT_MISSING');
    await client.send('Input.insertText', { text: folder + '/' });
    await delay(1000);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await delay(500);
    await client.send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[role="dialog"] button')].find(b=>/^(打开|Open)$/.test(b.textContent.trim()))?.click()` });
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
    if (process.argv.includes('--exercise-presets')) {
      for (const label of ['日常助手', '高效执行', 'Creator mode', 'Standard mode']) {
        await evaluate(`([...document.querySelectorAll('button')].find(b=>/^(日常助手|高效执行|Creator mode|Standard mode)$/.test(b.textContent.trim()))).click()`);
        await delay(300);
        await evaluate(`([...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)}))).click()`);
        const deadline = Date.now() + 15000;
        let selected = false;
        let stableChecks = 0;
        while (Date.now() < deadline) {
          selected = await evaluate(`!document.querySelector('[role="menu"]')&&[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)})&&!!document.querySelector('[contenteditable="true"]')`);
          stableChecks = selected ? stableChecks + 1 : 0;
          // 菜单会乐观更新；等待实际挂载完成，捕获随后回滚到旧模式的失败。
          if (stableChecks >= 4) break;
          await delay(500);
        }
        if (stableChecks < 4) throw new Error('PRESET_SWITCH_FAILED_' + label);
        console.log('PRESET_MOUNTED ' + label);
      }
      await screenshot('presets-exercised');
      console.log('ALL_VISIBLE_PRESETS_MOUNTED');
    }
    await screenshot('directory-selected');
    await evaluate(`document.querySelector('.mwseat-trigger').click()`);
    await delay(400);
    const slider = await evaluate(`(()=>{const el=document.querySelector('[role="slider"][aria-label="思考强度"]');el?.focus();return el?.getAttribute('aria-valuenow')})()`);
    if (slider === undefined) throw new Error('REASONING_SLIDER_MISSING');
    await screenshot('reasoning-high');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await delay(700);
    if (!await evaluate(`document.querySelector('.mwseat-trigger').textContent.includes('低')`)) throw new Error('REASONING_SLIDER_DID_NOT_CHANGE');
    await evaluate(`document.querySelector('.mwseat-trigger').click()`);
    await delay(300);
    await screenshot('reasoning-low');
    await evaluate(`document.querySelector('.mwseat-trigger').click()`);
    // 使用系统主题与减少动画偏好，验证同一组件的两个外观。
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await delay(500); await screenshot('local-dark');
    if (await evaluate(`getComputedStyle(document.querySelector('.mewclaw-location button')).transitionDuration`) !== '0s') throw new Error('REDUCED_MOTION_NOT_APPLIED');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await evaluate(`document.querySelector('button[aria-label="云端模式"]').focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    if (await evaluate(`document.activeElement.getAttribute('aria-label')`) !== '本地模式') throw new Error('LOCATION_KEYBOARD_FOCUS');
    await screenshot('location-keyboard');
    console.log('DIRECTORY_COMPOSER_EDITABLE');
  }
  await delay(3000);
  await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
  console.log(`RENDERER_ERRORS ${rendererErrors.length}`);
  if (rendererErrors.length) throw new Error('RENDERER_ERRORS_FOUND');
  if (process.argv.includes('--switch')) {
    await client.send('Runtime.evaluate', { expression: "(document.querySelector('button[title=\"云端模式\"],button[aria-label=\"云端模式\"]')||Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='云端'))?.click()" });
    await waitForLocation('cloud');
    console.log('LOCATION_SWITCH_OK local-to-cloud');
    if (liveLogin) await evaluate(`document.querySelector('button[aria-label="本地模式"]').click()`);
    else await client.send('Runtime.evaluate', { expression: "void fetch('/api/mewclaw-desktop/location',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({location:'local'})})" });
    await waitForLocation('local');
    console.log('LOCATION_SWITCH_OK cloud-to-local');
    if (liveLogin && !await evaluate(`document.body.innerText.includes('授权 中文工作区')`)) throw new Error('LOCAL_WORKSPACE_NOT_RESTORED');
  }
  if (rendererErrors.length) throw new Error('RENDERER_ERRORS_FOUND_AFTER_SWITCH');
  console.log(`LOCAL_UI_OK ${mode} ${dev ? 'development-runtime' : 'Release'} evidence=${home}`);
} catch (error) {
  if (client?.socket.readyState === WebSocket.OPEN) {
    const capture = await client.send('Page.captureScreenshot').catch(() => ({}));
    if (capture.result?.data) await writeFile(join(home, 'failure.png'), Buffer.from(capture.result.data, 'base64'));
    const body = await client.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }).catch(() => ({}));
    await writeFile(join(home, 'failure-body.txt'), body.result?.result?.value ?? '');
  }
  await writeFile(join(home, 'renderer-errors.json'), JSON.stringify(rendererErrors, null, 2));
  console.error(String(error));
  const sanitized = output.replace(/([?&]token=)[^\s"&]+/g, '$1[redacted]').replace(/dsh-auth-[^\s";]+/g, '[redacted]');
  await writeFile(join(home, 'startup.log'), sanitized);
  console.error(`LOCAL_UI_FAILED evidence=${home}`);
  process.exitCode = 1;
} finally {
  if (liveLogin && client?.socket.readyState === WebSocket.OPEN) await evaluate(`fetch('/auth/logout',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':decodeURIComponent((document.cookie.match(/(?:^|; )dsh_csrf=([^;]+)/)||[])[1]||'')},body:'{}'}).then(r=>r.status)`).catch(() => {});
  if (client) { await client.send('Browser.close').catch(() => {}); client.socket.close(); }
  if (child.exitCode === null) child.kill();
  mockServer?.close();
}
