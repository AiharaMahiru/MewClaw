import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-left"
  | "arrow-right"
  | "billing"
  | "check"
  | "chevron-down"
  | "close"
  | "dashboard"
  | "edit"
  | "folder"
  | "knowledge"
  | "logout"
  | "menu"
  | "more"
  | "moon"
  | "plus"
  | "pulse"
  | "refresh"
  | "search"
  | "sessions"
  | "shield"
  | "settings"
  | "sliders"
  | "spark"
  | "square-arrow"
  | "sun"
  | "users"
  | "workspace";

const PATHS: Record<IconName, string> = {
  activity: "M2 12.5 5.1 9.4l2.3 2.3L13.9 5.2M10.8 5.2h3.1v3.1",
  "arrow-left": "M14 8H2m0 0 5-5M2 8l5 5",
  "arrow-right": "M2 8h12m0 0-5-5m5 5-5 5",
  billing: "M3 3h10v10H3zM6 6h4M6 8h4M6 10h2",
  check: "m3.2 8.1 3.1 3.1 6.5-6.5",
  "chevron-down": "m4 6 4 4 4-4",
  close: "m4 4 8 8M12 4l-8 8",
  dashboard: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z",
  edit: "m3 11.8-.6 2.3 2.3-.6L12.8 5.4a1.7 1.7 0 0 0-2.4-2.4zM9.5 4.5l2 2",
  folder: "M2.5 4.3a1.3 1.3 0 0 1 1.3-1.3h2.1l1.2 1.5h5.1a1.3 1.3 0 0 1 1.3 1.3v5.2a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z",
  knowledge: "M3 2.8c1.8 0 3.5.1 5 1.5 1.5-1.4 3.2-1.5 5-1.5v10.4c-1.8 0-3.5.1-5 1.3-1.5-1.2-3.2-1.3-5-1.3zM8 4.3v10.2",
  logout: "M7 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H7M10 5l3 3-3 3M13 8H6",
  menu: "M2.5 3.5h11v9h-11zM5.4 3.5v9",
  more: "M3.3 8h.1M7.95 8h.1M12.6 8h.1",
  moon: "M13.2 9.8A5.4 5.4 0 0 1 6.2 2.8a5.4 5.4 0 1 0 7 7z",
  plus: "M8 2v12M2 8h12",
  pulse: "M2 8h2l1.3-3.2L8 11l1.8-4.5L11 8h3",
  refresh: "M13.4 5.6A5.5 5.5 0 1 0 14 9M13.4 2.8v2.8h-2.8",
  search: "m13.5 13.5-3-3M11.4 6.8a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0z",
  sessions: "M8 3v5l3 1.8M13.5 8a5.5 5.5 0 1 1-1.6-3.9",
  shield: "M8 2.3 13 4v3.7c0 3.1-2 5.3-5 6-3-.7-5-2.9-5-6V4zM5.7 8.1 7.3 9.7l3-3",
  settings: "M6.2 2.4h3.6l.5 1.7 1.4.8 1.7-.4 1.8 3.1-1.2 1.3v1.6l1.2 1.3-1.8 3.1-1.7-.4-1.4.8-.5 1.7H6.2l-.5-1.7-1.4-.8-1.7.4-1.8-3.1L2 10.5V8.9L.8 7.6l1.8-3.1 1.7.4 1.4-.8zM8 10.7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  sliders: "M2 4h12M2 8h12M2 12h12M5 2.5v3M10 6.5v3M6 10.5v3",
  spark: "m8 2 .8 3.2L12 6l-3.2.8L8 10l-.8-3.2L4 6l3.2-.8zM12.5 10.5l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4z",
  "square-arrow": "M8.5 2.5h5v5M13.5 2.5 7.7 8.3M12.5 9.5v3.2a1 1 0 0 1-1 1H3.3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h3.2",
  sun: "M8 2v1M8 13v1M2 8h1M13 8h1M3.7 3.7l.7.7M11.6 11.6l.7.7M12.3 3.7l-.7.7M4.4 11.6l-.7.7M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  users: "M5.2 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM1.8 12.8c.2-2 1.5-3 3.4-3s3.2 1 3.4 3M10.8 6.8a1.8 1.8 0 1 0 0-3.6M10.2 10c1.8-.2 3.1.7 3.4 2.8",
  workspace: "M2.5 4.3a1.3 1.3 0 0 1 1.3-1.3h2.1l1.2 1.5h5.1a1.3 1.3 0 0 1 1.3 1.3v5.2a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3zM5 8h6",
};

export function Icon({ name, size = 16, strokeWidth = 1.5, ...props }: { name: IconName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={PATHS[name]} /></svg>;
}
