/**
 * Remediation regression tests (P0 + P1).
 *
 * Each block pins a defect found in the independent audit and fixed in this
 * run. These must fail loudly if any of them regress.
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  operationalUniverse, isOperationalSymbol, universeSource, universeMeta,
  __setOperationalUniverse,
} from "../src/lib/market/operational-universe";
import { LEGACY_UNIVERSE } from "../src/lib/domain/universe";
import { normalizeMarket, parsePrecisions, decimalsFromStep, isPermanentlyExcluded } from "../src/lib/market/catalog";
import { isUnsupportedResolution } from "../src/lib/ttt/client";
import { TttHttpError } from "../src/lib/ttt/http";
import { abcdBaseSetup } from "../src/lib/strategy/compiled/harmonic-abcd";
import { evaluateSetup } from "../src/lib/rules/setup";
import { MapFeatureBag } from "../src/lib/rules/engine";
import { okFeature, invalidFeature } from "../src/lib/features/types";

function srcFiles(dir = "src", out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = srcFiles();

/* ───────────────────────────── P0-1 dynamic universe ─────────────────────── */

describe("P0-1 the operational universe is dynamic, not the legacy 48", () => {
  afterEach(() => __setOperationalUniverse(null));

  it("no production module iterates the legacy symbol list", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f.endsWith("domain/universe.ts")) continue;            // the definition itself
      if (f.endsWith("market/operational-universe.ts")) continue; // documented bootstrap
      if (f.endsWith("api/market/catalog/route.ts")) continue;    // regression reporting
      const src = fs.readFileSync(f, "utf8");
      // a bare `UNIVERSE` import/usage in production is the smell
      if (/\bfrom "[^"]*domain\/universe"/.test(src) && /[^_A-Z]UNIVERSE\b/.test(src.replace(/LEGACY_UNIVERSE|UNIVERSE_SET|UNIVERSE_SIZE/g, ""))) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("board, stats, store, engine, candles and psychology read the operational universe", () => {
    for (const f of [
      "src/app/api/market/board/route.ts",
      "src/app/api/market/stats/route.ts",
      "src/lib/market/store.ts",
      "src/lib/market/engine.ts",
      "src/lib/market/candles.ts",
      "src/lib/psychology/engine.ts",
      "src/app/api/market/symbols/route.ts",
    ]) {
      expect(fs.readFileSync(f, "utf8"), f).toContain("operationalUniverse");
    }
  });

  it("a newly discovered TTT symbol flows through runtime validation", () => {
    // XAUUSDT is NOT in the legacy 48 — it must still be accepted once discovered
    expect(LEGACY_UNIVERSE).not.toContain("XAUUSDT");
    __setOperationalUniverse(["BTCUSDT", "XAUUSDT", "NVDAUSDT"]);
    expect(isOperationalSymbol("XAUUSDT")).toBe(true);
    expect(isOperationalSymbol("NVDAUSDT")).toBe(true);
    expect(operationalUniverse()).toContain("XAUUSDT");
    expect(universeSource()).toBe("ttt-dynamic");
  });

  it("a symbol absent from the discovered universe is rejected", () => {
    __setOperationalUniverse(["BTCUSDT"]);
    expect(isOperationalSymbol("NOTREALUSDT")).toBe(false);
    expect(isOperationalSymbol("")).toBe(false);
  });

  it("TONUSDT can never enter the operational universe", () => {
    __setOperationalUniverse(["BTCUSDT", "TONUSDT"]);
    expect(operationalUniverse()).not.toContain("TONUSDT");
    expect(isOperationalSymbol("TONUSDT")).toBe(false);
    expect(isPermanentlyExcluded("TONUSDT")).toBe(true);
  });

  it("reports honestly when discovery has not completed", () => {
    __setOperationalUniverse(null);
    expect(universeMeta().discovery_complete).toBe(false);
    expect(universeSource()).toBe("legacy-bootstrap");
  });

  it("discovery runs BEFORE catalog ingestion and the stats sweep at boot", () => {
    const eng = fs.readFileSync("src/lib/market/engine.ts", "utf8");
    const iDisc = eng.indexOf("refreshOperationalUniverse(true)");
    const iCat = eng.indexOf("tttClient.getMarkets()");
    const iSweep = eng.indexOf("await this.sweepStats()");
    expect(iDisc).toBeGreaterThan(-1);
    expect(iDisc).toBeLessThan(iCat);
    expect(iDisc).toBeLessThan(iSweep);
  });

  it("re-discovery runs periodically so post-boot listings appear", () => {
    expect(fs.readFileSync("src/lib/market/engine.ts", "utf8")).toMatch(/interval\("discovery"/);
  });

  it("the legacy list survives only as a named regression fixture", () => {
    expect(LEGACY_UNIVERSE).toHaveLength(48);
    expect(fs.readFileSync("src/lib/domain/universe.ts", "utf8")).toMatch(/REGRESSION SET/i);
  });
});

