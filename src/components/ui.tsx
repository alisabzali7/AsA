"use client";
/**
 * AsA design-system primitives — the single visual vocabulary (design system
 * governance: no page may re-invent a badge, panel, table or state).
 * Primitives FORMAT and DISCLOSE; they never assert truth: every state
 * semantic arrives via props derived from the normalized provider state.
 */
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { stateColor } from "./hooks";
import { fmtAge } from "@/lib/i18n/strings";
import {
  IconAlert, IconCheck, IconChevron, IconClose, IconInfo, IconOffline, IconPartial,
  IconRefresh, IconSearch, IconStale, IconVoid,
} from "./icons";

/* -------------------------------------------------------------- containers */

export function Panel({
  children,
  className = "",
  title,
  right,
  sub,
  i,
  icon,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  right?: ReactNode;
  sub?: string;
  i?: number;
  icon?: ReactNode;
}) {
  return (
    <section
      className={`panel ${className}`}
      style={i !== undefined ? ({ ["--i" as never]: i }) : undefined}
      data-rise={i !== undefined ? "" : undefined}
    >
      {(title || right) && (
        <div className="flex items-start justify-between gap-2 border-b hairline px-3 py-2">
          <div className="min-w-0">
            {title && (
              <h2 className="eyebrow gold-text flex items-center gap-1.5 truncate">
                {icon ? <span aria-hidden className="text-gold-3"><span className="contents">{icon}</span></span> : null}
                {title}
              </h2>
            )}
            {sub && <p className="mt-0.5 text-[10px] leading-snug text-dim" dir="auto">{sub}</p>}
          </div>
          {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
        </div>
      )}
      <div className="p-[var(--d-pad)]">{children}</div>
    </section>
  );
}

export function Card({
  children,
  className = "",
  actionable = false,
  onClick,
  i,
}: {
  children: ReactNode;
  className?: string;
  actionable?: boolean;
  onClick?: () => void;
  i?: number;
}) {
  return (
    <div
      className={`card ${actionable ? "card-action" : ""} ${className}`}
      onClick={onClick}
      style={i !== undefined ? ({ ["--i" as never]: i }) : undefined}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  sub,
  right,
  eyebrow,
}: {
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="rise mb-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow gold-text mb-0.5">{eyebrow}</p>}
        <h1 className="text-[16px] font-semibold tracking-wide" dir="auto">{title}</h1>
        {sub ? <p className="mt-0.5 max-w-[70ch] text-[11px] leading-snug text-muted" dir="auto">{sub}</p> : null}
      </div>
      {right && <div className="flex flex-wrap items-center gap-1.5">{right}</div>}
    </div>
  );
}

export function SectionHeader({ label, right, icon }: { label: string; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted">
        {icon && <span className="text-gold" aria-hidden>{icon}</span>}
        <span dir="auto">{label}</span>
      </h2>
      {right}
    </div>
  );
}

/* --------------------------------------------------------------- metrics */

export function Metric({
  label,
  value,
  sub,
  color,
  trend,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  color?: string;
  trend?: "up" | "down" | null;
}) {
  return (
    <div className="kpi">
      <div className="eyebrow" dir="auto">{label}</div>
      <div
        className="mono mt-1 flex items-center gap-1.5 text-[17px] font-semibold leading-tight"
        style={{ color: color ?? "var(--color-text)" }}
      >
        {trend && (
          <span aria-hidden style={{ color: trend === "up" ? "var(--color-up)" : "var(--color-down)" }}>
            {trend === "up" ? "▲" : "▼"}
          </span>
        )}
        <span dir="auto">{value}</span>
      </div>
      {sub && <div className="mt-1 text-[10px] leading-snug text-muted" dir="auto">{sub}</div>}
    </div>
  );
}

export function Stat({ k, v, color, title }: { k: string; v: ReactNode; color?: string; title?: string }) {
  return (
    <div className="panel-2 px-2 py-1.5" title={title}>
      <div className="eyebrow truncate">{k}</div>
      <div className="mono mt-0.5 text-[13px] font-semibold" style={{ color }} dir="auto">{v}</div>
    </div>
  );
}

