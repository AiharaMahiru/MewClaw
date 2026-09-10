/** 自有静态 SVG 壁纸：两种外观共享几何结构，无脚本或网络依赖。 */
export function wallpaper(dark: boolean): string {
  const colors = dark
    ? ["#18181e", "#30313e", "#3d3f50", "#4b465f", "#999ebc"]
    : ["#f3f3f7", "#d9ddec", "#e2e3ee", "#e6dff0", "#ffffff"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" fill="none">
<defs><linearGradient id="base" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient><linearGradient id="ribbon" x2="0.8" y2="1"><stop stop-color="${colors[2]}"/><stop offset="0.6" stop-color="${colors[3]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient><radialGradient id="light"><stop stop-color="${colors[4]}" stop-opacity=".32"/><stop offset="1" stop-color="${colors[4]}" stop-opacity="0"/></radialGradient></defs>
<path fill="url(#base)" d="M0 0h1600v1000H0z"/>
<path fill="url(#ribbon)" opacity=".7" d="M-120 720C210 270 180 90 720-100H-120zM890 1100c160-490 310-330 820-970v970z"/>
<path stroke="${colors[4]}" stroke-opacity=".18" stroke-width="2" d="M-80 700C180 340 280 70 720-100M930 1100c110-400 440-480 780-950"/>
<ellipse cx="720" cy="350" rx="800" ry="650" fill="url(#light)"/>
</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