/* ─────────────────────── P0-2 harmonic filter inversion ──────────────────── */

describe("P0-2 harmonic expansion filter BLOCKS violent expansion", () => {
  const bag = (state: string) =>
    MapFeatureBag.from([
      ["FTR-VOL-REGIME", okFeature("FTR-VOL-REGIME", "1h", { state, atr: 2, atr_avg: 1 }, 1, 100, "1.0.0", ["candles"])],
      ["FTR-ABCD", okFeature("FTR-ABCD", "1h", null, 1, 100, "1.0.0", ["FTR-SWINGS"])],
      ["FTR-STRUCT-BIAS", okFeature("FTR-STRUCT-BIAS", "1h", { bias: "HH_HL" }, 1, 100, "1.0.0", ["FTR-SWINGS"])],
    ]);

  const filterRule = () => abcdBaseSetup().rules.find((r) => r.kind === "filter")!;

  it("EXPANSION makes the filter predicate FAIL (which blocks the setup)", () => {
    const r = filterRule();
    const res = r.predicates[0].test(bag("EXPANSION"));
    expect(res.ok, "an EXPANSION spike must NOT satisfy the exclusion filter").toBe(false);
    expect(res.detail).toMatch(/BLOCKED/);
  });

  it("a calm regime satisfies the filter", () => {
    for (const state of ["NEUTRAL", "COMPRESSION"]) {
      const res = filterRule().predicates[0].test(bag(state));
      expect(res.ok, state).toBe(true);
    }
  });

  it("end-to-end: EXPANSION yields a BLOCKED setup", () => {
    const ev = evaluateSetup(abcdBaseSetup(), bag("EXPANSION"));
    expect(ev.outcome).toBe("BLOCKED");
    expect(ev.explanation).toMatch(/exclusion filter matched/i);
  });

  it("end-to-end: a calm regime is not blocked BY THE FILTER", () => {
    const ev = evaluateSetup(abcdBaseSetup(), bag("NEUTRAL"));
    const filterStage = ev.stages.find((s) => s.stage === "filter")!;
    expect(filterStage.outcome).toBe("PASS");
  });

  it("missing regime data does not silently permit the trade", () => {
    const b = MapFeatureBag.from([
      ["FTR-VOL-REGIME", invalidFeature("FTR-VOL-REGIME", "1h", "INSUFFICIENT_BARS", "too few bars", "1.0.0")],
    ]);
    const ev = evaluateSetup(abcdBaseSetup(), b);
    expect(["BLOCKED", "UNKNOWN"]).toContain(ev.outcome);
  });
});

/* ───────────────────── P0-3 TTT instrument metadata honesty ──────────────── */

