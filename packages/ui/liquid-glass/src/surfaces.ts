/** 仅使用自有属性和 HTML/ARIA 语义，不依赖官方内部 class 或 DOM 层级。 */
import { wallpaper } from "./wallpaper.js";

const root = 'html[data-mew-glass="on"]';
const panels = ':is(dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],nav:not(header nav),aside)';
const controls = ':is(button,input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,select,[role="combobox"])';

/** 玻璃材质不改变尺寸、定位、命中区域、滚动或状态色；关闭后选择器不匹配。 */
export const SURFACE_STYLES = `
${root}{--mew-wallpaper:${wallpaper(false)};--mew-canvas:#edf1f7;--mew-glass-fill:rgb(248 250 255 / 58%);--mew-glass-edge:rgb(255 255 255 / 72%);--mew-glass-shadow:rgb(29 43 75 / 14%);--mew-glass-accent:#4b62b8}
${root}[data-mew-glass-scheme="dark"]{--mew-wallpaper:${wallpaper(true)};--mew-canvas:#171b27;--mew-glass-fill:rgb(26 31 46 / 62%);--mew-glass-edge:rgb(224 232 255 / 18%);--mew-glass-shadow:rgb(0 0 0 / 34%);--mew-glass-accent:#aab8ff}
${root} body{background-color:var(--mew-canvas);background-image:var(--mew-wallpaper);background-size:cover;background-position:center;background-attachment:fixed}
${root} body::before{position:fixed;inset:0;z-index:-1;content:"";pointer-events:none;background:linear-gradient(120deg,rgb(255 255 255 / 12%),transparent 42%,rgb(99 117 190 / 8%));}
${root} ${panels}{background-color:var(--mew-glass-fill);box-shadow:inset 0 1px 0 var(--mew-glass-edge),0 12px 36px var(--mew-glass-shadow);-webkit-backdrop-filter:blur(24px) saturate(135%);backdrop-filter:blur(24px) saturate(135%)}
${root} ${controls}{transition:background-color .18s ease, border-color .18s ease, box-shadow .18s ease}
${root} :is(dialog,[role="dialog"],[role="alertdialog"]){border-radius:24px}
${root} :is([role="menu"],[role="listbox"]){border-radius:18px;padding:8px;scroll-padding:8px}
${root} :is([role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]){border-radius:10px;box-shadow:none}
${root} :is([role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"])+:is([role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]){margin-top:4px}
${root} :is(header,[role="banner"],[role="toolbar"]){background:transparent;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
${root} header nav{background:transparent;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
${root} [role="tablist"]:not([aria-orientation="vertical"]){display:flex;flex:0 1 auto;align-self:flex-start;align-items:center;width:fit-content;max-width:100%;box-sizing:border-box;gap:8px;padding:0;border-radius:0;overflow-x:auto;scroll-padding:4px;background:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
${root} [role="tablist"]:not([aria-orientation="vertical"]) > [role="tab"]{flex:none;min-height:32px;padding:6px 14px;margin:0;border:0;border-bottom:2px solid transparent;border-radius:0;white-space:nowrap;line-height:20px;background:transparent;color:var(--dsw-alias-label-secondary);box-shadow:none}
${root} [role="tablist"]:not([aria-orientation="vertical"]) > [role="tab"][aria-selected="true"]{background:transparent;color:var(--dsw-alias-label-primary);border-bottom-color:currentColor;box-shadow:none}
${root} [role="tablist"]:not([aria-orientation="vertical"]) > [role="tab"]::after{background:transparent}
${root} [role="tablist"]:not([aria-orientation="vertical"]) > [role="tab"]:focus-visible{outline-offset:-2px}
${root} :is([role="dialog"],[role="menu"],[role="listbox"]) button{box-shadow:none}
${root} :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,select){border-radius:12px;background-color:rgb(255 255 255 / 34%);border-color:rgb(255 255 255 / 54%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 34%)}
${root}[data-mew-glass-scheme="dark"] :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,select){background-color:rgb(20 24 36 / 42%);border-color:rgb(220 230 255 / 18%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%)}
${root} ${controls}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:3px}
${root} :is(input,textarea,select)[aria-invalid="true"]{outline-color:var(--dsw-alias-state-error-primary,Mark)}
${root} .mew-glass-scene{background-image:var(--mew-wallpaper);background-size:cover;background-position:center}
@media(prefers-reduced-motion:reduce){${root} ${controls}{transition:none}}
@media(prefers-reduced-transparency:reduce),(forced-colors:active){${root} body{background-image:none}${root} ${panels}{background-color:var(--mew-canvas);backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none}${root} ${controls}{box-shadow:none}}
@media(forced-colors:active){${root}{--mew-canvas:Canvas}${root}[data-mew-glass-scheme="dark"]{--mew-canvas:Canvas}}
@supports not (backdrop-filter:blur(1px)){${root} body{background-image:none}${root} ${panels}{background-color:var(--mew-canvas);box-shadow:none}}
`;
