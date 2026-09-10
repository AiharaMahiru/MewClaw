/** MewClaw 商标几何常量，与 Web、认证页和管理台保持一致。 */
export const MEWCLAW_MARK_VIEWBOX = "0 0 512 512" as const;
export const MEWCLAW_MARK_WIDTH = 512 as const;
export const MEWCLAW_MARK_HEIGHT = 512 as const;

export type MewClawBrandMarkProps = {
  size: number;
  className?: string;
};

export type ReactApi = {
  createElement(
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
};

/** 按用户提供的原始 SVG 结构渲染 MewClaw 商标，颜色由宿主主题变量控制。 */
export function renderMewClawBrandMark(React: ReactApi, props: MewClawBrandMarkProps): unknown {
  const requestedSize = Number.isFinite(props.size) && props.size > 0 ? props.size : 24;
  const className = [props.className, "mewclaw-brand-mark"].filter(Boolean).join(" ");

  return React.createElement("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    width: requestedSize,
    height: requestedSize,
    className,
    viewBox: MEWCLAW_MARK_VIEWBOX,
    shapeRendering: "geometricPrecision",
    "aria-hidden": "true",
    focusable: "false",
  },
  React.createElement("circle", { className: "mewclaw-mark-bg", cx: "256", cy: "256", r: "256" }),
  React.createElement("path", {
    className: "mewclaw-mark-ink",
    d: "M256 132 C244 132 233 137 222 146 C208 136 196 120 184 96 C179 88 169 90 166 98 C154 130 142 172 134 200 C128 214 125 230 126 246 C123.8 281.9 38.5 324.3 51.2 351.5 A226 226 0 0 0 460.8 351.5 C473.5 324.3 388.2 281.9 386 246 C387 230 384 214 378 200 C358 130 370 172 346 98 C343 90 333 88 328 96 C316 120 304 136 290 146 C279 137 268 132 256 132 Z",
  }),
  React.createElement("path", { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "62", strokeLinecap: "round", d: "M116.9 410.6 A208 208 0 0 0 234.2 462.8" }),
  React.createElement("path", { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "34", strokeLinecap: "round", d: "M116.9 410.6 A208 208 0 0 0 234.2 462.8" }),
  React.createElement("path", { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "62", strokeLinecap: "round", d: "M366.2 432.4 A208 208 0 0 0 462.9 234.3" }),
  React.createElement("path", { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "34", strokeLinecap: "round", d: "M366.2 432.4 A208 208 0 0 0 462.9 234.3" }),
  React.createElement("g", { className: "mewclaw-mark-ink", fill: "none", strokeWidth: "10", strokeLinecap: "round" },
    React.createElement("path", { d: "M128 276 L44 252" }),
    React.createElement("path", { d: "M126 300 L50 296" }),
  ),
  React.createElement("g", { className: "mewclaw-mark-cutout", fill: "none", strokeWidth: "15", strokeLinecap: "round" },
    React.createElement("path", { d: "M174 266 Q204 300 234 266" }),
    React.createElement("path", { d: "M278 266 Q308 300 338 266" }),
  ),
  React.createElement("path", { className: "mewclaw-mark-cutout", d: "M247 312 L265 312 L256 325 Z", strokeWidth: "7", strokeLinejoin: "round" }));
}