export function CardGrid({
  children,
  cols = "repeat(auto-fill,minmax(230px,1fr))",
  className = "",
}: {
  children: ReactNode;
  cols?: string;
  className?: string;
}) {
  return <div className={`grid gap-[var(--d-gap)] ${className}`} style={{ gridTemplateColumns: cols }}>{children}</div>;
}

/* ------------------------------------------------------- status vocabulary */

export function statusIcon(state: string): ReactNode {
  const s = state.toUpperCase();
  if (s === "LIVE" || s === "READY" || s === "CONNECTED" || s === "OK" || s === "SENT" || s === "ROBUST") return <IconCheck size={10} />;
  if (s === "STALE" || s === "DEGRADED" || s === "COOLDOWN") return <IconStale size={10} />;
  if (s === "PARTIAL" || s === "GAPPED") return <IconPartial size={10} />;
  if (s === "UNAVAILABLE" || s === "NOT_CONFIGURED" || s === "INSUFFICIENT_DATA" || s === "NETWORK_FAILURE" || s === "NOT_READY" || s === "PENDING" || s === "EXPIRED" || s === "NOT_SYNCED" || s === "UNTESTED") return <IconVoid size={10} />;
  if (s === "OFFLINE") return <IconOffline size={10} />;
  if (s === "ERROR" || s === "REJECTED" || s === "FAILED" || s === "DEAD" || s === "BLOCKED_BY_RISK") return <IconAlert size={10} />;
  return <span className="h-1 w-1 rounded-full bg-current" />;
}

/** StatusBadge — icon + word + color, never color alone (a11y §37). */
export function StatusBadge({ state, label }: { state: string; label?: string }) {
  const c = stateColor(state);
  return (
    <span
      className="chip"
      style={{ color: c, borderColor: `${c}44`, background: `${c}12` }}
      title={state}
      dir="auto"
    >
      {statusIcon(state)}
      <span className="dot" style={{ background: c }} aria-hidden />
      {label ?? state}
    </span>
  );
}

/** Back-compat alias used across pages — same single implementation. */
export const StatusChip = StatusBadge;