describe("P0-3 instrument metadata is never fabricated", () => {
  const RAW = {
    symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", category: "Layer1",
    name: "Bitcoin USDT-M Perp", tickSize: "0.1", stepSize: "0.000001",
    minLeverage: 1, maxLeverage: 150, maintenanceMarginRate: "0.1", isActive: true,
    makerFeeCoefficient: "0.0004", takerFeeCoefficient: "0.0004",
    precisions: ["0.1", "1", "0.01"],           // TTT sends a STRING ARRAY
    leverageTiers: [{ minNotional: "0", maxNotional: "20000" }],
  };

  it("parses the real string-array precisions shape", () => {
    const p = parsePrecisions(["0.1", "1", "0.01"]);
    expect(p.price).toBe(1);   // "0.1" -> 1 decimal
    expect(p.qty).toBe(0);     // "1"   -> 0 decimals
  });

  it("tolerates an object precisions shape without guessing", () => {
    expect(parsePrecisions({ price: "0.01", quantity: "0.001" })).toEqual({ price: 2, qty: 3 });
    expect(parsePrecisions("nonsense")).toEqual({ price: null, qty: null });
    expect(parsePrecisions(undefined)).toEqual({ price: null, qty: null });
  });

  it("decimalsFromStep handles decimals, integers and exponent form", () => {
    expect(decimalsFromStep("0.001")).toBe(3);
    expect(decimalsFromStep("1")).toBe(0);
    expect(decimalsFromStep("1e-7")).toBe(7);
    expect(decimalsFromStep(null)).toBeNull();
    expect(decimalsFromStep("0")).toBeNull();
  });

  it("min_qty is UNAVAILABLE — stepSize is an increment, not a minimum", () => {
    const m = normalizeMarket(RAW, 1)!;
    expect(m.constraints.min_qty).toBeNull();
    expect(m.unavailable_constraints).toContain("min_qty");
    // and it must NOT have been copied from stepSize
    expect(m.constraints.min_qty).not.toBe(m.constraints.step_size);
  });

  it("min_notional is UNAVAILABLE — tier-0 lower bound is not an order minimum", () => {
    const m = normalizeMarket(RAW, 1)!;
    expect(m.constraints.min_notional).toBeNull();
    expect(m.unavailable_constraints).toContain("min_notional");
    expect(m.constraints.first_tier_min_notional).toBe(0);
  });

  it("settlement_asset is NOT inferred from quoteAsset", () => {
    const m = normalizeMarket(RAW, 1)!;
    expect(m.settlement_asset).toBeNull();
    expect(m.unavailable_constraints).toContain("settlement_asset");
  });

  it("contract_type is UNAVAILABLE unless TTT states it", () => {
    const m = normalizeMarket(RAW, 1)!;
    expect(m.contract_type).toBe("UNAVAILABLE");
    const withType = normalizeMarket({ ...RAW, contractType: "perpetual" }, 1)!;
    expect(withType.contract_type).toBe("PERPETUAL");
    expect(withType.unavailable_constraints).not.toContain("contract_type");
  });

  it("records settlement when the venue actually provides it", () => {
    const m = normalizeMarket({ ...RAW, settlementAsset: "usdt" }, 1)!;
    expect(m.settlement_asset).toBe("USDT");
  });

  it("survives a malformed market row", () => {
    expect(normalizeMarket({}, 1)).toBeNull();
    const partial = normalizeMarket({ symbol: "XUSDT", quoteAsset: "USDT", isActive: true }, 1)!;
    expect(partial.constraints.tick_size).toBeNull();
    expect(partial.unavailable_constraints.length).toBeGreaterThan(0);
  });

  it("normalizes a brand-new TTT listing", () => {
    const m = normalizeMarket({ ...RAW, symbol: "XAUUSDT", baseAsset: "XAU", category: "Commodity", precisions: ["0.01", "0.1", "1"] }, 1)!;
    expect(m.symbol).toBe("XAUUSDT");
    expect(m.eligibility).toContain("ASA_MARKET_ELIGIBLE");
    expect(m.constraints.price_precision).toBe(2);
  });
});

/* ───────────────────────── P0-4 1D fallback semantics ────────────────────── */

