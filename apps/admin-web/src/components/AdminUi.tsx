import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface MetricItem {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "accent" | "success" | "warning";
  icon?: IconName;
  trend?: string;
}

export function PageHeader(props: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return <header className="adm-pagehead">
    <div><h1 className="adm-pagehead-title">{props.title}</h1>{props.sub && <p className="adm-pagehead-sub">{props.sub}</p>}</div>
    {props.actions && <div className="adm-pagehead-actions">{props.actions}</div>}
  </header>;
}

export function RefreshButton(props: { busy: boolean; label?: string; onClick: () => void }) {
  const label = props.label ?? "刷新数据";
  return <button className="adm-btn" type="button" onClick={() => props.onClick()} disabled={props.busy}>
    <Icon name="refresh" size={14} className={props.busy ? "adm-spin" : undefined} /><span>{props.busy ? "读取中" : label}</span>
  </button>;
}

const STAT_TONE: Record<NonNullable<MetricItem["tone"]>, string> = { default: "", accent: "adm-stat-accent", success: "adm-stat-ok", warning: "adm-stat-warn" };

export function MetricStrip({ items, label }: { items: MetricItem[]; label: string }) {
  return <section className="adm-stats" aria-label={label}>{items.map((item) =>
    <article className={`adm-stat ${STAT_TONE[item.tone ?? "default"]}`} key={item.label}>
      <div className="adm-stat-top"><span>{item.label}</span>{item.icon && <span className="adm-stat-icon"><Icon name={item.icon} size={13} /></span>}</div>
      <strong className="adm-stat-value">{item.value}</strong>
      <div className="adm-stat-sub">{item.detail}{item.trend ? ` · ${item.trend}` : ""}</div>
    </article>)}</section>;
}

export function FilterBar(props: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  options: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (value: string) => void;
  resultCount: number;
}) {
  return <div className="adm-toolbar">
    <label className="adm-search"><Icon name="search" size={15} /><input value={props.query} placeholder={props.placeholder} onChange={(event) => props.onQuery(event.target.value)} /></label>
    <div className="adm-seg" role="group" aria-label="筛选范围">{props.options.map((option) => <button type="button" key={option.id} aria-pressed={props.selected === option.id} onClick={() => props.onSelect(option.id)}>{option.label}</button>)}</div>
    <span className="adm-count">{props.resultCount} 项</span>
  </div>;
}

export function Card(props: { title: string; meta?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`adm-card ${props.className ?? ""}`}>
    <header className="adm-card-head"><h2 className="adm-card-title">{props.title}</h2><div className="adm-card-meta">{props.meta && <span>{props.meta}</span>}{props.actions}</div></header>
    {props.children}
  </section>;
}

export function Badge({ tone, children }: { tone?: "ok" | "info" | "warn" | "err"; children: ReactNode }) {
  return <span className={`adm-badge${tone ? ` adm-badge-${tone}` : ""}`}>{children}</span>;
}

export function Dot({ tone }: { tone?: "ok" | "warn" | "err" }) {
  return <span className={`adm-dot${tone ? ` adm-dot-${tone}` : ""}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="adm-state">{children}</div>;
}

export interface SelectOption { value: string; label: string }

export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const currentIndex = props.options.findIndex((option) => option.value === props.value);
  const current = currentIndex >= 0 ? props.options[currentIndex] : null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openMenu = () => {
    setHighlight(currentIndex >= 0 ? currentIndex : 0);
    setOpen(true);
  };
  const pick = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  return <div className="adm-select" ref={root}>
    <button type="button" className="adm-select-btn" disabled={props.disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-label={props.ariaLabel}
      onClick={() => (open ? setOpen(false) : openMenu())}
      onKeyDown={(event) => {
        if (!open) {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); openMenu(); }
          return;
        }
        if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((index) => Math.min(index + 1, props.options.length - 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => Math.max(index - 1, 0)); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (highlight >= 0 && props.options[highlight]) pick(props.options[highlight].value); }
        else if (event.key === "Tab") setOpen(false);
      }}>
      <span className="adm-select-value">{current ? current.label : (props.placeholder ?? "请选择")}</span>
    </button>
    {open && <div className="adm-select-pop" role="listbox" aria-label={props.ariaLabel}>
      {props.options.map((option, index) => (
        <button key={option.value} type="button" role="option" aria-selected={option.value === props.value}
          className={`adm-select-opt${index === highlight ? " is-active" : ""}`}
          ref={index === highlight ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => pick(option.value)}>
          <span>{option.label}</span>
        </button>
      ))}
    </div>}
  </div>;
}