export function Badge({
  children,
  color = "var(--color-muted)",
  mono = true,
  className = "",
}: {
  children: ReactNode;
  color?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wider ${mono ? "mono" : ""} ${className}`}
      style={{ color, borderColor: `${color}44`, background: `${color}0d` }}
      dir="auto"
    >
      {children}
    </span>
  );
}

/** provenance — compact, premium, always the server's own words */
export function ProvenanceBadge({ source, endpoint, kind }: { source?: string | null; endpoint?: string | null; kind?: string | null }) {
  if (!source && !endpoint && !kind) return null;
  return (
    <span className="tip inline-flex items-center gap-1 text-[9.5px] text-dim" tabIndex={0}>
      <IconInfo size={10} />
      <span className="mono iso">{[source, kind].filter(Boolean).join(" · ") || "provenance"}</span>
      <span role="tooltip" className="tip-body mono iso">
        {[source && `source ${source}`, endpoint && `endpoint ${endpoint}`, kind && `kind ${kind}`].filter(Boolean).join("\n")}
      </span>
    </span>
  );
}

/** freshness — age + semantic verdict; never a bare dot. */
export function FreshnessIndicator({ ageMs, state, label }: { ageMs: number | null; state?: string; label?: string }) {
  const c = state ? stateColor(state) : "var(--color-muted)";
  return (
    <span className="inline-flex items-center gap-1 text-[9.5px]" style={{ color: c }} dir="auto">
      {state ? statusIcon(state) : null}
      <span className="mono iso">{ageMs === null ? "—" : fmtAge(ageMs)}</span>
      <span className="text-dim">{label ?? state ?? "age"}</span>
    </span>
  );
}

export function Spark({ up, children }: { up?: boolean | null; children: ReactNode }) {
  return (
    <span style={{ color: up === null || up === undefined ? "var(--color-text)" : up ? "var(--color-up)" : "var(--color-down)" }}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------ form controls */

export function Button({
  children,
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "gold" | "ghost" | "active";
}) {
  const variantClass =
    variant === "gold" ? "btn-gold" : variant === "ghost" ? "btn-ghost" : variant === "active" ? "btn-active" : "";
  return (
    <button className={`focus-ring btn ${variantClass} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function IconButton({
  children,
  className = "",
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
}) {
  return (
    <button className={`focus-ring icon-btn ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...props} />;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  onClear,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div className={`relative flex items-center ${className}`}>
      <span className="pointer-events-none absolute start-2 text-dim">
        <IconSearch size={13} />
      </span>
      <input
        type="search"
        className="input ps-7 pe-7 py-1 text-[11.5px]"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && onClear && (
        <button
          className="focus-ring icon-btn absolute end-1 !h-5 !w-5 text-dim hover:text-text"
          onClick={onClear}
          aria-label="clear search"
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input ${className}`} {...props}>{children}</select>;
}

/* ------------------------------------------------------ empty / disclosure */

export function Empty({ text, icon }: { text: string; icon?: ReactNode }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-9 text-center"
      style={{ borderColor: "var(--color-line-2)", background: "rgba(255,255,255,0.008)" }}
      role="status"
    >
      <span className="text-dim" aria-hidden>{icon ?? <IconVoid size={20} />}</span>
      <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-muted" dir="auto">{text}</p>
    </div>
  );
}

export const EmptyState = Empty;

export function Disclosure({ summary, children, tone = "muted" }: { summary: string; children: ReactNode; tone?: "muted" | "warn" }) {
  const id = useId();
  return (
    <details className="group text-[10.5px]" aria-labelledby={id}>
      <summary
        id={id}
        className="focus-ring flex cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 font-semibold uppercase tracking-wider transition-colors hover:text-gold"
        style={{ color: tone === "warn" ? "var(--color-warn)" : "var(--color-muted)" }}
      >
        <span className="transition-transform duration-[var(--t-micro)] group-open:rotate-90" aria-hidden><IconChevron size={10} /></span>
        <span dir="auto">{summary}</span>
      </summary>
      <div className="mt-1 ps-1" id={id}>{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------- skeletons */

export function Skeleton({ className = "h-4 w-full", lines = 1 }: { className?: string; lines?: number }) {
  return (
    <div aria-hidden className="space-y-1.5">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`skeleton ${className}`} style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export const LoadingState = ({ label = "Loading data…" }: { label?: string }) => (
  <div className="space-y-2 p-3">
    <div className="text-[11px] text-muted flex items-center gap-1.5">
      <span className="breathe h-1.5 w-1.5 rounded-full bg-gold" />
      {label}
    </div>
    <Skeleton className="h-5" lines={3} />
  </div>
);

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-1 py-1" aria-hidden>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-2" style={{ height: "var(--d-row)", alignItems: "center" }}>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="skeleton h-3 flex-1" style={{ opacity: 1 - r * 0.13 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- navigation bits */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly { id: T; label: string; count?: number | null; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg border hairline p-0.5" style={{ background: "var(--color-ink)" }}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`focus-ring inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-[var(--t-micro)] ${active ? "btn-active" : "text-muted hover:text-text"}`}
            onClick={() => onChange(t.id)}
          >
            {t.icon && <span className="opacity-75">{t.icon}</span>}
            <span dir="auto">{t.label}</span>
            {typeof t.count === "number" && <span className="mono ms-1 text-[9px] text-dim">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { id: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-lg border hairline p-0.5" style={{ background: "var(--color-ink)" }}>
      {options.map((o) => (
        <button
          key={o.id}
          title={o.title}
          aria-pressed={o.id === value}
          className={`focus-ring rounded-md px-2 py-1 text-[10.5px] font-semibold transition-all duration-[var(--t-micro)] ${o.id === value ? "btn-active" : "text-muted hover:text-text"}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilterBar<T extends string>({
  filters,
  active,
  onChange,
  label = "Filter options",
}: {
  filters: readonly { id: T; label: string; count?: number | null }[];
  active: T;
  onChange: (f: T) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {filters.map((f) => {
        const isActive = f.id === active;
        return (
          <button
            key={f.id}
            onClick={() => onChange(f.id)}
            className={`focus-ring chip cursor-pointer ${isActive ? "!border-gold-2 !bg-gold-dim !text-gold" : "text-muted hover:text-text"}`}
            aria-pressed={isActive}
          >
            <span dir="auto">{f.label}</span>
            {typeof f.count === "number" && <span className="mono ms-0.5 text-[8.5px] opacity-75">({f.count})</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- timeline */

export function Timeline({ items }: { items: { at: number; text: ReactNode; tone?: string }[] }) {
  return (
    <ol className="relative space-y-1.5 ps-4">
      <span className="absolute inset-y-1 start-[5px] w-px" style={{ background: "linear-gradient(180deg, transparent, var(--color-line-2) 12%, var(--color-line-2) 88%, transparent)" }} aria-hidden />
      {items.map((it, i) => (
        <li key={i} className="relative flex flex-wrap items-baseline gap-x-2 text-[10.5px] leading-snug">
          <span className="absolute -start-4 top-1 h-1.5 w-1.5 rounded-full" style={{ background: it.tone ?? "var(--color-gold-3)", boxShadow: i === 0 ? "0 0 6px rgba(216,188,120,.6)" : undefined }} aria-hidden />
          <span className="mono iso shrink-0 text-dim">{new Date(it.at).toLocaleTimeString("en-GB", { hour12: false })}</span>
          <span className="min-w-0 flex-1 text-muted" dir="auto">{it.text}</span>
        </li>
      ))}
      {items.length === 0 && <li className="text-[10.5px] text-dim">no events on the bus yet</li>}
    </ol>
  );
}

/* -------------------------------------------------------- evidence & decision blocks */

export function EvidenceBlock({
  title,
  lines,
  tone,
}: {
  title: string;
  lines: readonly string[];
  tone?: "up" | "down" | "warn" | "muted";
}) {
  const color =
    tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : tone === "warn" ? "var(--color-warn)" : "var(--color-muted)";
  return (
    <div className="evidence">
      <p className="eyebrow" style={{ color }} dir="auto">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {lines.map((l, i) => <li key={i} className="text-[11px] leading-snug text-muted" dir="auto">· {l}</li>)}
        {lines.length === 0 && <li className="text-[10.5px] text-dim">the backend returned none</li>}
      </ul>
    </div>
  );
}

export function DecisionBlock({
  verdict,
  score,
  scoreSemantics = "decision score, not a probability",
  reasons = [],
  tone,
}: {
  verdict: string;
  score?: number | null;
  scoreSemantics?: string;
  reasons?: readonly string[];
  tone?: "pass" | "block" | "warn" | "neutral";
}) {
  const color =
    tone === "pass" || verdict === "pass" || verdict === "READY"
      ? "var(--color-up)"
      : tone === "block" || verdict === "block" || verdict === "REJECTED"
      ? "var(--color-down)"
      : "var(--color-warn)";
  return (
    <div className="panel-2 p-2.5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-muted">engine verdict</span>
        <StatusBadge state={verdict} />
      </div>
      {typeof score === "number" && (
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="mono text-xl font-bold" style={{ color }}>{score}</span>
          <span className="text-[9.5px] text-dim">/ 100</span>
          <span className="text-[9.5px] text-muted italic" dir="auto">({scoreSemantics})</span>
        </div>
      )}
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t hairline pt-1.5">
          {reasons.map((r, i) => (
            <li key={i} className="text-[10.5px] text-muted" dir="auto">▸ {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SourceBlock({
  source,
  provenance,
  endpoint,
  ageMs,
}: {
  source?: string;
  provenance?: string;
  endpoint?: string;
  ageMs?: number | null;
}) {
  return (
    <div className="meta-strip border-t hairline pt-1">
      {source && <span>source: <strong className="mono text-text">{source}</strong></span>}
      {provenance && <span>· provenance: <strong className="mono text-text">{provenance}</strong></span>}
      {endpoint && <span>· endpoint: <code className="mono text-dim">{endpoint}</code></span>}
      {ageMs !== undefined && <span>· age: <strong className="mono text-text">{fmtAge(ageMs)}</strong></span>}
    </div>
  );
}

/** loading affordance shared by every retry-capable surface */
export function RetryButton({ onRetry, label = "retry now" }: { onRetry: () => void; label?: string }) {
  return (
    <button className="focus-ring btn px-2 py-0.5 text-[10px]" onClick={onRetry}>
      <span className="transition-transform duration-[var(--t-micro)]" aria-hidden><IconRefresh size={10} /></span>
      {label}
    </button>
  );
}

export { Popover, Dialog, Modal, Drawer, Sheet, AdaptiveDrawer } from "./overlay";
