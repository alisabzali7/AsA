/**
 * Psychology engine — a real, explainable engine (master §59), not a page.
 * Every section reports what was MEASURED (TTT), what is DERIVED (labeled,
 * with derivation source) and what is UNAVAILABLE with a reason. Null is
 * never converted to zero and unverified semantics never become "pressure".
 */
import { sharedStore } from "../market/store";
import { operationalUniverse } from "../market/operational-universe";
import type { MetricTruth, AppState } from "../domain/types";

export interface PsychSection {
  key: string;
  label: string;
  state: AppState;
  verdict: string; // MEASURED | DERIVED | PROXY | UNVERIFIED | UNAVAILABLE
  value?: number | string | null;
  evidence: string[];
  reason?: string;
}

export interface PsychologySummary {
  symbol: string;
  generated_at_ms: number;
  bias: "neutral";
  bias_reason: string;
  sections: PsychSection[];
  universe_funding: {
    measured: number;
    total: number;
    mean: number | null;
    max_abs: number | null;
    timestamp_ms: number | null;
  };
}

export function buildPsychology(symbol: string): PsychologySummary {
  const stats = sharedStore.getStats(symbol);
  const now = Date.now();
  const sections: PsychSection[] = [];

  // 1) funding (measured via stats sweep)
  const funding = stats?.fundingRate ?? null;
  sections.push({
    key: "funding",
    label: "Funding rate",
    state: funding === null ? "UNAVAILABLE" : "LIVE",
    verdict: funding === null ? "UNAVAILABLE" : "MEASURED",
    value: funding,
    evidence: funding === null ? [] : [`fundingRate=${funding} from /futures/markets/stats`, `interval=${stats?.fundingIntervalHours}h`, `next at ${stats?.nextFundingTimeMs ? new Date(stats.nextFundingTimeMs).toISOString() : "?"}`],
    reason: funding === null ? "no stats measurement" : undefined,
  });

  // 2) OI level + AsA-derived OI direction (snapshot ring)
  const oi = stats?.openInterest ?? null;
  const ring = oiRings.get(symbol) ?? [];
  const oiDelta = deriveOiDelta(ring);
  sections.push({
    key: "open_interest",
    label: "Open interest",
    state: oi === null ? "UNAVAILABLE" : "LIVE",
    verdict: oi === null ? "UNAVAILABLE" : "MEASURED",
    value: oi,
    evidence: oi === null ? [] : [`openInterest=${oi} (base units, upstream naming) via stats`],
    reason: oi === null ? "no stats measurement" : undefined,
  });
  if (oiDelta) {
    sections.push({
      key: "oi_direction",
      label: "OI Δ (AsA snapshot ring)",
      state: "LIVE",
      verdict: "DERIVED",
      value: oiDelta.percent,
      evidence: [`window ${oiDelta.spanMin}m`, `ring size ${ring.length}`, "derived from AsA-side stats snapshots, not an upstream metric"],
    });
  } else {
    sections.push({
      key: "oi_direction",
      label: "OI Δ (AsA snapshot ring)",
      state: "INSUFFICIENT_DATA",
      verdict: "UNAVAILABLE",
      value: null,
      evidence: [],
      reason: "need ≥2 OI snapshots separated in time (collecting each stats sweep)",
    });
  }

  // 3) crowding/exhaustion proxies only from MEASURED funding facts
  sections.push({
    key: "crowding",
    label: "Crowding proxy",
    state: funding === null ? "INSUFFICIENT_DATA" : "LIVE",
    verdict: funding === null ? "UNAVAILABLE" : "DERIVED",
    value: funding === null ? null : Math.abs(funding) > 0.0001 ? "extreme band" : Math.abs(funding) > 0.00005 ? "elevated" : "mild",
    evidence: funding === null ? [] : ["crowding proxy = |funding rate| thresholds; PROXY only — not a calibrated crowd gauge"],
    reason: funding === null ? "funding not measured" : "PROXY semantics, labeled as such",
  });

  // 4) liquidation pressure — never fabricated
  sections.push({
    key: "liquidation_pressure",
    label: "Liquidation pressure",
    state: "UNAVAILABLE",
    verdict: "UNAVAILABLE",
    value: null,
    evidence: [],
    reason: "no documented public TTT liquidation endpoint; not estimated from unverified data",
  });

  // 5) directional/flow pressure from tape — side semantics unverified
  const tape = sharedStore.tape;
  sections.push({
    key: "tape_flow",
    label: "Tape flow",
    state: tape.length ? "LIVE" : "INSUFFICIENT_DATA",
    verdict: "UNVERIFIED",
    value: tape.length,
    evidence: ["trade prints carry side=ASK|BID but taker-aggressor semantics are NOT documented by TTT", "no buy/sell volume, CVD or imbalance computed from them"],
    reason: tape.length ? "side semantics UNVERIFIED — no flow conclusion drawn" : "no tape for this symbol (focus lane only)",
  });

  // 6) spread/book (measured, focus symbol)
  const book = sharedStore.orderBook;
  if (book && book.symbol === symbol) {
    sections.push({
      key: "book",
      label: "Orderbook spread",
      state: "LIVE",
      verdict: "MEASURED",
      value: book.spreadPct !== null ? book.spreadPct : null,
      evidence: [`bids=${book.bids.length} asks=${book.asks.length}`, `spreadPct=${book.spreadPct}`],
    });
  } else {
    sections.push({
      key: "book",
      label: "Orderbook spread",
      state: "INSUFFICIENT_DATA",
      verdict: "UNAVAILABLE",
      value: null,
      evidence: [],
      reason: "orderbook measured only for the focused symbol",
    });
  }

  // 7) liquidation INSIDE stop estimation handled by risk engine (ESTIMATE-labeled), not psychology

  // universe funding stack
  const measured = operationalUniverse().map((u) => sharedStore.getStats(u)?.fundingRate ?? null).filter((v): v is number => v !== null);
  let maxAbs: number | null = null;
  let mean: number | null = null;
  if (measured.length) {
    mean = measured.reduce((a, b) => a + b, 0) / measured.length;
    maxAbs = Math.max(...measured.map((v) => Math.abs(v)));
  }

  const bias: "neutral" = "neutral";
  const bias_reason =
    "No directional bias is asserted: (a) liquidation pressure is unavailable, (b) tape-side semantics are unverified, (c) funding/OI alone are context, not a bias signal.";

  return {
    symbol,
    generated_at_ms: now,
    bias,
    bias_reason,
    sections,
    universe_funding: {
      measured: measured.length,
      total: operationalUniverse().length,
      mean,
      max_abs: maxAbs,
      timestamp_ms: sharedStore.lastStatsSweepAtMs,
    },
  };
}

/** OI snapshot ring per symbol (engine appends every stats sweep). */
export const oiRings = new Map<string, { ts: number; oi: number }[]>();

export function recordOiSnapshot(symbol: string, oi: number): void {
  if (!Number.isFinite(oi)) return;
  let ring = oiRings.get(symbol);
  if (!ring) {
    ring = [];
    oiRings.set(symbol, ring);
  }
  ring.push({ ts: Date.now(), oi });
  if (ring.length > 240) ring.splice(0, ring.length - 240); // ~28 min at 7s sweeps… cap 240
}

function deriveOiDelta(ring: { ts: number; oi: number }[]): { percent: number; spanMin: number } | null {
  if (ring.length < 2) return null;
  const newest = ring[ring.length - 1];
  // find oldest sample ≥10 min old if available else oldest
  const cutoff = newest.ts - 10 * 60_000;
  let ref = ring.find((r) => r.ts <= cutoff);
  if (!ref) ref = ring[0];
  if (ref === newest) return null;
  if (ref.oi === 0) return null;
  const percent = ((newest.oi - ref.oi) / ref.oi) * 100;
  return { percent, spanMin: Math.round((newest.ts - ref.ts) / 60_000) };
}

export type { MetricTruth };
