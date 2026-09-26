/**
 * Strategy regression harness (Task 09). Deterministic synthetic series (no
 * market claims — shapes only) evaluated through EVERY compiled strategy at
 * EVERY decision bar with a fixed clock. The digest excludes version strings
 * so only semantic outputs (pass/fail, feature values, levels, rr) compare.
 * Used by tests/team09-strategy-regression.test.ts against the baseline
 * captured BEFORE the Task 09 detector repairs.
 */
import type { Candle } from "../../../src/lib/domain/types";
import { COMPILED_STRATEGIES, evaluateCompiled } from "../../../src/lib/strategy/compiled";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function mk(closes: number[], step = 900, t0 = 1_700_000_100 - (1_700_000_100 % 900), volSeed = 7): Candle[] {
  const r = lcg(volSeed);
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] + c) / 2;
    const w = Math.abs(c) * 0.004 * (0.5 + r());
    return { t: t0 + i * step, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: 100 + Math.floor(r() * 900) };
  });
}

export function regressionSeries(): Record<string, Candle[]> {
  const n = 320;
  const r1 = lcg(42);
  let p = 100;
  const walk = Array.from({ length: n }, () => (p = p * (1 + (r1() - 0.5) * 0.02)));
  const sine = Array.from({ length: n }, (_, i) => 100 + 8 * Math.sin((2 * Math.PI * i) / 23) + i * 0.03);
  const crash = Array.from({ length: n }, (_, i) => (i < 150 ? 100 + i * 0.1 : i < 180 ? 115 - (i - 150) * 1.2 : 79 + (i - 180) * 0.15 + 3 * Math.sin(i / 3)));
  const r2 = lcg(9);
  const spiky = Array.from({ length: n }, (_, i) => 50 + 2 * Math.sin(i / 5) + (i % 37 === 0 ? 6 : 0) + (r2() - 0.5));
  return { walk: mk(walk), sine: mk(sine), crash: mk(crash), spiky: mk(spiky) };
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (/version/i.test(k)) continue;
      o[k] = strip((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return v;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const REGRESSION_NOW_MS = 1_800_000_000_000;

/** series → strategy → { passes, digest } */
export function strategyRegression(): Record<string, Record<string, { evaluated: number; passes: number; digest: string }>> {
  const out: Record<string, Record<string, { evaluated: number; passes: number; digest: string }>> = {};
  for (const [name, candles] of Object.entries(regressionSeries())) {
    out[name] = {};
    for (const strat of COMPILED_STRATEGIES) {
      let passes = 0, evaluated = 0, acc = "";
      for (let i = Math.max(strat.min_bars, 1) - 1; i < candles.length; i++) {
        const ev = evaluateCompiled(strat, "REGUSDT", candles.slice(0, i + 1), REGRESSION_NOW_MS);
        evaluated++;
        if (ev.setup.outcome === "PASS") passes++;
        acc = fnv(acc + JSON.stringify(strip(ev)));
      }
      out[name][`${strat.strategy_id}/${strat.setup_id}`] = { evaluated, passes, digest: acc };
    }
  }
  return out;
}
