/** MewClaw 商标几何常量，与 Web、认证页和管理台保持一致。 */
export const MEWCLAW_MARK_VIEWBOX = "0 0 240 240" as const;
export const MEWCLAW_MARK_WIDTH = 240 as const;
export const MEWCLAW_MARK_HEIGHT = 240 as const;
export const MEWCLAW_MARK_MASK_ID = "mewclaw-v-under" as const;

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

/** 按用户提供的原始 SVG 结构渲染 MewClaw 商标。 */
export function renderMewClawBrandMark(React: ReactApi, props: MewClawBrandMarkProps): unknown {
  const requestedSize = Number.isFinite(props.size) && props.size > 0 ? props.size : 24;
  const mask = React.createElement("mask", { id: MEWCLAW_MARK_MASK_ID },
    React.createElement("rect", { width: "240", height: "240", fill: "#fff" }),
    React.createElement("path", { d: "M76 90h28", stroke: "#000", strokeWidth: "18" }),
    React.createElement("path", { d: "M136 150h28", stroke: "#000", strokeWidth: "18" }),
  );
  const body = React.createElement("g", {
    transform: "rotate(45 120 120)",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "16",
  },
  React.createElement("rect", { x: "35", y: "90", width: "170", height: "60", rx: "30" }),
  React.createElement("rect", {
    x: "90",
    y: "35",
    width: "60",
    height: "170",
    rx: "30",
    mask: `url(#${MEWCLAW_MARK_MASK_ID})`,
  }));

  return React.createElement("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    width: requestedSize,
    height: requestedSize,
    className: props.className,
    viewBox: MEWCLAW_MARK_VIEWBOX,
    fill: "none",
    "aria-hidden": "true",
    focusable: "false",
  }, React.createElement("defs", null, mask), body);
}
