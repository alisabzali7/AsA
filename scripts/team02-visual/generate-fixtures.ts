/**
 * TEAM 02 visual-verification fixtures (Task 10).
 *
 * Live TTT is unreachable from the verification sandbox (TLS reset), so the
 * populated browser scenarios are driven by payloads computed HERE with the
 * REAL server code path of each route:
 *
 *   /api/market/candles        prepareAnalysisInput (closed_count, forming flag, freshness)
 *   /api/analysis/{sym}/{tf}   prepareAnalysisInput → buildArtifactsFromInput → buildChartOverlay
 *   /api/analysis/mtf/{sym}    buildMtfAsOf (4h/1h/15m)
 *
 * The candles are deterministic SYNTHETIC SHAPES (seeded PRNG), under symbol
 * names that cannot be mistaken for venue instruments (FIXTURE*). Nothing here
 * is market data; every payload is labelled source="fixture". There is no
 * production fixture mode — the Playwright driver serves these files only via
 * network interception in the test browser.
 *
 * Run: /tmp/pw/node_modules/.bin/tsx scripts/team02-visual/generate-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Candle, CandleSeries } from "../../src/lib/domain/types";
import { prepareAnalysisInput } from "../../src/lib/analysis/input";
import { buildArtifactsFromInput } from "../../src/lib/analysis/bundle";
import { buildChartOverlay } from "../../src/lib/chart/technical";
import { buildMtfAsOf } from "../../src/lib/analysis/mtf";
import { aggregateClosed } from "../../src/lib/analysis/aggregate";
import { inputErrorClass, insufficientHistory } from "../../src/lib/analysis/errors";

const OUT = path.resolve(__dirname, "../../FINAL_ARTIFACTS/visual/fixtures");
/** fixed fixture clock: 2026-09-26 04:37:00 UTC (inside a forming 15m/1h/4h bar) */
export const NOW_MS = Date.UTC(2026, 8, 26, 4, 37, 0);
const NOW_S = NOW_MS / 1000;
const LIMIT = 700; // the chart's INITIAL_VIEWPORT_BARS for non-1m timeframes

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shape { seed: number; base: number; vol: number; swing: number; impulses: boolean; bars: number }

/** synthetic 15m series ending with the FORMING bar at NOW (as a venue returns it) */
function synth15m(s: Shape): Candle[] {
  const rnd = mulberry32(s.seed);
  const step = 900;
  const formingOpen = Math.floor(NOW_S / step) * step;
  const t0 = formingOpen - (s.bars - 1) * step;
  const out: Candle[] = [];
  let p = s.base;
  for (let i = 0; i < s.bars; i++) {
    const cyc = s.swing * (Math.sin((2 * Math.PI * i) / 97) + 0.6 * Math.sin((2 * Math.PI * i) / 263) + 0.35 * Math.sin((2 * Math.PI * i) / 41));
    let drift = (rnd() - 0.5) * s.vol;
    if (s.impulses && i % 173 === 57) drift += (rnd() > 0.5 ? 1 : -1) * s.vol * 9; // displacement → FVG/OB shapes
    const prevTarget = p;
    p = Math.max(s.base * 0.2, p * (1 + drift) + s.base * (cyc - (out.length ? 0 : cyc)) * 0.002);
    const o = out.length ? out[out.length - 1].c : prevTarget;
    const c = p;
    const w = Math.abs(c) * s.vol * (0.3 + rnd() * 0.7);
    const isForming = i === s.bars - 1;
    const elapsed = isForming ? (NOW_S - formingOpen) / step : 1;
    out.push({ t: t0 + i * step, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: Math.round((500 + rnd() * 1500) * (isForming ? elapsed : 1) * (s.impulses && i % 173 === 57 ? 4 : 1)) });
  }
  return out;
}

/** HTF venue-like series: complete buckets (real aggregateClosed) + the forming bucket */
function htf(base15: Candle[], minutes: number): Candle[] {
  const step = minutes * 60;
  const closed = aggregateClosed(base15, minutes);
  const formingOpen = Math.floor(NOW_S / step) * step;
  const part = base15.filter((c) => c.t >= formingOpen);
  if (part.length) {
    closed.push({ t: formingOpen, o: part[0].o, h: Math.max(...part.map((c) => c.h)), l: Math.min(...part.map((c) => c.l)), c: part[part.length - 1].c, v: part.reduce((a, c) => a + c.v, 0) });
  }
  return closed.filter((c) => c.t <= formingOpen);
}

function seriesOf(symbol: string, tf: string, candles: Candle[]): CandleSeries {
  return { symbol, timeframe: tf, candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_MS };
}

const SHAPES: Record<string, Shape> = {
  FIXTUREA: { seed: 11, base: 64000, vol: 0.0018, swing: 1.0, impulses: false, bars: 5000 },
  FIXTUREB: { seed: 29, base: 2500, vol: 0.0035, swing: 2.2, impulses: true, bars: 5000 },
  FIXTUREC: { seed: 47, base: 140, vol: 0.002, swing: 1.0, impulses: false, bars: 15 }, // insufficient history
  FIXTURESUB: { seed: 83, base: 0.00001234, vol: 0.004, swing: 1.4, impulses: true, bars: 5000 },
};
const TFS: Record<string, number> = { "15m": 15, "1h": 60, "4h": 240 };

