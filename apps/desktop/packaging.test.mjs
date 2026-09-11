import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const config = require('./electron-builder.cjs');

test('Windows 发行入口与生产文件白名单保留 MewClaw 组合', () => {
  assert.ok(config.files.includes('launcher.mjs'));
  assert.ok(config.files.includes('UPSTREAM-LICENSE'));
  assert.ok(!config.files.some(value => !value.startsWith('!') && value.includes('**')));
  assert.equal(config.extraResources[0].to, 'node_modules/@vscode/ripgrep-win32-x64');
  assert.ok(config.files.includes('!node_modules/@vscode/ripgrep-win32-x64/**/*'));
  assert.equal(config.productName, 'MewClaw');
  assert.deepEqual(config.win.target, ['nsis', 'portable', 'zip']);
});

test('安装范围为当前用户且开发包不要求签名', () => {
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
});
