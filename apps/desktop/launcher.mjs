/** MewClaw 发行入口：保留社区桌面完整 launcher，仅选择自有 Provider 与独立数据目录。 */
import { app } from 'electron';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const userData = join(app.getPath('appData'), 'MewClaw');
app.setPath('userData', userData);
process.env.DSH_HOME ??= join(userData, 'harness');
process.env.MEWCLAW_DESKTOP_CLOUD = '1';
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('dsh-plugin-desktop/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// 使用社区包声明的 Electron main 入口，不替换 Electron 或 DSH 的运行时对象。
await import(pathToFileURL(join(dirname(manifestPath), manifest.main)).href);