mkdirSync(OUT, { recursive: true });
const manifest: Record<string, unknown> = {
  kind: "TEAM02_VISUAL_FIXTURES", not_market_data: true, generated_by: "scripts/team02-visual/generate-fixtures.ts",
  clock_ms: NOW_MS, clock_utc: new Date(NOW_MS).toISOString(), symbols: {} as Record<string, unknown>,
};

for (const [symbol, shape] of Object.entries(SHAPES)) {
  const base = synth15m(shape);
  const byTf: Record<string, Candle[]> = { "15m": base, "1h": htf(base, 60), "4h": htf(base, 240) };
  const symInfo: Record<string, unknown> = {};
  for (const [tf] of Object.entries(TFS)) {
    const full = byTf[tf];
    const window = full.slice(-LIMIT);
    const series = seriesOf(symbol, tf, window);
    const input = prepareAnalysisInput(symbol, tf, series, NOW_MS);
    // /api/market/candles response shape (route.ts), source labelled fixture
    const candlesBody = {
      ok: true, symbol, timeframe: tf, bars: window.length, closed_count: input.closed_bars,
      last_bar_forming: input.forming_bar_excluded, source_ts_ms: input.source_ts_ms, data_age_ms: input.data_age_ms,
      freshness: input.freshness, candles: window, native: true, provenance: "FIXTURE", derived_source_tf: null,
      source: "fixture", endpoint: "fixture (network interception; not live)", fetched_at_ms: NOW_MS, age_ms: 0,
      coverage: null, forming_price: window[window.length - 1].c, target_bars: LIMIT, tf_label: tf, ts: NOW_MS,
    };
    // /api/analysis/{symbol}/{tf} response shape (route.ts)
    const art = buildArtifactsFromInput(input, undefined, NOW_MS);
    const meta = {
      closed_bars: input.closed_bars, freshness: input.freshness, source_ts_ms: input.source_ts_ms,
      data_age_ms: input.data_age_ms, forming_bar_excluded: input.forming_bar_excluded,
      native: input.native, derived_source_tf: input.derived_source_tf ?? null, reason: input.reason ?? null,
      reason_code: input.reason_code, last_closed_open_ts: input.last_closed_open_ts,
    };
    let analysisBody: Record<string, unknown>;
    if (!art) {
      analysisBody = { ok: true, available: false, error_class: inputErrorClass(input, null), reason: input.reason ?? "no closed candles available yet (backfill in progress)", input: meta };
    } else {
      const warm = insufficientHistory(art.bundle);
      analysisBody = { ok: true, available: true, error_class: warm.length ? "INSUFFICIENT_HISTORY" : null, insufficient_history: warm, bundle: art.bundle, overlay: buildChartOverlay(art.bundle, art.series), input: meta };
    }
    writeFileSync(path.join(OUT, `${symbol}_${tf}_candles.json`), JSON.stringify(candlesBody));
    writeFileSync(path.join(OUT, `${symbol}_${tf}_analysis.json`), JSON.stringify(analysisBody));
    const ov = (analysisBody.overlay ?? null) as ReturnType<typeof buildChartOverlay>;
    symInfo[tf] = {
      bars: window.length, closed: input.closed_bars, forming_excluded: input.forming_bar_excluded,
      as_of_t: art?.bundle.as_of_t ?? null, knowable_at_ms: input.source_ts_ms,
      input_fingerprint: art?.bundle.provenance.input_fingerprint ?? null, error_class: analysisBody.error_class ?? null,
      insufficient_history: analysisBody.insufficient_history ?? null,
      overlay: ov ? { lines: ov.lines.length, zones: ov.zones.length, markers: ov.markers.length, series: ov.series.map((s) => `${s.id}:${s.points.length}`), omitted: ov.omitted } : null,
      trend: art?.bundle.structure.trend ?? null,
    };
  }
  // /api/analysis/mtf/{symbol} (route.ts) from the same windows
  const { mtf, parts } = buildMtfAsOf(symbol, {
    macro: seriesOf(symbol, "4h", byTf["4h"].slice(-LIMIT)),
    context: seriesOf(symbol, "1h", byTf["1h"].slice(-LIMIT)),
    trigger: seriesOf(symbol, "15m", byTf["15m"].slice(-LIMIT)),
  }, NOW_MS);
  const inputs = parts.map((p) => ({ role: p.role, timeframe: p.timeframe, closed_bars: p.input.closed_bars, freshness: p.input.freshness, reason: p.input.reason ?? null, reason_code: p.input.reason_code, error_class: inputErrorClass(p.input, null), last_closed_open_ts: p.input.last_closed_open_ts }));
  writeFileSync(path.join(OUT, `${symbol}_mtf.json`), JSON.stringify({ ok: true, symbol, mtf, inputs }));
  symInfo.mtf = { verdict: mtf.verdict, components: mtf.components.map((c) => ({ role: c.role, state: c.state, fp: c.input_fingerprint })) };
  (manifest.symbols as Record<string, unknown>)[symbol] = symInfo;
}
writeFileSync(path.join(OUT, "symbols.json"), JSON.stringify({ ok: true, symbols: Object.keys(SHAPES), count: Object.keys(SHAPES).length, source: "fixture", state: "FIXTURE", discovery_complete: true }));
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 1).slice(0, 6000));
