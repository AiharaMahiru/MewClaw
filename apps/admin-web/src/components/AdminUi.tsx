import type { ReactNode } from "react";

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
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  status?: ReactNode;
}) {
  return <header className="workspace-heading">
    <div><h1>{props.title}</h1></div>
    {(props.status || props.actions) && <div className="heading-actions">{props.status}{props.actions}</div>}
  </header>;
}

export function RefreshButton(props: { busy: boolean; label?: string; onClick: () => void }) {
  const label = props.label ?? "刷新数据";
  return <button className="refresh-button" type="button" onClick={() => props.onClick()} disabled={props.busy}>
    <Icon name="refresh" size={14} /><span>{props.busy ? "读取中" : label}</span>
  </button>;
}

export function MetricStrip({ items, label }: { items: MetricItem[]; label: string }) {
  return <section className="metric-strip" aria-label={label}>{items.map((item) =>
    <article className={`metric-tile ${item.tone ?? "default"}`} key={item.label}>
      <div className="metric-topline"><span>{item.label}</span>{item.icon && <span className="metric-icon"><Icon name={item.icon} size={15} /></span>}</div>
      <strong>{item.value}</strong>
      <div className="metric-bottom">{item.detail && <em>{item.detail}</em>}{item.trend && <b>{item.trend}</b>}</div>
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
  return <div className="filter-bar">
    <label className="search-field"><span className="search-mark" aria-hidden="true"><Icon name="search" size={15} /></span><input value={props.query} placeholder={props.placeholder} onChange={(event) => props.onQuery(event.target.value)} /></label>
    <div className="segmented" role="group" aria-label="筛选范围">{props.options.map((option) => <button type="button" key={option.id} aria-pressed={props.selected === option.id} onClick={() => props.onSelect(option.id)}>{option.label}</button>)}</div>
    <span className="result-count">{props.resultCount} 项</span>
  </div>;
}

export function SectionHeading(props: { title: string; id?: string; meta?: string; actions?: ReactNode }) {
  return <div className="section-heading"><h2 id={props.id}>{props.title}</h2><div className="section-heading-meta">{props.meta && <span>{props.meta}</span>}{props.actions}</div></div>;
}
