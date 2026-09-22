/** 独立候选的 Windows 开发包；不继承社区根发行配置。 */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder 只加载 CommonJS 配置。 */
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { releaseDirectoryName } = require('./release-path.cjs');

const manifestPath = join(__dirname, 'package.json');
const fallbackManifestPath = join(__dirname, '..', '..', 'package.json');
const manifest = JSON.parse(readFileSync(existsSync(manifestPath) ? manifestPath : fallbackManifestPath, 'utf8'));

module.exports = {
  appId: 'ink.rwr.mewclaw.desktop',
  productName: 'MewClaw',
  electronVersion: '44.0.0',
  electronDist: 'node_modules/electron/dist',
  directories: { output: join('release', releaseDirectoryName(manifest.version)) },
  files: ['launcher.mjs', 'UPSTREAM.json', 'UPSTREAM-LICENSE', 'package.json',
    '!node_modules/@vscode/ripgrep-win32-x64/**/*'],
  // spawn 需要物理文件；保持原包字节不变，通过标准 Node 父目录解析查找。
  extraResources: [{ from: 'node_modules/@vscode/ripgrep-win32-x64',
    to: 'node_modules/@vscode/ripgrep-win32-x64' }],
  // 官方 FileSystem 使用 BigInt stat；Electron 的 ASAR 虚拟 stat 不满足该契约。
  asar: false,
  // 自定义 Electron distribution 自带示例归档；不把它放进正式应用的资源树。
  afterPack: context => rmSync(join(context.appOutDir, 'resources/default_app.asar'), { force: true }),
  npmRebuild: false,
  forceCodeSigning: false,
  electronFuses: {
    runAsNode: true,
    enableEmbeddedAsarIntegrityValidation: false,
    onlyLoadAppFromAsar: false,
  },
  win: {
    target: ['nsis', 'portable', 'zip'],
    icon: 'mewclaw-brand/build/app-icon.ico',
    signExecutable: false,
    artifactName: 'MewClaw-${version}-win-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'MewClaw',
    artifactName: 'MewClaw-${version}-win-${arch}-Setup.${ext}',
  },
  portable: { artifactName: 'MewClaw-${version}-win-${arch}-Portable.${ext}' },
};
