/** 社区 Consumer 适配 Web 当前官方契约；变换只写隔离候选。 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function prepareDesktopAlphaContract(destination) {
  const base = resolve(destination, 'dsh-plugin-desktop/src');
  const profilePath = resolve(base, 'profile.ts');
  let profile = await readFile(profilePath, 'utf8');
  if (!profile.includes('function requiredWebPatchReload()')) throw new Error('DESKTOP_PROFILE_ALPHA_CONTRACT_CHANGED');
  // alpha 统一 startup 生命周期，移除了旧的 patchReload 字段和第三个初始化参数。
  profile = profile.replace('  DEFAULT_PROFILE_PATCH_RELOAD,\n', '').replace('  type ProfileTemplate,\n', '')
    .replace(/\/\*\* User patch lifecycle inherited[\s\S]*?\n}\n/, '')
    .replace('initProfile(dir, REQUIRED_BUNDLES, requiredWebPatchReload())', 'initProfile(dir, REQUIRED_BUNDLES)')
    .replace('initProfile(profileDir, template.bundles, template.patchReload)', 'initProfile(profileDir, template.bundles)')
    .replace('  const patchReload = requiredWebPatchReload()\n', '')
    .replace(' || manifest.dsh?.profile?.patchReload !== patchReload', '')
    .replace(/  const rawPatchReload: unknown =[\s\S]*?\n  const selectedBundles =/, '  const selectedBundles =')
    .replace(/^\s+patchReload,\n/gm, '')
    .replace('export function healDesktopProfileModuleFallback(home: string, profile?: Profile): Promise<void>', 'export function healDesktopProfileModuleFallback(home: string, profile?: Profile)');
  await writeFile(profilePath, profile);
  const managerPath = resolve(base, 'profile-manager.ts');
  const manager = await readFile(managerPath, 'utf8');
  if (!manager.includes('initProfile(staging, template.bundles, template.patchReload)')) throw new Error('DESKTOP_PROFILE_MANAGER_CHANGED');
  await writeFile(managerPath, manager.replace('initProfile(staging, template.bundles, template.patchReload)', 'initProfile(staging, template.bundles)'));
  const pwshPath = resolve(base, 'windows-pwsh-sandbox.ts');
  const pwsh = await readFile(pwshPath, 'utf8');
  const old = '  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {\n    const adapted = this.adapt(spec, argv)\n    return super.runArgv(adapted.spec, adapted.argv)\n  }';
  if (!pwsh.includes(old)) throw new Error('DESKTOP_PWSH_ALPHA_CONTRACT_CHANGED');
  await writeFile(pwshPath, pwsh.replace(', ShellRunResult', '').replace(old, `  protected override runArgv(spec: ShellExecSpec, argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>)) {
    if (typeof argvOrPrepare !== 'function') {
      const adapted = this.adapt(spec, argvOrPrepare)
      return super.runArgv(adapted.spec, adapted.argv)
    }
    // 保留官方同一期限中的准备/执行流程，以及未发起 spawn 的返回语义。
    const adaptedSpec = { ...spec }
    return super.runArgv(adaptedSpec, async signal => {
      const adapted = this.adapt(spec, await argvOrPrepare(signal))
      adaptedSpec.env = adapted.spec.env
      return adapted.argv
    })
  }`));
}
