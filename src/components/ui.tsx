"use client";
/** Small shared presentational primitives (design system §69). */
import { type ReactNode } from "react";
import { stateColor } from "./hooks";

export function Panel({ children, className = "", title, right }: { children: ReactNode; className?: string; title?: string; right?: ReactNode }) {
  return (
    <section className={`panel ${className}`} style={{ padding: 10 }}>
      {(title || right) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && <h2 className="eyebrow gold-text">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, value, sub, color }: { label: string; value: ReactNode; sub?: string; color?: string }) {
  return (
    <div className="panel-2 px-3 py-2">
      <div className="eyebrow">{label}</div>
      <div className="mono mt-1 text-[17px] font-semibold" style={{ color: color ?? "var(--color-text)" }}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

export function StatusChip({ state, label }: { state: string; label?: string }) {
  const c = stateColor(state);
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider" style={{ color: c, borderColor: `${c}55`, background: `${c}11` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {label ?? state}
    </span>
  );
}

export function Badge({ children, color = "var(--color-muted)" }: { children: ReactNode; color?: string }) {
  return (
    <span className="rounded border px-1 py-0.5 text-[9px] font-semibold tracking-wider" style={{ color, borderColor: `${color}44`, background: `${color}0d` }}>
      {children}
    </span>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="panel-2 flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <div className="text-[12px] text-muted">{text}</div>
    </div>
  );
}

export function Spark({ up, children }: { up?: boolean | null; children: ReactNode }) {
  return <span style={{ color: up === null || up === undefined ? "var(--color-text)" : up ? "#3fb68b" : "#d9605e" }}>{children}</span>;
}

export function CardGrid({ children, cols = "repeat(auto-fill,minmax(210px,1fr))" }: { children: ReactNode; cols?: string }) {
  return <div className="grid gap-2" style={{ gridTemplateColumns: cols }}>{children}</div>;
}
