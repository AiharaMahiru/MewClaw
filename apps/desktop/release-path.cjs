const RELEASE_ARCH = 'x64';

function releaseDirectoryName(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`无效桌面发行版本：${String(version)}`);
  }
  return `MewClaw-${version}-win-${RELEASE_ARCH}`;
}

module.exports = { RELEASE_ARCH, releaseDirectoryName };