describe("P0-4 an outage can never be masked as derived 1D data", () => {
  it("timeout / 5xx / auth / rate-limit / network do NOT authorise a fallback", () => {
    for (const kind of ["timeout", "server", "auth", "rate_limited", "network"] as const) {
      expect(isUnsupportedResolution(new TttHttpError(kind, "boom")), kind).toBe(false);
    }
  });

  it("only an explicit unsupported-resolution signal authorises a fallback", () => {
    expect(isUnsupportedResolution(new TttHttpError("client", "unsupported_resolution"))).toBe(true);
    expect(isUnsupportedResolution(new TttHttpError("client", "invalid resolution 1D"))).toBe(true);
    expect(isUnsupportedResolution(new TttHttpError("client", "bad request"))).toBe(false);
  });

  it("a non-TTT error never authorises a fallback", () => {
    expect(isUnsupportedResolution(new Error("kaboom"))).toBe(false);
    expect(isUnsupportedResolution(null)).toBe(false);
  });

  it("the client rethrows instead of catching everything", () => {
    const src = fs.readFileSync("src/lib/ttt/client.ts", "utf8");
    expect(src).toMatch(/if \(isUnsupportedResolution\(err\)\)/);
    expect(src).toMatch(/throw err;/);
    // the old blanket `catch {` fallback must be gone
    expect(src).not.toMatch(/\}\s*catch\s*\{\s*\n\s*const d = await this\.derive1DFallback/);
  });

  it("1d is still requested natively first", () => {
    expect(fs.readFileSync("src/lib/ttt/client.ts", "utf8")).toMatch(/resolution: "1D"/);
  });
});

/* ─────────────────── P0-5 history vs compute window vs viewport ──────────── */

describe("P0-5 durable history is distinct from the chart viewport", () => {
  const chart = () => fs.readFileSync("src/components/chart-view.tsx", "utf8");

  it("the three concepts are named explicitly", () => {
    const src = chart();
    for (const c of ["DURABLE_HISTORY", "COMPUTE_WINDOW", "CHART_VIEWPORT"]) expect(src).toContain(c);
  });

  it("the chart pages older history from the durable endpoint", () => {
    const src = chart();
    expect(src).toContain("/api/market/history");
    expect(src).toMatch(/loadOlder/);
    expect(src).toMatch(/subscribeVisibleLogicalRangeChange/);
  });

  it("older pages are deduplicated and kept ascending", () => {
    const src = chart();
    expect(src).toMatch(/seen\.has\(c\.t\)/);
    expect(src).toMatch(/sort\(\(a, b\) => a\.t - b\.t\)/);
  });

  it("the boundary is surfaced to the user, not hidden", () => {
    expect(chart()).toMatch(/TTT boundary reached/);
  });

  it("the backend history route still applies no default limit", () => {
    const src = fs.readFileSync("src/app/api/market/history/route.ts", "utf8");
    expect(src).toMatch(/transport_window_applied/);
    expect(src).not.toMatch(/limit\s*=\s*\d{3,}/);
  });
});

/* ─────────────────── P1 production graph / reference isolation ───────────── */

describe("P1 the reference harness is not in the production graph", () => {
  it("NO production file references the reference harness at all", () => {
    const offenders = FILES.filter((f) => fs.readFileSync(f, "utf8").includes("strategy/reference"));
    expect(offenders).toEqual([]);
  });

  it("the harness file has been moved out of src/ entirely", () => {
    expect(fs.existsSync("src/lib/strategy/reference.ts")).toBe(false);
    expect(fs.existsSync("tests/fixtures/strategy/reference-strategy.ts")).toBe(true);
  });

  it("the reference strategy is not reachable from the runtime registry list", async () => {
    const { listRuntimeStrategies } = await import("../src/lib/strategy/runtime");
    expect(listRuntimeStrategies().map((s) => s.setup_id)).not.toContain("reference-trend-continuation");
  });
});

/* ───────────────────────── P1 stale documentation scan ───────────────────── */

