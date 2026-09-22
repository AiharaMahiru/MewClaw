/** 位置切换过渡面：把必需的整页重载包成连续品牌画面，窗口不露白、Electron 进程不重启。 */

/** 旧 renderer 预存切换意图的 sessionStorage 键；位置客户端写入，本文件运行时读取后清除。 */
export const SWITCH_FLAG_KEY = 'mewclaw.location-switch';

/**
 * 注入 BootGraph 前置脚本、在文档解析期运行的自包含运行时。
 * 通过 toString 序列化进 HTML，只能引用参数与浏览器全局；常量一律在函数体内声明。
 */
function switchSplashRuntime(flagKey: string): void {
  try {
    const raw = sessionStorage.getItem(flagKey);
    if (!raw) return;
    sessionStorage.removeItem(flagKey);
    // 只放行可解析纯色，防止意图字段把任意 CSS 注进过渡面。
    const colorPattern = /^(#[0-9a-f]{3,8}|rgba?\([^)]{1,48}\))$/i;
    // 透明/半透明底色会让官方启动屏透上来与过渡文案叠影——alpha<1 一律回退默认色。
    const opaque = (value: unknown, fallback: string): string => {
      if (typeof value !== 'string' || !colorPattern.test(value)) return fallback;
      const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(value);
      if (rgba && Number.parseFloat(rgba[1] ?? '0') < 1) return fallback;
      const hexAlpha = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(value)
        ? (value.length === 5 ? value.charAt(4) : value.slice(7)) : '';
      if (hexAlpha !== '' && hexAlpha.toLowerCase() !== 'f' && hexAlpha.toLowerCase() !== 'ff') return fallback;
      return value;
    };
    let target = 'cloud';
    let surface = '#17181c';
    let ink = '#e8eaef';
    try {
      const flag = JSON.parse(raw) as { to?: unknown; bg?: unknown; ink?: unknown };
      if (flag.to === 'local' || flag.to === 'cloud') target = flag.to;
      surface = opaque(flag.bg, surface);
      ink = opaque(flag.ink, ink);
    } catch { /* 意图损坏时按默认色继续，不阻断启动 */ }
    const doc = document;
    // 先铺满背景色，挡住 body 尚未建立时的首帧白闪。
    doc.documentElement.style.background = surface;
    const reduced = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const MIN_VISIBLE_MS = 0;
    const FADE_MS = reduced ? 0 : 180;
    const CAP_MS = 20000;
    let splash: HTMLElement | undefined;
    let finishing = false;
    let shownAt = 0;
    const remove = (): void => {
      const el = splash;
      splash = undefined;
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), FADE_MS + 40);
    };
    const ready = (): boolean => {
      const root = doc.getElementById('root');
      return !!root && root.childElementCount > 0;
    };
    const finish = (): void => {
      if (finishing) return;
      finishing = true;
      observer.disconnect();
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
      setTimeout(() => {
        const raf = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView)
          ?? ((callback: () => void) => { setTimeout(callback, 16); });
        raf(() => raf(remove));
      }, wait);
    };
    const mount = (): void => {
      if (splash || !doc.body) return;
      shownAt = Date.now();
      splash = doc.createElement('div');
      splash.id = 'mewclaw-location-splash';
      splash.setAttribute('role', 'status');
      splash.setAttribute('style',
        'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;'
        + `align-items:center;justify-content:center;gap:12px;background:${surface};color:${ink};`
        + `font:13px/1.6 system-ui,"Segoe UI",sans-serif;transition:opacity ${FADE_MS}ms ease;`);
      const spinner = doc.createElement('div');
      spinner.setAttribute('style', 'width:20px;height:20px;border-radius:50%;'
        + 'border:2px solid currentColor;border-top-color:transparent;opacity:.75;');
      const animate = (spinner as HTMLElement & {
        animate?: (frames: unknown, timing: unknown) => void;
      }).animate;
      if (!reduced) animate?.call(spinner,
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 900, iterations: Infinity });
      const label = doc.createElement('div');
      label.textContent = target === 'local' ? '正在切换到本地工作区' : '正在切换到云端工作区';
      splash.append(spinner, label);
      doc.body.prepend(splash);
      if (ready()) finish();
    };
    const observer = new MutationObserver(() => {
      if (!splash) mount();
      if (splash && ready()) finish();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    mount();
    if (ready()) finish();
    setTimeout(() => { observer.disconnect(); remove(); }, CAP_MS);
  } catch { /* 过渡面是增强行为，失败不得影响 BootGraph */ }
}

/** 序列化结果要求函数体自包含；修改后同步核对 location-client 的即时覆盖层。 */
export const SWITCH_SPLASH_SOURCE = `;(${switchSplashRuntime.toString()})(${JSON.stringify(SWITCH_FLAG_KEY)});`;
