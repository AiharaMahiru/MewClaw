/** 在独立候选内构建并验证桌面/云端桥接，不访问生产服务。 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidate = process.argv[2];
assert.ok(candidate && isAbsolute(candidate), '需要独立候选绝对路径');
const root = resolve(candidate);
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name, 'mewclaw-desktop-candidate');
const desktop = dirname(fileURLToPath(import.meta.url));
cpSync(join(desktop, 'plugins/cloud'), join(root, 'mewclaw-cloud'), { recursive: true });
cpSync(join(desktop, 'plugins/workspace'), join(root, 'mewclaw-workspace'), { recursive: true });
mkdirSync(join(root, 'edge-workspace-src'), { recursive: true });
cpSync(resolve(desktop, '../../packages/auth/edge/src/desktop-workspace.ts'), join(root, 'edge-workspace-src/desktop-workspace.ts'));
cpSync(join(desktop, 'workspace-integration.test.mjs'), join(root, 'workspace-integration.test.mjs'));
const run = (script, args) => execFileSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 60000 });
for (const project of ['mewclaw-cloud', 'mewclaw-workspace']) run('node_modules/typescript/bin/tsc', ['-p', project + '/tsconfig.json']);
run('node_modules/typescript/bin/tsc', ['edge-workspace-src/desktop-workspace.ts', '--module', 'nodenext', '--target', 'es2023', '--strict', '--skipLibCheck', '--types', 'node', '--outDir', 'edge-workspace']);
run('node_modules/vitest/vitest.mjs', ['run', '--config', 'mewclaw-cloud/vitest.config.mjs']);
console.log('WORKSPACE_OFFLINE_VERIFIED');
