/** 用户点击位置切换即请求重启；通过 Electron 公开生命周期交给官方 shutdown。 */
export async function prepareLocationRestart(): Promise<() => void> {
  const { app } = await import('electron');
  if (!app.isReady()) throw new Error('DESKTOP_STARTING');
  const args = process.argv.slice(1).filter(argument =>
    argument !== '--dsh-desktop-recovery' && argument !== '--dsh-desktop-safe-mode');
  return () => {
    app.relaunch({ args });
    app.quit();
  };
}
