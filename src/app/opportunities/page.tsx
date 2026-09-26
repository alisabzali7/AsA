"use client";
/** Opportunities — deterministic records with explicit freshness + provenance.
 *  Composition rules: one PageHead, staggered card entrances, evidence blocks
 *  only ever from the server's own fields, and a selection-aware "open on
 *  chart" that hands the symbol to the whole terminal (never just a link). */
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { usePoll, fmtAge, formatPrice } from "@/components/hooks";
import { Badge, Disclosure, Empty, EvidenceBlock, Panel, StatusChip } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useSelection } from "@/components/selection";
import { IconChart, IconRefresh } from "@/components/icons";

interface OppItem {
  id: string; symbol: string; timeframe: string; direction: string; score: number;
  mode: string; strategy_id: string; state: string; created_ms: number; updated_ms: number;
  fresh: string; age_ms: number | null; thesis?: string; stop?: number | null; targets?: number[];
  entry_zone?: { top: number; bottom: number } | null; risk?: { verdict: string; reasons: string[] } | null;
  evidence?: string[]; contradictions?: string[];
  blocked_factors?: string[]; unknown_factors?: string[];
  data_quality?: { state?: string; stale?: boolean; age_ms?: number | null; native?: boolean };
  actionable?: boolean;
  note?: string;
}
interface OppShape { ok: boolean; items: OppItem[] }

export default function OpportunitiesPage() {
  const { t } = useLang();
  const router = useRouter();
  const [sel, setSel] = useSelection();
  const poll = usePoll<OppShape>("/api/opportunities?limit=100", 15000);
  const { data, refresh } = poll;
  const ready = poll.status === "OK";
  const items = ready ? data?.items ?? [] : [];
  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "opportunities")}
        sub="Deterministic strategy evaluations over TTT data · freshness recomputed on read · signal ≠ order"
        right={
          <>
            <span className="meta-strip"><span className="mono iso">{ready ? `${items.length} records` : "awaiting verdict"}</span></span>
            <button className="focus-ring btn group/r text-[10.5px]" onClick={refresh}>
              <span className="inline-block transition-transform duration-[var(--t-short)] group-hover/r:rotate-180" aria-hidden><IconRefresh size={11} /></span>
              refresh
            </button>
          </>
        }
      />
      {!ready && <TruthState status={poll.status} failure={poll.failure} onRetry={refresh} staleAgeMs={data ? poll.stale_age_ms : null} />}
      {ready && items.length === 0 && (
        <Empty text="EMPTY — the backend answered successfully and no opportunities are stored. (Live advisory scans additionally require a strategy with LIVE_ADVISORY_ONLY runtime status; none currently holds it.)" />
      )}
      <div className="grid gap-2 xl:grid-cols-2">
        {items.map((o, i) => (
          <div key={o.id} className="rise" style={{ ["--i" as never]: i % 8 }}>
          <Panel title={`${o.symbol} · ${o.timeframe} · ${o.direction}`} right={<>
            <button
              className="focus-ring icon-btn"
              title="open this symbol on the terminal"
              onClick={() => { setSel({ symbol: o.symbol, returnTo: "/opportunities" }); router.push(`/chart?symbol=${o.symbol}`); }}
            ><IconChart size={13} /></button>
            <StatusChip state={o.actionable ? "READY" : (o.fresh === "EXPIRED" ? "EXPIRED" : o.state ?? "REJECTED")} label={o.actionable ? "READY" : (o.fresh === "EXPIRED" ? "EXPIRED" : o.state)} />
          </>}>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <Badge color="var(--color-gold)">score {o.score}</Badge>
              <Badge>{o.mode}</Badge>
              <Badge>{o.strategy_id}</Badge>
              <Badge color={o.data_quality?.stale ? "var(--color-warn)" : undefined}>{o.data_quality?.state ?? (o.fresh === "EXPIRED" ? "EXPIRED" : "—")}</Badge>
              {o.actionable === false && <Badge color="var(--color-down)">not actionable</Badge>}
              <span className="text-dim">age {o.age_ms !== null ? fmtAge(o.age_ms) : "—"}</span>
            </div>
            {o.thesis && <p className="mb-2 text-[12px] leading-relaxed text-text">{o.thesis}</p>}
            <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
              <div><div className="eyebrow">entry</div><div className="mono">{o.entry_zone ? `${formatPrice(o.entry_zone.bottom)}–${formatPrice(o.entry_zone.top)}` : "—"}</div></div>
              <div><div className="eyebrow">stop</div><div className="mono">{formatPrice(o.stop)}</div></div>
              <div><div className="eyebrow">targets</div><div className="mono">{o.targets?.length ? o.targets.map((x) => formatPrice(x)).join(" / ") : "—"}</div></div>
              <div><div className="eyebrow">risk</div><div style={{ color: o.risk?.verdict === "pass" ? "var(--color-up)" : o.risk?.verdict === "block" ? "var(--color-down)" : "var(--color-muted)" }}>{o.risk?.verdict ?? "—"}</div></div>
            </div>
            {(o.risk?.reasons?.length ?? 0) > 0 && (
              <Disclosure summary={`risk reasons (${o.risk!.reasons!.length})`} tone={o.risk!.verdict === "block" ? "warn" : "muted"}>
                <ul className="space-y-0.5">{o.risk!.reasons!.map((r, ix) => <li key={ix} className="text-[10.5px] text-muted" dir="auto">· {r}</li>)}</ul>
              </Disclosure>
            )}
            {(o.evidence?.length || o.contradictions?.length) ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {o.evidence && o.evidence.length > 0 && <EvidenceBlock title="evidence" lines={o.evidence} tone="up" />}
                {o.contradictions && o.contradictions.length > 0 && <EvidenceBlock title="contradictions" lines={o.contradictions} tone="down" />}
              </div>
            ) : null}
            <p className="mt-2 text-[9.5px] text-dim">{o.note ?? "score is a deterministic composite — never a calibrated probability"}</p>
          </Panel>
          </div>
        ))}
      </div>
    </div>
  );
}
