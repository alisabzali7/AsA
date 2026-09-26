/**
 * TEAM 01 / TASK 03 — market truth → normalization → freshness → MTF →
 * analysis pipeline regressions.
 *
 * Every block pins a VERIFIED pre-fix defect (reproduced before the fix):
 *  A. parseUdfHistory turned an all-null row into a zero-price candle
 *     (Number(null) === 0) and accepted bars far in the future / misaligned.
 *  B. analysis consumed the venue's still-FORMING bar as a closed bar.
 *  C. freshness was retrieval age; a stats row with a week-old venue timestamp
 *     was LIVE, and the client upgraded server STALE to LIVE.
 *  D. MTF said ALIGNED with a stale component / mixed symbols; nulls were
 *     reported INSUFFICIENT instead of UNAVAILABLE.
 *  E. an empty/all-invalid venue answer overwrote a good working series.
 *  F. scanSymbol evaluated strategies on the forming bar.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-truth-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");

import { parseUdfHistory } from "../src/lib/ttt/udf";
import { closedOnly, freshnessOf, prepareAnalysisInput, STALE_BARS } from "../src/lib/analysis/input";
import { buildBundle, buildBundleFromInput } from "../src/lib/analysis/bundle";
import { buildMtf } from "../src/lib/analysis/mtf";
import { statsRowState, STATS_SOURCE_STALE_MS } from "../src/lib/market/store";
import { displayStateFor } from "../src/components/board-selectors";
import type { Candle, CandleSeries } from "../src/lib/domain/types";

const H = 3600;
const M15 = 900;
const H4 = 4 * H;

function bars(n: number, step: number, lastOpen: number, trend = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * trend + (i % 3) * 0.1;
    const o = c - trend * 0.5;
    return { t: lastOpen - (n - 1 - i) * step, o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: 10 + i };
  });
}
// Zig-zag with midpoint opens: real swing pivots (Team 02: trend requires a
// confirmed HH/HL or LH/LL swing sequence; a monotonic ramp is "undetermined").
function zbars(n: number, step: number, lastOpen: number, trend = 0): Candle[] {
  const closes = Array.from({ length: n }, (_, i) => 200 + i * trend + 6 * Math.sin((2 * Math.PI * i) / 10));
  return closes.map((c, i) => {
    const o = i > 0 ? (closes[i - 1] + c) / 2 : c;
    return { t: lastOpen - (n - 1 - i) * step, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 10 + i };
  });
}
function series(symbol: string, tf: string, candles: Candle[], native = true): CandleSeries {
  return { symbol, timeframe: tf, candles, native, derived_source_tf: native ? undefined : "8h", source: "ttt", fetched_at_ms: Date.now() };
}

afterEach(() => vi.restoreAllMocks());

// ------------------------------------------------------------------ A
describe("A. UDF normalization — strict, no fake values", () => {
  const NOW = 1_800_000_000_000; // fixed clock
  const nowSec = NOW / 1000;
  const cur = Math.floor(nowSec / M15) * M15;

  it("an all-null row is rejected, never a zero-price candle", () => {
    const r = parseUdfHistory({ s: "ok", t: [cur - M15], o: [null], h: [null], l: [null], c: [null], v: [null] }, 15, NOW);
    expect(r.candles).toEqual([]);
    expect(r.meta.dropped_invalid).toBe(1);
  });

  it("empty strings / booleans are not numbers; zero and negative prices are corrupt", () => {
    const t = [cur - 4 * M15, cur - 3 * M15, cur - 2 * M15, cur - M15];
    const r = parseUdfHistory({ s: "ok", t, o: ["1", 0, "1", "1"], h: ["2", 1, "2", "2"], l: ["0.5", 0, "-1", "0.5"], c: ["", 0.5, "1", "1.5"], v: [true, 1, 1, "3"] }, 15, NOW);
    expect(r.candles.map((c) => c.t)).toEqual([cur - M15]); // ONE valid row among invalid neighbours
    expect(r.meta.dropped_invalid).toBe(3);
  });

  it("a volume of exactly 0 is a legitimate measurement (quiet bar), not missing", () => {
    const r = parseUdfHistory({ s: "ok", t: [cur - M15], o: [1], h: [2], l: [0.5], c: [1], v: [0] }, 15, NOW);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0].v).toBe(0);
  });

  it("misaligned timestamps are not bars of this timeframe", () => {
    const r = parseUdfHistory({ s: "ok", t: [cur - M15 + 1], o: [1], h: [2], l: [0.5], c: [1], v: [1] }, 15, NOW);
    expect(r.candles).toEqual([]);
  });

  it("the current forming bar is allowed; a bar opening after it is future and dropped", () => {
    const r = parseUdfHistory({ s: "ok", t: [cur, cur + M15], o: [1, 1], h: [2, 2], l: [0.5, 0.5], c: [1, 1], v: [1, 1] }, 15, NOW);
    expect(r.candles.map((c) => c.t)).toEqual([cur]);
    expect(r.meta.dropped_future).toBe(1);
  });

  it("valid metadata with empty arrays stays an empty (not failed, not no_data) parse", () => {
    const r = parseUdfHistory({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] }, 15, NOW);
    expect(r.meta.ok).toBe(true);
    expect(r.meta.no_data).toBe(false);
    expect(r.candles).toEqual([]);
  });

  it("normalization is idempotent on already-normalized data", () => {
    const raw = { s: "ok", t: [cur - 2 * M15, cur - M15, cur - M15], o: [1, 1, 2], h: [2, 2, 3], l: [0.5, 0.5, 1], c: [1, 1.5, 2.5], v: [1, 1, 2] };
    const a = parseUdfHistory(raw, 15, NOW).candles;
    const b = parseUdfHistory({ s: "ok", t: a.map((x) => x.t), o: a.map((x) => x.o), h: a.map((x) => x.h), l: a.map((x) => x.l), c: a.map((x) => x.c), v: a.map((x) => x.v) }, 15, NOW).candles;
    expect(b).toEqual(a);
    expect(a[a.length - 1].c).toBe(2.5); // duplicate final ts: last wins
  });
});

// ------------------------------------------------------------------ B
describe("B. closed-bar semantics at UTC boundaries", () => {
  const open = 1_800_000_000 - (1_800_000_000 % H); // an hourly open
  const cs = bars(3, H, open);

  it("a bar is closed exactly at open+period, not one second before", () => {
    expect(closedOnly(cs, "1h", (open + H - 1) * 1000).closed.map((c) => c.t)).toEqual([open - 2 * H, open - H]);
    expect(closedOnly(cs, "1h", (open + H) * 1000).closed.map((c) => c.t)).toEqual([open - 2 * H, open - H, open]);
    expect(closedOnly(cs, "1h", (open + H + 1) * 1000).excluded).toBe(0);
  });

  it("the daily bar closes at the next UTC midnight", () => {
    const day = 86400 * 20000; // a UTC midnight
    const d = [{ t: day - 86400, o: 1, h: 2, l: 0.5, c: 1, v: 1 }, { t: day, o: 1, h: 2, l: 0.5, c: 1, v: 1 }];
    expect(closedOnly(d, "1d", (day + 86399) * 1000).closed).toHaveLength(1);
    expect(closedOnly(d, "1d", (day + 86400) * 1000).closed).toHaveLength(2);
  });

  it("unsupported timeframe yields no closed bars (never a guessed period)", () => {
    expect(closedOnly(cs, "3h", Date.now()).closed).toEqual([]);
  });
});

// ------------------------------------------------------------------ C
describe("C. freshness is SOURCE age, not retrieval age", () => {
  it("fresh / borderline / barely stale / missing", () => {
    const now = 1_800_000_000_000;
    const budget = STALE_BARS * H * 1000;
    expect(freshnessOf(now - budget, "1h", now).freshness).toBe("FRESH");
    expect(freshnessOf(now - budget - 1, "1h", now).freshness).toBe("STALE");
    expect(freshnessOf(null, "1h", now).freshness).toBe("UNAVAILABLE");
  });

  it("a series fetched a millisecond ago whose last closed bar is old is STALE", () => {
    const now = Date.now();
    const oldOpen = Math.floor(now / 1000 / H) * H - 30 * H;
    const input = prepareAnalysisInput("BTCUSDT", "1h", series("BTCUSDT", "1h", bars(80, H, oldOpen)), now);
    expect(input.freshness).toBe("STALE");
    expect(input.source_ts_ms).toBe((oldOpen + H) * 1000);
  });

  it("stats: successful recent fetch + frozen venue row timestamp = STALE", () => {
    const now = 1_800_000_000_000;
    const frozen = statsRowState({ provenance: { fetched_at_ms: now - 1000, source_ts_ms: now - STATS_SOURCE_STALE_MS - 1 } }, now);
    expect(frozen.state).toBe("STALE");
    expect(frozen.reason).toMatch(/source not updating/);
    expect(statsRowState({ provenance: { fetched_at_ms: now - 1000, source_ts_ms: now - 5000 } }, now).state).toBe("LIVE");
    expect(statsRowState({ provenance: { fetched_at_ms: now - 60_000 } }, now).state).toBe("STALE");
  });

  it("the client never upgrades a server STALE to LIVE", () => {
    expect(displayStateFor("STALE", 1_000)).toBe("STALE");
    expect(displayStateFor("LIVE", 1_000)).toBe("LIVE");
    expect(displayStateFor("LIVE", 120_000)).toBe("STALE"); // downgrade still works
    expect(displayStateFor("CONNECTING", 1_000)).toBe("CONNECTING");
  });
});

// ------------------------------------------------------------------ D/E analysis input + MTF
describe("D. analysis input contract + evidence-based MTF", () => {
  const now = Date.now();
  const cur = (step: number) => Math.floor(now / 1000 / step) * step; // forming bar open

  const mk = (sym: string, tf: string, step: number, trend: number, lastOpen = cur(step)) =>
    buildBundleFromInput(prepareAnalysisInput(sym, tf, series(sym, tf, zbars(120, step, lastOpen, trend * 0.4)), now));

  it("the forming bar is excluded and the bundle carries source timestamp/freshness", () => {
    const input = prepareAnalysisInput("BTCUSDT", "1h", series("BTCUSDT", "1h", bars(120, H, cur(H))), now);
    expect(input.forming_bar_excluded).toBe(true);
    expect(input.closed_bars).toBe(119);
    expect(input.last_closed_open_ts).toBe(cur(H) - H);
    const b = buildBundleFromInput(input)!;
    expect(b.bars).toBe(119);
    expect(b.provenance.freshness).toBe("FRESH");
    expect(b.provenance.source_ts_ms).toBe(cur(H) * 1000);
    expect(b.provenance.closed_bars_only).toBe(true);
  });

  it("a series of another symbol/timeframe is refused (no cross-series contamination)", () => {
    const wrongSym = prepareAnalysisInput("ETHUSDT", "1h", series("BTCUSDT", "1h", bars(120, H, cur(H))), now);
    expect(wrongSym.closed_bars).toBe(0);
    expect(wrongSym.reason).toMatch(/identity mismatch/);
    expect(buildBundleFromInput(wrongSym)).toBeNull();
    expect(prepareAnalysisInput("BTCUSDT", "4h", series("BTCUSDT", "1h", bars(120, H, cur(H))), now).closed_bars).toBe(0);
  });

  it("empty input is NOT a valid analysis (no empty-but-valid bundle)", () => {
    expect(buildBundleFromInput(prepareAnalysisInput("BTCUSDT", "1h", null, now))).toBeNull();
  });

  it("ALIGNED only with fresh, sufficient, same-symbol components", () => {
    const m = buildMtf(mk("BTCUSDT", "4h", H4, 2), mk("BTCUSDT", "1h", H, 2), mk("BTCUSDT", "15m", M15, 2));
    expect(m.verdict).toBe("ALIGNED");
    expect(m.freshness_verified).toBe(true);
    expect(m.symbol).toBe("BTCUSDT");
    expect(m.oldest_source_ts_ms).not.toBeNull();
  });

  it("4H fresh + 1H stale + 15M fresh → STALE, never ALIGNED", () => {
    const staleH1 = mk("BTCUSDT", "1h", H, 2, cur(H) - 48 * H);
    const m = buildMtf(mk("BTCUSDT", "4h", H4, 2), staleH1, mk("BTCUSDT", "15m", M15, 2));
    expect(m.verdict).toBe("STALE");
    expect(m.context_bias).toBeNull();
    expect(m.components.find((c) => c.role === "context")!.state).toBe("STALE");
  });

  it("4H unavailable with lower TFs available → UNAVAILABLE", () => {
    const m = buildMtf(null, mk("BTCUSDT", "1h", H, 2), mk("BTCUSDT", "15m", M15, 2));
    expect(m.verdict).toBe("UNAVAILABLE");
    expect(m.reason).toMatch(/macro/);
  });

  it("one component with insufficient history → INSUFFICIENT (precedes STALE)", () => {
    const short = buildBundleFromInput(prepareAnalysisInput("BTCUSDT", "15m", series("BTCUSDT", "15m", bars(30, M15, cur(M15))), now));
    const staleH1 = mk("BTCUSDT", "1h", H, 2, cur(H) - 48 * H);
    expect(buildMtf(mk("BTCUSDT", "4h", H4, 2), staleH1, short).verdict).toBe("INSUFFICIENT");
  });

  it("a component left over from another symbol → UNAVAILABLE (cross-symbol refusal)", () => {
    const m = buildMtf(mk("ETHUSDT", "4h", H4, 2), mk("BTCUSDT", "1h", H, 2), mk("BTCUSDT", "15m", M15, 2));
    expect(m.verdict).toBe("UNAVAILABLE");
    expect(m.reason).toMatch(/different symbols/);
  });

  it("fresh data with conflicting structure stays CONFLICT/PARTIAL (freshness never forces alignment)", () => {
    const m = buildMtf(mk("BTCUSDT", "4h", H4, 2), mk("BTCUSDT", "1h", H, -2), mk("BTCUSDT", "15m", M15, 2));
    expect(["CONFLICT", "PARTIAL"]).toContain(m.verdict);
    expect(m.verdict).not.toBe("ALIGNED");
  });

  it("derived higher timeframe is labelled, never passed off as native", () => {
    const derived = buildBundleFromInput(prepareAnalysisInput("BTCUSDT", "4h", series("BTCUSDT", "4h", bars(120, H4, cur(H4), 2), false), now));
    const m = buildMtf(derived, mk("BTCUSDT", "1h", H, 2), mk("BTCUSDT", "15m", M15, 2));
    expect(m.derived_components).toEqual(["macro"]);
    expect(m.reason).toMatch(/derived/);
    expect(m.components[0].native).toBe(false);
  });

  it("legacy bundles without source freshness never claim verified freshness", () => {
    const leg = (tf: string, step: number) => buildBundle({ symbol: "BTCUSDT", timeframe: tf, candles: zbars(80, step, 1_700_000_000, 0.8) });
    const b = leg("1h", H);
    expect(b.provenance.freshness).toBe("UNAVAILABLE");
    // roles must carry their contract timeframes (4h/1h/15m) or the MTF refuses with MISMATCH
    const m = buildMtf(leg("4h", H4), b, leg("15m", M15));
    expect(m.freshness_verified).toBe(false);
    expect(m.reason).toMatch(/NOT VERIFIED/);
  });
});

// ------------------------------------------------------------------ E
describe("E. an empty / all-invalid venue answer never replaces good data", () => {
  it("CandleManager keeps the prior series and surfaces the failure", async () => {
    const { tttClient } = await import("../src/lib/ttt/client");
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    const store = new MarketStore();
    const good = series("BTCUSDT", "1h", bars(100, H, Math.floor(Date.now() / 1000 / H) * H));
    store.putSeries(good);
    vi.spyOn(tttClient, "getUdfHistory").mockResolvedValue({
      series: { ...series("BTCUSDT", "60", []) }, fetched_at_ms: Date.now(), no_data: false,
    });
    const mgr = new CandleManager(store);
    await expect(mgr.fetch("BTCUSDT", "1h")).rejects.toThrow(/zero usable candles/);
    expect(store.getSeries("BTCUSDT", "1h")).toBe(good);
  });

  it("the client refuses a payload whose every row fails normalization", async () => {
    const http = await import("../src/lib/ttt/http");
    const { tttClient } = await import("../src/lib/ttt/client");
    vi.spyOn(http, "tttRequest").mockResolvedValue({
      data: { s: "ok", t: [3600], o: [0], h: [0], l: [0], c: [0], v: [0] }, fetched_at_ms: Date.now(), latency_ms: 1,
    } as never);
    await expect(tttClient.getUdfHistory({ symbol: "BTCUSDT", resolution: "60", fromSec: 0, toSec: 7200, tfMinutes: 60 }))
      .rejects.toThrow(/rejected by normalization/);
  });
});

// ------------------------------------------------------------------ F
describe("F. scanSymbol evaluates CLOSED bars only", () => {
  it("the strategy never sees the forming bar; anchor = last closed bar", async () => {
    const { candleManager } = await import("../src/lib/market/candles");
    const { scanSymbol } = await import("../src/lib/pipeline/orchestrator");
    const { executableStrategies } = await import("../src/lib/strategy/runtime");
    const base = executableStrategies().find((s) => s.timeframe === "1h") ?? executableStrategies()[0];
    expect(base, "at least one executable strategy exists").toBeTruthy();
    const tf = base.timeframe;
    const step = tf === "1d" ? 86400 : tf === "4h" ? H4 : tf === "15m" ? M15 : H;
    const forming = Math.floor(Date.now() / 1000 / step) * step;
    const seen: number[] = [];
    const strategy = {
      ...base,
      impl: { ...base.impl!, build: (c: Candle[], t: string) => { seen.push(c[c.length - 1].t, c.length); return base.impl!.build(c, t); } },
    };
    const n = Math.max(base.min_bars + 5, 150);
    vi.spyOn(candleManager, "ensureSeries").mockResolvedValue(series("BTCUSDT", tf, bars(n, step, forming, 0.5)));
    await scanSymbol("BTCUSDT", strategy, "research", { forceRefresh: false });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(forming - step); // last CLOSED bar, not the forming one
    expect(seen[1]).toBe(n - 1);
  });

  it("insufficient CLOSED history is reported with the closed count", async () => {
    const { candleManager } = await import("../src/lib/market/candles");
    const { scanSymbol } = await import("../src/lib/pipeline/orchestrator");
    const { executableStrategies } = await import("../src/lib/strategy/runtime");
    const base = executableStrategies()[0];
    const step = base.timeframe === "1d" ? 86400 : base.timeframe === "4h" ? H4 : base.timeframe === "15m" ? M15 : H;
    const forming = Math.floor(Date.now() / 1000 / step) * step;
    // exactly min_bars INCLUDING the forming bar = min_bars-1 closed → refused
    vi.spyOn(candleManager, "ensureSeries").mockResolvedValue(series("BTCUSDT", base.timeframe, bars(base.min_bars, step, forming)));
    const out = await scanSymbol("BTCUSDT", base, "research", { forceRefresh: false });
    expect(out.evaluated).toBe(false);
    expect(out.reason).toMatch(new RegExp(`have ${base.min_bars - 1}`));
  });
});
