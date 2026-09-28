"use client";
/**
 * Opportunities — deterministic strategy evaluations over TTT market data.
 * Includes interactive filtering, search, and the Opportunity Detail Drawer.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { usePoll, fmtAge, formatPrice } from "@/components/hooks";
import {
  Badge,
  Button,
  DecisionBlock,
  Disclosure,
  Empty,
  EvidenceBlock,
  FilterBar,
  IconButton,
  Panel,
  SearchInput,
  Stat,
  StatusBadge,
  StatusChip,
} from "@/components/ui";
import { AdaptiveDrawer } from "@/components/overlay";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useSelection } from "@/components/selection";
import { IconAi, IconChart, IconInfo, IconRefresh } from "@/components/icons";

interface OppItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  mode: string;
  strategy_id: string;
  state: string;
  created_ms: number;
  updated_ms: number;
  fresh: string;
  age_ms: number | null;
  thesis?: string;
  stop?: number | null;
  targets?: number[];
  entry_zone?: { top: number; bottom: number } | null;
  risk?: { verdict: string; reasons: string[] } | null;
  evidence?: string[];
  contradictions?: string[];
  blocked_factors?: string[];
  unknown_factors?: string[];
  positive_factors?: string[];
  negative_factors?: string[];
  data_quality?: { state?: string; stale?: boolean; age_ms?: number | null; native?: boolean };
  actionable?: boolean;
  signal_id?: string | null;
  signal_state?: string | null;
  note?: string;
}

interface OppShape {
  ok: boolean;
  items: OppItem[];
}

type DirectionFilter = "all" | "long" | "short";
type StateFilter = "all" | "ready" | "rejected" | "expired";

export default function OpportunitiesPage() {
  const { t } = useLang();
  const router = useRouter();
  const [, setSel] = useSelection();

  const [search, setSearch] = useState("");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [selectedOpp, setSelectedOpp] = useState<OppItem | null>(null);

  const poll = usePoll<OppShape>("/api/opportunities?limit=100", 15000);
  const { data, refresh } = poll;
  const ready = poll.status === "OK";
  const items = useMemo(() => (ready ? data?.items ?? [] : []), [ready, data?.items]);

  const filteredItems = useMemo(() => {
    return items.filter((o) => {
      if (search.trim()) {
        const q = search.trim().toUpperCase();
        if (!o.symbol.toUpperCase().includes(q) && !o.strategy_id.toUpperCase().includes(q)) {
          return false;
        }
      }
      if (dirFilter !== "all" && o.direction.toLowerCase() !== dirFilter) return false;
      if (stateFilter === "ready" && !o.actionable && o.state !== "READY") return false;
      if (stateFilter === "rejected" && o.state !== "REJECTED" && o.risk?.verdict !== "block") return false;
      if (stateFilter === "expired" && o.fresh !== "EXPIRED" && o.state !== "EXPIRED") return false;
      return true;
    });
  }, [items, search, dirFilter, stateFilter]);

  const handleOpenChart = (opp: OppItem) => {
    setSel({ symbol: opp.symbol, tf: opp.timeframe, returnTo: "/opportunities" });
    router.push(`/chart?symbol=${opp.symbol}`);
  };

  const handleOpenAi = (opp: OppItem) => {
    setSel({ symbol: opp.symbol, tf: opp.timeframe, returnTo: "/opportunities" });
    router.push(
      `/ai-clone?q=${encodeURIComponent(
        `Explain opportunity ${opp.id} on ${opp.symbol} (${opp.strategy_id} score ${opp.score}) and why risk verdict is ${opp.risk?.verdict ?? "unknown"}.`
      )}`
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "opportunities")}
        sub="Deterministic strategy evaluations over TTT data · freshness recomputed on read · signal ≠ order"
        right={
          <div className="flex items-center gap-2">
            <span className="meta-strip">
              <span className="mono iso">{ready ? `${items.length} records` : "awaiting verdict"}</span>
            </span>
            <button className="focus-ring btn group/r text-[10.5px]" onClick={refresh}>
              <span className="inline-block transition-transform duration-[var(--t-short)] group-hover/r:rotate-180" aria-hidden>
                <IconRefresh size={11} />
              </span>
              refresh
            </button>
          </div>
        }
      />

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            onClear={() => setSearch("")}
            placeholder="Search symbol or strategy…"
            className="w-[220px]"
          />
          <FilterBar<DirectionFilter>
            active={dirFilter}
            onChange={setDirFilter}
            filters={[
              { id: "all", label: "All Directions" },
              { id: "long", label: "▲ Long" },
              { id: "short", label: "▼ Short" },
            ]}
          />
          <FilterBar<StateFilter>
            active={stateFilter}
            onChange={setStateFilter}
            filters={[
              { id: "all", label: "All States" },
              { id: "ready", label: "Ready" },
              { id: "rejected", label: "Rejected" },
              { id: "expired", label: "Expired" },
            ]}
          />
        </div>

        {ready && (
          <span className="text-[11px] text-dim mono ms-auto">
            showing {filteredItems.length} of {items.length}
          </span>
        )}
      </div>

      {!ready && (
        <TruthState
          status={poll.status}
          failure={poll.failure}
          onRetry={refresh}
          staleAgeMs={data ? poll.stale_age_ms : null}
        />
      )}

      {ready && items.length === 0 && (
        <Empty text="EMPTY — the backend answered successfully and no opportunities are stored. Live advisory scans additionally require LIVE_ADVISORY_ONLY strategy status and current complete risk/admission evidence. Nothing is simulated." />
      )}

      {ready && items.length > 0 && filteredItems.length === 0 && (
        <Empty text="No opportunities match the selected filters." />
      )}

      {/* Cards Grid */}
      <div className="grid gap-2 xl:grid-cols-2">
        {filteredItems.map((o, i) => {
          const isReadyState =
            o.signal_state && !["candidate", "qualified", "published"].includes(o.signal_state)
              ? o.signal_state
              : o.actionable
              ? "READY"
              : o.fresh === "EXPIRED"
              ? "EXPIRED"
              : o.state ?? "REJECTED";

          return (
            <div key={o.id} className="rise" style={{ ["--i" as never]: i % 8 }}>
              <Panel
                title={`${o.symbol} · ${o.timeframe} · ${o.direction}`}
                right={
                  <div className="flex items-center gap-1.5">
                    <IconButton
                      label="inspect opportunity details"
                      onClick={() => setSelectedOpp(o)}
                    >
                      <IconInfo size={13} />
                    </IconButton>
                    <IconButton
                      label="open on chart terminal"
                      onClick={() => handleOpenChart(o)}
                    >
                      <IconChart size={13} />
                    </IconButton>
                    <StatusChip state={isReadyState} />
                  </div>
                }
              >
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                  <Badge color="var(--color-gold)">score {o.score}</Badge>
                  <Badge>{o.mode}</Badge>
                  <Badge>{o.strategy_id}</Badge>
                  <Badge color={o.data_quality?.stale ? "var(--color-warn)" : undefined}>
                    {o.data_quality?.state ?? (o.fresh === "EXPIRED" ? "EXPIRED" : "—")}
                  </Badge>
                  {o.actionable === false && <Badge color="var(--color-down)">not actionable</Badge>}
                  <span className="text-dim">age {o.age_ms !== null ? fmtAge(o.age_ms) : "—"}</span>
                </div>

                {o.thesis && <p className="mb-2 text-[12px] leading-relaxed text-text font-medium" dir="auto">{o.thesis}</p>}

                <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4 border-y hairline py-2 my-2">
                  <div>
                    <div className="eyebrow text-dim">entry zone</div>
                    <div className="mono font-semibold">
                      {o.entry_zone ? `${formatPrice(o.entry_zone.bottom)}–${formatPrice(o.entry_zone.top)}` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow text-dim">stop loss</div>
                    <div className="mono font-semibold text-down">{formatPrice(o.stop)}</div>
                  </div>
                  <div>
                    <div className="eyebrow text-dim">targets</div>
                    <div className="mono font-semibold text-up">
                      {o.targets?.length ? o.targets.map((x) => formatPrice(x)).join(" / ") : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow text-dim">risk verdict</div>
                    <div
                      className="font-bold uppercase"
                      style={{
                        color:
                          o.risk?.verdict === "pass"
                            ? "var(--color-up)"
                            : o.risk?.verdict === "block"
                            ? "var(--color-down)"
                            : "var(--color-muted)",
                      }}
                    >
                      {o.risk?.verdict ?? "—"}
                    </div>
                  </div>
                </div>

                {!!o.blocked_factors?.length && (
                  <div className="mb-2">
                    <div className="eyebrow text-down mb-1">admission blocks</div>
                    <ul className="list-disc ps-4 text-[11px] text-down space-y-0.5">
                      {o.blocked_factors.map((reason, ix) => (
                        <li key={ix} dir="auto">{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {(o.risk?.reasons?.length ?? 0) > 0 && (
                  <Disclosure summary={`risk reasons (${o.risk!.reasons!.length})`} tone={o.risk!.verdict === "block" ? "warn" : "muted"}>
                    <ul className="space-y-0.5">
                      {o.risk!.reasons!.map((r, ix) => (
                        <li key={ix} className="text-[10.5px] text-muted" dir="auto">· {r}</li>
                      ))}
                    </ul>
                  </Disclosure>
                )}

                {(o.evidence?.length || o.contradictions?.length) ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {o.evidence && o.evidence.length > 0 && <EvidenceBlock title="evidence" lines={o.evidence} tone="up" />}
                    {o.contradictions && o.contradictions.length > 0 && <EvidenceBlock title="contradictions" lines={o.contradictions} tone="down" />}
                  </div>
                ) : null}

                <div className="mt-2.5 flex items-center justify-between pt-2 border-t hairline text-[9.5px] text-dim">
                  <span>{o.note ?? "decision score, not a probability"}</span>
                  <button
                    onClick={() => setSelectedOpp(o)}
                    className="text-gold hover:underline font-semibold"
                  >
                    view full dossier →
                  </button>
                </div>
              </Panel>
            </div>
          );
        })}
      </div>

      {/* Opportunity Detail Drawer */}
      {selectedOpp && (
        <AdaptiveDrawer
          title={`${selectedOpp.symbol} Opportunity Dossier`}
          sub={`${selectedOpp.timeframe} · ${selectedOpp.direction.toUpperCase()} · ${selectedOpp.strategy_id}`}
          onClose={() => setSelectedOpp(null)}
          width="540px"
          badge={<StatusBadge state={selectedOpp.state} />}
        >
          <div className="flex flex-col gap-3">
            {/* Quick Actions */}
            <div className="flex gap-2 border-b hairline pb-3">
              <Button variant="gold" className="flex-1" onClick={() => handleOpenChart(selectedOpp)}>
                <IconChart size={13} /> Open on Chart
              </Button>
              <Button variant="default" className="flex-1" onClick={() => handleOpenAi(selectedOpp)}>
                <IconAi size={13} /> Ask AI Clone
              </Button>
            </div>

            {/* Decision Verdict Block */}
            <DecisionBlock
              verdict={selectedOpp.risk?.verdict === "pass" ? "READY" : selectedOpp.risk?.verdict === "block" ? "REJECTED" : selectedOpp.state}
              score={selectedOpp.score}
              scoreSemantics="decision score, not a probability"
              reasons={selectedOpp.risk?.reasons ?? []}
            />

            {/* Trade Parameters */}
            <Panel title="Advisory Geometry">
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Stat k="entry zone" v={selectedOpp.entry_zone ? `${formatPrice(selectedOpp.entry_zone.bottom)}–${formatPrice(selectedOpp.entry_zone.top)}` : "—"} />
                <Stat k="stop loss" v={formatPrice(selectedOpp.stop)} color="var(--color-down)" />
                <Stat k="targets" v={selectedOpp.targets?.map(formatPrice).join(" / ") ?? "—"} color="var(--color-up)" />
                <Stat k="freshness" v={selectedOpp.fresh} />
              </div>
            </Panel>

            {/* Factors Breakdown */}
            {(selectedOpp.positive_factors?.length || selectedOpp.negative_factors?.length || selectedOpp.blocked_factors?.length) ? (
              <div className="space-y-2">
                {selectedOpp.positive_factors && selectedOpp.positive_factors.length > 0 && (
                  <EvidenceBlock title="Positive Factors" lines={selectedOpp.positive_factors} tone="up" />
                )}
                {selectedOpp.negative_factors && selectedOpp.negative_factors.length > 0 && (
                  <EvidenceBlock title="Negative Factors" lines={selectedOpp.negative_factors} tone="down" />
                )}
                {selectedOpp.blocked_factors && selectedOpp.blocked_factors.length > 0 && (
                  <EvidenceBlock title="Admission Block Factors" lines={selectedOpp.blocked_factors} tone="down" />
                )}
              </div>
            ) : null}

            {/* Provenance & Lineage */}
            <Panel title="Lineage & Origin">
              <ul className="space-y-1 text-[10.5px] text-muted">
                <li>· Strategy: <strong className="mono text-text">{selectedOpp.strategy_id}</strong></li>
                <li>· Opportunity ID: <code className="mono text-dim">{selectedOpp.id}</code></li>
                <li>· Created: <strong className="mono text-text">{new Date(selectedOpp.created_ms).toLocaleString()}</strong></li>
                <li>· Updated: <strong className="mono text-text">{new Date(selectedOpp.updated_ms).toLocaleString()}</strong></li>
                <li>· Mode: <strong className="mono text-text">{selectedOpp.mode}</strong></li>
                <li>· Data Quality: <strong className="mono text-text">{selectedOpp.data_quality?.state ?? "OK"}</strong></li>
              </ul>
            </Panel>
          </div>
        </AdaptiveDrawer>
      )}
    </div>
  );
}