describe("P1 no stale architecture claims remain in production source", () => {
  it("no source file claims an operational 48-symbol universe", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (/48[- ]symbol universe|exactly 48 symbols|canonical 48/i.test(line) && !/regression|legacy|test-only/i.test(line)) {
          offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no source file references PostgreSQL or Drizzle", () => {
    const offenders = FILES.filter((f) => /postgres|drizzle/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

/* ─────────────────── P1 Brain rule executability governance ──────────────── */

describe("P1 Brain rules are honestly classified, never overclaimed", () => {
  const BRAIN = "asa-data/brain.db";
  const hasBrain = fs.existsSync(BRAIN);

  it.runIf(hasBrain)("no stored source-text rule is a runtime candidate", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(BRAIN, { readonly: true });
    try {
      const bad = db.prepare("SELECT COUNT(*) n FROM rules WHERE runtime_status != 'DISABLED'").get() as { n: number };
      expect(bad.n, "a rule with no predicate must never be CANDIDATE").toBe(0);
    } finally { db.close(); }
  });

  it.runIf(hasBrain)("every rule with empty predicates carries a non_executable_reason", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(BRAIN, { readonly: true });
    try {
      const bad = db.prepare("SELECT COUNT(*) n FROM rules WHERE predicates='[]' AND (non_executable_reason IS NULL OR non_executable_reason='')").get() as { n: number };
      expect(bad.n).toBe(0);
    } finally { db.close(); }
  });

  it.runIf(hasBrain)("source_status is not blanket SOURCE_VERIFIED", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(BRAIN, { readonly: true });
    try {
      const rows = db.prepare("SELECT source_status k, COUNT(*) n FROM rules GROUP BY 1").all() as { k: string; n: number }[];
      const total = rows.reduce((a, r) => a + r.n, 0);
      const verified = rows.find((r) => r.k === "SOURCE_VERIFIED")?.n ?? 0;
      expect(total).toBeGreaterThan(0);
      // absence of a [VERIFIED] marker must NOT be counted as verified
      expect(verified).toBeLessThan(total);
      expect(rows.some((r) => r.k === "SOURCE_INFERRED")).toBe(true);
    } finally { db.close(); }
  });

  it.runIf(hasBrain)("rule_class distinguishes UNKNOWN / CLAIM / UNFORMALIZED", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(BRAIN, { readonly: true });
    try {
      const classes = (db.prepare("SELECT DISTINCT rule_class k FROM rules").all() as { k: string }[]).map((r) => r.k);
      expect(classes).toContain("UNFORMALIZED_RULE");
      for (const c of classes) {
        expect(["MACHINE_EXECUTABLE_RULE", "SOURCE_TEXT_RULE", "UNFORMALIZED_RULE", "ENGINEERING_RULE", "UNKNOWN", "CONFLICT", "CLAIM"]).toContain(c);
      }
    } finally { db.close(); }
  });

  it("the executable rules come from compiled strategies, not the stored table", async () => {
    const { listRuntimeStrategies } = await import("../src/lib/strategy/runtime");
    const compiled = listRuntimeStrategies().flatMap((s) => (s.impl ? s.impl.setup().rules : []));
    expect(compiled.length).toBeGreaterThan(0);
    for (const r of compiled) {
      expect(r.predicates.length, `${r.id} must carry a real predicate`).toBeGreaterThan(0);
      expect(r.feature_dependencies.length).toBeGreaterThan(0);
    }
  });
});

/* ─────────────── P1 engineering policy vs source semantics ───────────────── */

describe("P1 engineering parameters are separated from source rules", () => {
  it("the origin registry is internally consistent", async () => {
    const { validatePolicyOrigins } = await import("../src/lib/policy/origin");
    const v = validatePolicyOrigins();
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("no ENGINEERING_POLICY value cites the corpus", async () => {
    const { POLICY_PARAMS } = await import("../src/lib/policy/origin");
    for (const p of POLICY_PARAMS.filter((x) => x.origin === "ENGINEERING_POLICY")) {
      expect(p.source_refs, p.id).toEqual([]);
    }
  });

  it("every SOURCE_VERIFIED value carries a citation", async () => {
    const { POLICY_PARAMS } = await import("../src/lib/policy/origin");
    for (const p of POLICY_PARAMS.filter((x) => x.origin === "SOURCE_VERIFIED")) {
      expect(p.source_refs.length, p.id).toBeGreaterThan(0);
    }
  });

  it("the known engineering heuristics are all registered", async () => {
    const { POLICY_PARAMS } = await import("../src/lib/policy/origin");
    const ids = POLICY_PARAMS.map((p) => p.id);
    for (const id of ["STOP_BUFFER_ATR", "MAX_TARGET_ATR", "RR_FULL_MARKS", "SCORE_THRESHOLD", "TTT_MAX_BARS_PER_REQUEST"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("engineering policy is versioned independently of source semantics", async () => {
    const { ENGINEERING_POLICY_VERSION } = await import("../src/lib/policy/origin");
    expect(ENGINEERING_POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
