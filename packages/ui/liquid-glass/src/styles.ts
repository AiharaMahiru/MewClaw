/** 只选择本插件拥有的 class；不覆盖官方布局、全局按钮或消息节点。 */
export const GLASS_STYLES = `
.mew-glass-page{--mew-ink:#202027;--mew-muted:#61616e;--mew-panel:#f2f2f6;--mew-line:#c8c8d2;color:var(--mew-ink);max-width:760px;margin:auto;padding:8px 0 24px;font-family:inherit}
.mew-glass-page[data-scheme="dark"]{--mew-ink:#f5f5f8;--mew-muted:#c6c6d0;--mew-panel:#292930;--mew-line:#52525e}
.mew-glass-kicker{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mew-muted);margin:0 0 12px}
.mew-glass-title{font-size:clamp(24px,4vw,34px);font-weight:600;letter-spacing:-.04em;line-height:1.2;margin:0 0 12px}
.mew-glass-description{font-size:14px;line-height:1.7;color:var(--mew-muted);margin:0 0 24px;max-width:48ch}
.mew-glass-scene{position:relative;isolation:isolate;overflow:hidden;border-radius:24px;min-height:250px;display:grid;place-items:center;padding:32px 12px;background:radial-gradient(ellipse at 18% 18%,#e8e8f3 0,transparent 55%),radial-gradient(ellipse at 85% 80%,#a8acc4 0,transparent 60%),#d4d6e4;border:1px solid var(--mew-line)}
.mew-glass-page[data-scheme="dark"] .mew-glass-scene{background:radial-gradient(ellipse at 18% 18%,#454859 0,transparent 55%),radial-gradient(ellipse at 85% 80%,#20212e 0,transparent 60%),#303343}
.mew-glass-surface{max-width:100%;width:270px;position:relative}
.mew-glass-optics{position:relative;width:270px;max-width:100%;height:240px}
/* 上游组件附带的 Tailwind 工具类仅在自有容器内补齐，不引入全局 reset。 */
.mew-glass-optics .pointer-events-none{pointer-events:none}.mew-glass-optics .bg-black{background:#000}.mew-glass-optics .opacity-0{opacity:0}.mew-glass-optics .opacity-20{opacity:.2}.mew-glass-optics .opacity-100{opacity:1}.mew-glass-optics .mix-blend-overlay{mix-blend-mode:overlay}
.mew-glass-card{color:var(--mew-ink);box-sizing:border-box;max-width:100%;padding:22px;border-radius:22px;background:rgb(255 255 255 / 34%);box-shadow:inset 0 1px 0 #fff,0 18px 48px rgb(20 20 32 / 12%);border:1px solid rgb(255 255 255 / 60%)}
.mew-glass-page[data-scheme="dark"] .mew-glass-card{background:rgb(30 30 38 / 44%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 16%),0 18px 48px rgb(0 0 0 / 20%);border-color:rgb(235 235 255 / 22%)}
.mew-glass-card strong{display:block;font-size:23px;line-height:1.3;letter-spacing:-.03em;margin-bottom:8px}
.mew-glass-card p{font-size:13px;line-height:1.6;margin:0 0 18px}
.mew-glass-button{font:inherit;font-size:13px;min-height:40px;cursor:pointer;border:1px solid var(--mew-line);border-radius:12px;padding:8px 14px;background:var(--mew-panel);color:var(--mew-ink)}
.mew-glass-button:focus-visible{outline:3px solid #687de0;outline-offset:4px}
.mew-glass-control{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-block:1px solid var(--mew-line)}
.mew-glass-control .mew-glass-note{margin:4px 0 0}.mew-glass-control+ .mew-glass-note{margin-bottom:20px}
.mew-glass-switch{flex:none;display:flex;align-items:center;width:64px;height:44px;padding:6px;border:1px solid var(--mew-line);border-radius:999px;corner-shape:round;background:var(--mew-line);cursor:pointer}
.mew-glass-switch[aria-checked="true"]{background:#5c70c9;border-color:#5c70c9;justify-content:flex-end}
.mew-glass-switch-thumb{display:block;width:30px;height:30px;border-radius:50%;corner-shape:round;background:#fff;box-shadow:0 1px 3px rgb(0 0 0 / 20%)}
.mew-glass-switch:focus-visible{outline:3px solid #687de0;outline-offset:4px}.mew-glass-switch:disabled{cursor:wait;opacity:.55}
.mew-glass-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:20px}
.mew-glass-note{color:var(--mew-muted);font-size:12px;line-height:1.7;margin:14px 0 0}
@supports (backdrop-filter:blur(12px)){.mew-glass-card{backdrop-filter:blur(12px)}}
@media(prefers-reduced-transparency:reduce),(forced-colors:active){.mew-glass-page .mew-glass-card,.mew-glass-page[data-scheme="dark"] .mew-glass-card{background:var(--mew-panel);backdrop-filter:none;box-shadow:none}.mew-glass-page .mew-glass-scene{background:var(--mew-panel)}}
@media(forced-colors:active){.mew-glass-page{--mew-ink:CanvasText;--mew-muted:CanvasText;--mew-panel:Canvas;--mew-line:ButtonBorder}.mew-glass-page[data-scheme="dark"]{--mew-ink:CanvasText;--mew-muted:CanvasText;--mew-panel:Canvas;--mew-line:ButtonBorder}.mew-glass-button:focus-visible{outline-color:Highlight}}
@media(forced-colors:active){.mew-glass-switch{background:Canvas;border-color:ButtonText}.mew-glass-switch[aria-checked="true"]{background:Highlight;border-color:Highlight}.mew-glass-switch-thumb{background:ButtonText}.mew-glass-switch:focus-visible{outline-color:Highlight}}
`;
