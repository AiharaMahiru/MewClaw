/** npm 候选复用 Web 已评审的社区兼容补丁；官方包不允许进入本清单。 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const patches = JSON.parse(readFileSync(resolve(root, 'web-patches.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/')) continue;
  const name = path.split('node_modules/').at(-1);
  const patch = patches[`${name}@${item.version}`];
  if (!patch) continue;
  if (name.startsWith('@deepseek-ai/')) throw new Error('OFFICIAL_PATCH_FORBIDDEN');
  const directory = resolve(root, path);
  if (!existsSync(directory)) continue;
  const run = args => spawnSync('git', ['apply', ...args, resolve(root, patch)], { cwd: directory, encoding: 'utf8' });
  if (run(['--reverse', '--check']).status === 0) continue;
  const check = run(['--check']);
  if (check.status !== 0) throw new Error(`WEB_PATCH_CHECK_FAILED ${name}: ${check.stderr}`);
  const result = run([]);
  if (result.status !== 0) throw new Error(`WEB_PATCH_FAILED ${name}: ${result.stderr}`);
  console.log(`WEB_PATCH_APPLIED ${name}@${item.version}`);
}
