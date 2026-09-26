"use client";
/** Psychology — explainable engine: measured facts, labeled proxies, honest unavailable. */
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Empty, EvidenceBlock, Panel, StatusChip } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useSelection } from "@/components/selection";


interface Section { key: string; label: string; state: string; verdict: string; value?: number | string | null; evidence: string[]; reason?: string }
interface PsychShape { ok: boolean; symbol: string; bias: string; bias_reason: string; sections: Section[]; universe_funding: { measured: number; total: number; mean: number | null; max_abs: number | null } }

const VERDICT_COLOR: Record<string, string> = { MEASURED: "var(--color-up)", DERIVED: "var(--color-warn)", PROXY: "var(--color-warn)", UNVERIFIED: "var(--color-muted)", UNAVAILABLE: "var(--color-dim)" };

export default function PsychologyPage() {
  const { t } = useLang();
  // one selection for the whole terminal: the store is the source of truth,
  // hydrated-reconciled by useSyncExternalStore (no mirror state, no effects)
  const [sel, setSel] = useSelection();
  const symbol = sel.symbol;
  const setSymbol = (v: string) => setSel({ symbol: v });
  // The universe is dynamic (TTT discovery). A hardcoded picker would offer
  // symbols the venue may not even list — the list comes from the real API.
  const syms = usePoll<{ ok: boolean; symbols: string[]; state?: string }>("/api/market/symbols", 600_000);
  const universe = syms.data?.symbols ?? [];
  const active = symbol && universe.includes(symbol) ? symbol : universe[0] ?? null;
  const p = usePoll<PsychShape>(active ? `/api/psychology/summary?symbol=${active}` : null, 10000);
  const d = p.data;
  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "psychology")}
        sub="A real engine with evidence, contradictions and missing evidence — null is never shown as zero."
        right={active ? <span className="mono text-[10.5px] text-gold">{active}</span> : undefined}
      />
      <div className="flex items-center justify-end gap-2">
        {universe.length > 0 ? (
          <select className="input w-[150px]" value={active ?? ""} onChange={(e) => { const v = e.target.value; setSymbol(v); if (v && v !== sel.symbol) setSel({ symbol: v, returnTo: "/psychology" }); }} aria-label="symbol">
            {universe.map((s) => <option key={s}>{s}</option>)}
          </select>
        ) : (
          <span className="panel-2 px-2 py-1 text-[11px] text-muted">{syms.status === "LOADING" ? "loading universe…" : `universe ${syms.status === "OK" ? "empty" : syms.failure?.server_state ?? "UNAVAILABLE"}`}</span>
        )}
      </div>
      <div className="grid gap-2 lg:grid-cols-[1fr_300px]">
        <div className="grid gap-2 sm:grid-cols-2">
          {d?.sections.map((s, i) => (
            <div key={s.key} className="rise" style={{ ["--i" as never]: i % 8 }}>
            <Panel title={s.label} right={<Badge color={VERDICT_COLOR[s.verdict] ?? "var(--color-muted)"}>{s.verdict}</Badge>}>
              <div className="mb-1 flex items-center gap-2">
                <StatusChip state={s.state} />
                {s.value !== null && s.value !== undefined && <span className="mono text-[13px]">{typeof s.value === "number" ? (Math.abs(s.value) > 10 ? s.value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : s.value) : s.value}</span>}
              </div>
              {s.reason && <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--color-warn)" }}>reason: {s.reason}</p>}
              {s.evidence.length > 0 && <div className="mt-1"><EvidenceBlock title="evidence" lines={s.evidence} /></div>}
            </Panel>
            </div>
          ))}
          {p.status === "LOADING" && <Empty text="loading psychology…" />}
          {p.status === "OK" && !d && <Empty text="the summary endpoint answered without a payload — nothing to render" />}
          {(!active || p.status === "UNAVAILABLE" || p.status === "ERROR" || p.status === "OFFLINE") && (
            <div className="sm:col-span-2">
              {!active ? <TruthState status="UNAVAILABLE" failure={{ kind: "UNAVAILABLE", message: "no validated TTT symbol — psychology is computed per discovered universe symbol", status: null, server_state: syms.failure?.server_state ?? null, hint: null }} /> : <TruthState status={p.status} failure={p.failure} onRetry={p.refresh} staleAgeMs={p.data ? p.stale_age_ms : null} />}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Panel title="bias">
            <div className="text-[13px] font-semibold" style={{ color: "var(--color-gold)" }}>{d?.bias ?? "…"} (never asserted without evidence)</div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{d?.bias_reason}</p>
          </Panel>
          <Panel title="universe funding (stats sweep)">
            {d && (
              <ul className="space-y-1 text-[11px]">
                <li className="flex justify-between"><span className="text-muted">measured</span><span className="mono">{d.universe_funding.measured}/{d.universe_funding.total}</span></li>
                <li className="flex justify-between"><span className="text-muted">mean</span><span className="mono">{d.universe_funding.mean === null ? "—" : `${(d.universe_funding.mean * 100).toFixed(4)}%`}</span></li>
                <li className="flex justify-between"><span className="text-muted">max |rate|</span><span className="mono">{d.universe_funding.max_abs === null ? "—" : `${(d.universe_funding.max_abs * 100).toFixed(4)}%`}</span></li>
              </ul>
            )}
          </Panel>
          <Panel title="semantics">
            <ul className="space-y-1 text-[10px] leading-relaxed text-muted">
              <li>MEASURED = TTT supplied the value now.</li>
              <li>DERIVED = computed by AsA from measured inputs (labeled).</li>
              <li>PROXY/UNVERIFIED = semantics not established — no conclusions drawn.</li>
              <li>UNAVAILABLE = no verified public source (liquidations, L/S, CVD).</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
