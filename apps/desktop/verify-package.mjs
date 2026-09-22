/** 用真实打包 Electron 验证 MewClaw 发行依赖，不访问生产或用户配置。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { Script } from 'node:vm';

const { releaseDirectoryName } = createRequire(import.meta.url)('./release-path.cjs');

const candidate = process.argv[2];
assert.ok(candidate && isAbsolute(candidate), '需要候选绝对路径');
const root = resolve(candidate);
const require = createRequire(join(root, 'package.json'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const release = resolve(root, process.argv.find(value => value.startsWith('--release-dir='))?.slice('--release-dir='.length)
  ?? join('release', releaseDirectoryName(version)));
const output = join(release, 'win-unpacked');
const appRoot = join(output, 'resources', 'app');
const executable = join(output, 'MewClaw.exe');
const staticOnly = process.argv.includes('--static-only');
const runtimeOnly = process.argv.includes('--runtime-only');
const keepSmokeHome = process.argv.includes('--keep-smoke-home');
assert.ok(!(staticOnly && runtimeOnly), '静态与运行时选项不能同时指定');
const appFile = path => readFileSync(join(appRoot, path.split('/').join(sep)));

function listAppFiles(rootDirectory = appRoot) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files.push(`${prefix}${name}`);
    }
  };
  walk(rootDirectory, '');
  return files;
}

function verifyLayout() {
  const files = listAppFiles();
  for (const path of ['launcher.mjs', 'UPSTREAM-LICENSE',
    'node_modules/dsh-plugin-desktop/lib/main.js',
    'node_modules/dsh-lark-mewclaw-brand-desktop/client.js',
    'node_modules/dsh-lark-desktop-cloud/lib/index.js',
    'node_modules/dsh-lark-model-seat/client.js',
    'node_modules/dsh-lark-desktop-cloud/web-auth-client.js',
    'node_modules/dsh-lark-desktop-cloud/web.patch.yml']) {
    assert.ok(files.includes(path), `缺少发行入口：${path}`);
  }
  assert.ok(!files.some(value => /(?:^|\/)(?:\.env|\.git)(?:\/|$)/u.test(value)), '包含本地秘密或 Git 数据');
  const manifest = JSON.parse(appFile('package.json').toString());
  assert.equal(manifest.main, 'launcher.mjs');
  const launcher = appFile('launcher.mjs').toString();
  assert.match(launcher, /MEWCLAW_DESKTOP_CLOUD/u);
  for (const name of ['index.js', 'workspace-controller.js', 'workspace-client.js', 'location-client.js', 'location.js', 'location-route.js', 'local-workspaces.js', 'local-brand.js', 'local-account.js', 'graph-events.js', 'presets.js', 'standard-preset.js', 'cloud-model.js', 'session-boot.js', 'session-ui-state.js']) {
    const entry = 'node_modules/dsh-lark-desktop-cloud/lib/' + name;
    const packed = appFile(entry);
    assert.ok(packed.equals(readFileSync(join(root, 'mewclaw-cloud/lib', name))), '桌面工作区构建不一致：' + name);
    if (name === 'workspace-client.js' || name === 'location-client.js') new Script(packed.toString().replace('\nexport {};', ''));
  }
  for (const wrapper of ['agent-presets/lark-standard', 'agent-presets-lightweight/lark-lightweight']) {
    const path = wrapper + '/agent.cordis.yml';
    assert.ok(appFile('node_modules/dsh-lark-desktop-cloud/' + path).equals(readFileSync(join(root, 'mewclaw-cloud', path))), '模式配置与候选不一致');
  }
  console.log('APP_ENTRYPOINTS_OK');
}

function verifyOfficialFiles() {
  const marker = 'node_modules/@deepseek-ai/';
  const scripts = listAppFiles().filter(value => value.slice(value.lastIndexOf('node_modules/') + 'node_modules/'.length).startsWith('@deepseek-ai/') && /\.[cm]?js$/u.test(value));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const sources = new Map();
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path.includes(marker)) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const key = `${name}@${item.version}`;
    const rows = sources.get(key) ?? [];
    if (existsSync(join(root, path))) rows.push(join(root, path));
    sources.set(key, rows);
  }
  const versions = new Map();
  assert.ok(scripts.length > 100, '官方运行时文件未完整收集');
  for (const entry of scripts) {
    const start = entry.lastIndexOf(marker);
    const suffix = entry.slice(start + marker.length);
    const slash = suffix.indexOf('/');
    const packageRoot = entry.slice(0, start + marker.length + slash);
    if (!versions.has(packageRoot)) versions.set(packageRoot, JSON.parse(appFile(`${packageRoot}/package.json`)).version);
    const key = `@deepseek-ai/${suffix.slice(0, slash)}@${versions.get(packageRoot)}`;
    const file = suffix.slice(slash + 1);
    const packed = appFile(entry);
    // electron-builder 会提升 npm 嵌套依赖；按包名/锁定版本定位原始文件。
    assert.ok((sources.get(key) ?? []).some(directory => existsSync(join(directory, file)) && packed.equals(readFileSync(join(directory, file)))),
      `官方运行时在打包时发生变化：${entry}`);
  }
  console.log(`OFFICIAL_RUNTIME_UNCHANGED ${scripts.length}`);
}

function verifyNativeSpawn(home) {
  const expectedElectron = require('electron/package.json').version;
  const code = `
    if (process.versions.electron !== ${JSON.stringify(expectedElectron)}) throw new Error('Electron 运行时与锁定版本不符');
    const { createRequire } = require('node:module');
    const { spawnSync } = require('node:child_process');
    const r = createRequire(process.argv[1] + '/package.json');
    const binary = r.resolve('@vscode/ripgrep-win32-x64/bin/rg.exe');
    if (binary.includes('app.asar') || !require('node:fs').existsSync(binary)) {
      throw new Error('ripgrep 必须为物理资源：' + binary);
    }
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0 || !result.stdout.startsWith('ripgrep ')) {
      throw result.error ?? new Error('ripgrep spawn 失败');
    }
    console.log('NATIVE_SPAWN_OK');
    import(require('node:url').pathToFileURL(r.resolve('dsh-lark-desktop-cloud')).href)
      .then(() => console.log('CLOUD_PROVIDER_IMPORT_OK'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = execFileSync(executable, ['-e', code, appRoot], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.match(result, /NATIVE_SPAWN_OK/u);
  assert.match(result, /CLOUD_PROVIDER_IMPORT_OK/u);
  console.log('NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK');
}

function runSmoke(home, entry, args, marker) {
  const result = execFileSync(executable, ['--expose-internals', join(appRoot, entry), ...args], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(result, marker, `运行时烟雾未返回预期标记：${entry}`);
  console.log(`RUNTIME_OK ${entry}`);
}

function verifyRuntime() {
  const home = mkdtempSync(join(tmpdir(), 'mewclaw-package-smoke-'));
  try {
    verifyNativeSpawn(home);
    runSmoke(home, 'node_modules/@deepseek-ai/dsh/lib/bin.js', ['--version'], /0\.1\.6-alpha\.2/u);
    runSmoke(home, 'node_modules/pnpm/bin/pnpm.mjs', ['--version'], /11\.8\.0/u);
    runSmoke(home, 'node_modules/dsh-plugin-desktop/lib/packaged-runtime-smoke.js', [], /DSH_PACKAGED_RUNTIME_OK/u);
    runSmoke(home, 'node_modules/dsh-plugin-desktop/lib/desktop-cli.js',
      ['--profile', 'headless', '--help'], /dsh --profile headless/u);
  } finally {
    // 只删除本次 mkdtemp 创建的烟雾目录。
    // Wine 的 junction 清理会跟随目标；兼容层验收保留临时目录，不能误删发行依赖。
    if (keepSmokeHome) console.log(`SMOKE_HOME_RETAINED ${home}`);
    else rmSync(home, { recursive: true, force: true });
  }
}

function verifyArtifacts() {
  const artifacts = readdirSync(release).filter(name => name.startsWith('MewClaw-' + version + '-win-') && /\.(?:exe|zip)$/u.test(name));
  assert.equal(artifacts.length, 3, '需要安装程序、便携 EXE 与 ZIP');
  for (const name of artifacts) {
    const data = readFileSync(join(release, name));
    assert.ok(data.length > 1024 * 1024, `产物过小：${name}`);
    assert.equal(data.subarray(0, 2).toString(), name.endsWith('.exe') ? 'MZ' : 'PK');
    console.log(JSON.stringify({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(join(release, artifacts.find(name => name.endsWith('.zip'))));
  assert.equal(zip.getEntry('resources/default_app.asar'), null, '不得携带 Electron 示例归档');
  const payloadFiles = listAppFiles(output);
  assert.equal(zip.getEntries().filter(entry => !entry.isDirectory).length, payloadFiles.length, 'ZIP 文件清单与发行目录不一致');
  for (const entry of payloadFiles) {
    const data = zip.readFile(entry);
    assert.ok(data && data.equals(readFileSync(join(output, entry))), `ZIP 与已验证应用不一致：${entry}`);
  }
  console.log(`ZIP_PAYLOAD_MATCHES_VERIFIED_APP ${payloadFiles.length}`);
}

assert.ok(existsSync(executable), '缺少打包 EXE');
assert.ok(statSync(appRoot).isDirectory(), '应用根必须为物理目录，满足官方 BigInt stat 契约');
assert.ok(!existsSync(join(output, 'resources/default_app.asar')), '不得携带 Electron 示例归档');
verifyLayout();
verifyOfficialFiles();
if (!staticOnly) {
  assert.equal(process.platform, 'win32', '完整运行时门禁需要 Windows；静态核验可显式使用 --static-only');
  verifyRuntime();
  verifyOfficialFiles();
}
if (!runtimeOnly) verifyArtifacts();
console.log(staticOnly ? 'MEWCLAW_PACKAGE_STATIC_OK (Windows runtime not executed)'
  : runtimeOnly ? 'MEWCLAW_PACKAGE_RUNTIME_OK (archive validation separate)' : 'MEWCLAW_PACKAGE_OK');
