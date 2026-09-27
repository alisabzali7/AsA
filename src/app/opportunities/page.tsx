"use client";
/** Opportunities — deterministic records with explicit freshness + provenance. */
import { useLang } from "@/components/lang";
import { usePoll, stateColor, fmtAge, formatPrice } from "@/components/hooks";
import { Badge, Empty, Panel, StatusChip } from "@/components/ui";

interface OppItem {
  id: string; symbol: string; timeframe: string; direction: string; score: number;
  mode: string; strategy_id: string; state: string; created_ms: number; updated_ms: number;
  fresh: string; age_ms: number | null; thesis?: string; stop?: number | null; targets?: number[];
  entry_zone?: { top: number; bottom: number } | null; risk?: { verdict: string; reasons: string[] } | null;
  evidence?: string[]; contradictions?: string[];
  blocked_factors?: string[]; unknown_factors?: string[];
  data_quality?: { state?: string; stale?: boolean; age_ms?: number | null; native?: boolean };
  actionable?: boolean;
  signal_state?: string | null;
  note?: string;
}
interface OppShape { ok: boolean; items: OppItem[] }

export default function OpportunitiesPage() {
  const { t } = useLang();
  const { data, error, refresh, loading, age_ms } = usePoll<OppShape>("/api/opportunities?limit=100", 15000);
  const items = data?.items ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[15px] font-semibold">{t("nav", "opportunities")}</h1>
          <p className="text-[11px] text-muted">Deterministic strategy evaluations over TTT data · freshness recomputed on read · signal ≠ order</p>
        </div>
        <button className="btn" onClick={refresh}>refresh</button>
      </div>
      {loading && !data && <p role="status">Loading opportunities…</p>}
      {error && <p role="alert" className="text-down">Opportunities unavailable: {error}. {data ? "Showing last received state." : "No decision state could be loaded."}</p>}
      {data && age_ms !== null && age_ms > 30_000 && <p role="status">STALE — last successful opportunity refresh {Math.floor(age_ms / 1000)}s ago.</p>}
      {!loading && !error && data && items.length === 0 && (
        <Empty text="No stored opportunities yet. Live advisory scans additionally require a strategy with LIVE_ADVISORY_ONLY runtime status and current complete risk/admission evidence. Nothing is simulated." />
      )}
      <div className="grid gap-2 xl:grid-cols-2">
        {items.map((o) => (
          <Panel key={o.id} title={`${o.symbol} · ${o.timeframe} · ${o.direction}`} right={<StatusChip state={o.actionable ? "READY" : (o.signal_state && !["candidate","qualified","published"].includes(o.signal_state) ? o.signal_state : o.fresh === "EXPIRED" ? "EXPIRED" : o.state ?? "REJECTED")} label={o.actionable ? "READY" : (o.signal_state && !["candidate","qualified","published"].includes(o.signal_state) ? o.signal_state : o.fresh === "EXPIRED" ? "EXPIRED" : o.state)} />}>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <Badge color="#d4b874">score {o.score}</Badge>
              <Badge>{o.mode}</Badge>
              <Badge>{o.strategy_id}</Badge>
              <Badge color={o.data_quality?.stale ? "#d6a24a" : undefined}>{o.data_quality?.state ?? (o.fresh === "EXPIRED" ? "EXPIRED" : "—")}</Badge>
              {o.actionable === false && <Badge color="#d9605e">not actionable</Badge>}
              <span className="text-dim">age {o.age_ms !== null ? fmtAge(o.age_ms) : "—"}</span>
            </div>
            {o.thesis && <p className="mb-2 text-[12px] leading-relaxed text-text">{o.thesis}</p>}
            <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
              <div><div className="eyebrow">entry</div><div className="mono">{o.entry_zone ? `${formatPrice(o.entry_zone.bottom)}–${formatPrice(o.entry_zone.top)}` : "—"}</div></div>
              <div><div className="eyebrow">stop</div><div className="mono">{formatPrice(o.stop)}</div></div>
              <div><div className="eyebrow">targets</div><div className="mono">{o.targets?.length ? o.targets.map((x) => formatPrice(x)).join(" / ") : "—"}</div></div>
              <div><div className="eyebrow">risk</div><div style={{ color: o.risk?.verdict === "pass" ? "#3fb68b" : o.risk?.verdict === "block" ? "#d9605e" : "var(--color-muted)" }}>{o.risk?.verdict ?? "—"}</div></div>
            </div>
            {!!o.blocked_factors?.length && <ul aria-label="admission blocks" className="mt-2 list-disc ps-4 text-[11px] text-down">{o.blocked_factors.map((reason,i) => <li key={i}>{reason}</li>)}</ul>}
            {o.risk?.reasons && o.risk.reasons.length > 0 && (
              <details className="mt-1.5 text-[10.5px] text-muted">
                <summary className="cursor-pointer">risk reasons</summary>
                <ul className="mt-1 list-disc pl-4">{o.risk.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </details>
            )}
            <p className="mt-2 text-[9.5px] text-dim">{o.note ?? "score is a deterministic composite — never a calibrated probability"}</p>
          </Panel>
        ))}
      </div>
    </div>
  );
}
