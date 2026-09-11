/** 用真实打包 Electron 验证 MewClaw 发行依赖，不访问生产或用户配置。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Script } from 'node:vm';

const candidate = process.argv[2];
assert.ok(candidate && isAbsolute(candidate), '需要候选绝对路径');
const root = resolve(candidate);
const require = createRequire(join(root, 'package.json'));
const asar = require('@electron/asar');
const output = join(root, 'release', 'win-unpacked');
const archive = join(output, 'resources', 'app.asar');
const executable = join(output, 'MewClaw.exe');

function verifyArchive() {
  const files = asar.listPackage(archive).map(value => value.replaceAll('\\', '/'));
  for (const path of ['launcher.mjs', 'UPSTREAM-LICENSE',
    'node_modules/dsh-plugin-desktop/lib/main.js',
    'node_modules/dsh-lark-desktop-cloud/lib/index.js']) {
    assert.ok(files.includes(`/${path}`), `缺少发行入口：${path}`);
  }
  assert.ok(!files.some(value => /\/(?:\.env|\.git)(?:\/|$)/u.test(value)), '包含本地秘密或 Git 数据');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(manifest.main, 'launcher.mjs');
  const launcher = asar.extractFile(archive, 'launcher.mjs').toString();
  assert.match(launcher, /MEWCLAW_DESKTOP_CLOUD/u);
  for (const name of ['index.js', 'workspace-controller.js', 'workspace-client.js']) {
    const entry = 'node_modules/dsh-lark-desktop-cloud/lib/' + name;
    const packed = asar.extractFile(archive, join(...entry.split('/')));
    assert.ok(packed.equals(readFileSync(join(root, 'mewclaw-cloud/lib', name))), '桌面工作区构建不一致：' + name);
    if (name === 'workspace-client.js') new Script(packed.toString().replace('\nexport {};', ''));
  }
  console.log('ASAR_ENTRYPOINTS_OK');
}

function verifyOfficialFiles() {
  const entries = asar.listPackage(archive).map(value => value.replaceAll('\\', '/').slice(1));
  const scripts = entries.filter(value => value.startsWith('node_modules/@deepseek-ai/')
    && !value.slice('node_modules/'.length).includes('/node_modules/') && /\.[cm]?js$/u.test(value));
  assert.ok(scripts.length > 100, '官方运行时文件未完整收集');
  for (const entry of scripts) {
    assert.ok(asar.extractFile(archive, join(...entry.split('/'))).equals(readFileSync(join(root, entry))),
      `官方运行时在打包时发生变化：${entry}`);
  }
  console.log(`OFFICIAL_RUNTIME_UNCHANGED ${scripts.length}`);
}

function verifyNativeSpawn(home) {
  const code = `
    const { createRequire } = require('node:module');
    const { spawnSync } = require('node:child_process');
    const r = createRequire(process.argv[1] + '/package.json');
    const binary = r.resolve('@vscode/ripgrep-win32-x64/bin/rg.exe');
    if (binary.includes('app.asar')) throw new Error('ripgrep 必须为物理资源');
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0 || !result.stdout.startsWith('ripgrep ')) {
      throw result.error ?? new Error('ripgrep spawn 失败');
    }
    console.log('NATIVE_SPAWN_OK');
    import(require('node:url').pathToFileURL(r.resolve('dsh-lark-desktop-cloud')).href)
      .then(() => console.log('CLOUD_PROVIDER_IMPORT_OK'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = execFileSync(executable, ['-e', code, archive], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.match(result, /NATIVE_SPAWN_OK/u);
  assert.match(result, /CLOUD_PROVIDER_IMPORT_OK/u);
  console.log('NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK');
}

function runSmoke(home, entry, args, marker) {
  const result = execFileSync(executable, ['--expose-internals', join(archive, entry), ...args], {
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
    runSmoke(home, 'node_modules/@deepseek-ai/dsh/lib/bin.js', ['--version'], /0\.1\.2-rc\.1/u);
    runSmoke(home, 'node_modules/pnpm/bin/pnpm.mjs', ['--version'], /11\.8\.0/u);
    runSmoke(home, 'node_modules/dsh-plugin-desktop/lib/packaged-runtime-smoke.js', [], /DSH_PACKAGED_RUNTIME_OK/u);
    runSmoke(home, 'node_modules/dsh-plugin-desktop/lib/desktop-cli.js',
      ['--profile', 'headless', '--help'], /dsh --profile headless/u);
  } finally {
    // 只删除本次 mkdtemp 创建的烟雾目录。
    rmSync(home, { recursive: true, force: true });
  }
}

function verifyArtifacts() {
  const release = join(root, 'release');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
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
  for (const entry of ['MewClaw.exe', 'resources/app.asar',
    'resources/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe']) {
    const data = zip.readFile(entry);
    assert.ok(data && data.equals(readFileSync(join(output, entry))), `ZIP 与已验证应用不一致：${entry}`);
  }
  console.log('ZIP_PAYLOAD_MATCHES_VERIFIED_APP');
}

assert.ok(existsSync(executable), '缺少打包 EXE');
verifyArchive();
verifyOfficialFiles();
verifyRuntime();
if (process.argv[3] !== '--runtime-only') verifyArtifacts();
console.log(process.argv[3] === '--runtime-only' ? 'MEWCLAW_RUNTIME_OK' : 'MEWCLAW_PACKAGE_OK');
