/**
 * Governance regression tests for the AsA Brain.
 *
 * These encode the master prompt's non-negotiables as executable assertions.
 * If any of these fail, the brain is lying about what it knows.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrainStore } from "../src/lib/brain/store";
import { ingestCorpus } from "../src/lib/brain/ingest";
import { evaluateGate, clampRuntimeStatus, canGoLive } from "../src/lib/brain/gate";
import { CORPUS_FILES } from "../src/lib/brain/corpus-manifest";
import { classifyLine, parseStrategyBlocks, unknownCriticalFields } from "../src/lib/brain/classify";
import { buildRiskPolicies, RISK_CONFLICT_GROUP } from "../src/lib/brain/policies";
import { buildFeatures, buildPrimitives } from "../src/lib/brain/primitives";

const CORPUS_DIR = path.resolve("knowledge/raw");
const hasCorpus = CORPUS_FILES.every((f) => fs.existsSync(path.join(CORPUS_DIR, f.filename)));

let store: BrainStore;
let dbPath: string;
let report: ReturnType<typeof ingestCorpus>;

beforeAll(() => {
  if (!hasCorpus) return;
  dbPath = path.join(os.tmpdir(), `asa-brain-test-${Date.now()}.db`);
  store = new BrainStore(dbPath);
  report = ingestCorpus(store, CORPUS_DIR);
});

afterAll(() => {
  store?.close();
  if (dbPath) for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });
});

describe.runIf(hasCorpus)("corpus ingestion completeness", () => {
  it("ingests all five TXT files", () => {
    expect(report.documents).toHaveLength(5);
    expect(report.errors).toEqual([]);
  });

  it("writes exactly one fragment per source line — nothing is dropped", () => {
    const expected = report.documents.reduce((a, d) => a + d.lines, 0);
    expect(report.fragments_written).toBe(expected);
    expect(report.lines_seen).toBe(expected);
    expect(report.coverage_ok).toBe(true);
  });

  it("records a sha256 for every document so corpus drift is detectable", () => {
    for (const d of report.documents) expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags the three upstream-truncated files honestly", () => {
    const truncated = report.documents.filter((d) => d.truncated).map((d) => d.file_id).sort();
    expect(truncated).toEqual(["1.txt", "2.txt", "4.txt"]);
    for (const doc of store.documents()) {
      if (doc.truncated) expect(doc.truncation_note).toContain("not reconstructed");
    }
  });

  it("every line of every file is retrievable by file+line provenance", () => {
    for (const d of report.documents) {
      for (const line of [1, Math.floor(d.lines / 2), d.lines]) {
        const frags = store.fragmentsFor(d.file_id, line, 0);
        expect(frags.length, `${d.file_id}:${line}`).toBeGreaterThan(0);
      }
    }
  });
});

describe.runIf(hasCorpus)("UNKNOWN / CONFLICT / CLAIM preservation", () => {
  it("preserves UNKNOWN markers as UNKNOWN", () => {
    expect(report.unknown_fragments).toBeGreaterThan(500);
  });

  it("keeps every CLAIM at UNTESTED — a claim is never empirical proof", () => {
    const claims = store.claims(1000);
    expect(claims.length).toBeGreaterThan(100);
    for (const c of claims) {
      expect(c.empirical_status).toBe("UNTESTED");
      expect(c.test_result).toBeNull();
    }
  });

  it("keeps conflicts unresolved and preserves every competing variant", () => {
    const groups = store.conflicts();
    const risk = groups.find((g) => g.conflict_group_id === RISK_CONFLICT_GROUP);
    expect(risk).toBeDefined();
    expect(risk!.resolution).toBe("UNRESOLVED");
    expect(risk!.chosen_variant).toBeNull();
    // all four competing risk statements survive — none averaged away
    expect(risk!.variants.length).toBeGreaterThanOrEqual(4);
    const labels = risk!.variants.map((v) => v.label).join("|");
    expect(labels).toContain("2%");
    expect(labels).toContain("1%");
  });

  it("never merges conflicting risk percentages into one number", () => {
    const policies = buildRiskPolicies();
    const perTrade = policies
      .filter((p) => p.risk_per_trade_pct !== null && p.conflict_group_id === RISK_CONFLICT_GROUP)
      .map((p) => p.risk_per_trade_pct);
    // both 1 and 2 must still exist as distinct policies; no 1.5 average
    expect(perTrade).toContain(1);
    expect(perTrade).toContain(2);
    expect(perTrade).not.toContain(1.5);
  });

  it("marks the engineering default as INFERRED, never as a source fact", () => {
    const d = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT");
    expect(d).toBeDefined();
    expect(d!.source_status).toBe("SOURCE_INFERRED");
    expect(d!.notes).toContain("ASSUMPTION");
    expect(d!.source_refs).toHaveLength(0);
  });
});

describe.runIf(hasCorpus)("commentary never becomes an executable rule", () => {
  it("quarantines extractor/assistant meta commentary", () => {
    expect(report.quarantined).toBeGreaterThan(0);
    const stats = store.stats();
    expect(stats.quarantined).toBe(report.quarantined);
  });

  it("classifies known meta commentary correctly", () => {
    const c = classifyLine("استخراج کامل و دقیق محتوای فایل متنی ارائه شده به شرح زیر است.");
    expect(c.cls).toBe("META_COMMENTARY");
    expect(c.quarantine).toContain("never executable");
  });

  it("no quarantined fragment is attached to an executable strategy", () => {
    const executable = store.strategies().filter((s) => s.implementation !== null);
    for (const s of executable) {
      for (const ref of s.source_refs) {
        const frags = store.fragmentsFor(ref.file, ref.start_line, 0);
        for (const f of frags) expect(f.quarantined).toBe(false);
      }
    }
  });
});

describe("runtime gate — disabled strategies cannot become live", () => {
  it("blocks live promotion when any critical field is UNKNOWN", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED",
      empirical_status: "ROBUST",
      unknown_critical: ["stop"],
      conflict_unresolved: false,
      has_implementation: true,
    });
    expect(v.allowed).toBe("DISABLED");
    expect(canGoLive(v)).toBe(false);
    expect(v.reasons.join(" ")).toContain("stop");
  });

  it("never promotes on source strength alone (UNTESTED caps at CANDIDATE)", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      unknown_critical: [],
      conflict_unresolved: false,
      has_implementation: true,
    });
    expect(v.allowed).toBe("CANDIDATE");
  });

  it("caps in-sample BACKTESTED at PAPER", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED", empirical_status: "BACKTESTED",
      unknown_critical: [], conflict_unresolved: false, has_implementation: true,
    });
    expect(v.allowed).toBe("PAPER");
  });

  it("allows LIVE_ADVISORY_ONLY only with OOS/walk-forward/robust evidence", () => {
    for (const e of ["OOS_TESTED", "WALK_FORWARD", "ROBUST"] as const) {
      const v = evaluateGate({
        source_status: "SOURCE_VERIFIED", empirical_status: e,
        unknown_critical: [], conflict_unresolved: false, has_implementation: true,
      });
      expect(v.allowed).toBe("LIVE_ADVISORY_ONLY");
    }
  });

  it("an untested CLAIM can never be enabled", () => {
    const v = evaluateGate({
      source_status: "CLAIM", empirical_status: "UNTESTED",
      unknown_critical: [], conflict_unresolved: false, has_implementation: true,
    });
    expect(v.allowed).toBe("DISABLED");
  });

  it("an unresolved CONFLICT can never be enabled", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED", empirical_status: "ROBUST",
      unknown_critical: [], conflict_unresolved: true, has_implementation: true,
    });
    expect(v.allowed).toBe("DISABLED");
  });

  it("REJECTED is terminal", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED", empirical_status: "REJECTED",
      unknown_critical: [], conflict_unresolved: false, has_implementation: true,
    });
    expect(v.allowed).toBe("DISABLED");
  });

  it("clamping cannot raise a status above the evidence ceiling", () => {
    const v = evaluateGate({
      source_status: "SOURCE_VERIFIED", empirical_status: "UNTESTED",
      unknown_critical: [], conflict_unresolved: false, has_implementation: true,
    });
    expect(clampRuntimeStatus("LIVE_ADVISORY_ONLY", v)).toBe("CANDIDATE");
    expect(clampRuntimeStatus("PAPER", v)).toBe("CANDIDATE");
    expect(clampRuntimeStatus("DISABLED", v)).toBe("DISABLED");
  });
});

describe.runIf(hasCorpus)("no strategy in the corpus is live (nothing is empirically tested yet)", () => {
  it("zero strategies hold LIVE_ADVISORY_ONLY", () => {
    const live = store.strategies().filter((s) => s.runtime_status === "LIVE_ADVISORY_ONLY");
    expect(live).toEqual([]);
  });

  it("every DISABLED strategy states exactly why", () => {
    for (const s of store.strategies()) {
      if (s.runtime_status === "DISABLED") {
        expect(s.disabled_reason, s.strategy_id).toBeTruthy();
        expect(s.disabled_reason!.length).toBeGreaterThan(10);
      }
    }
  });

  it("every strategy traces back to at least one source line", () => {
    for (const s of store.strategies()) {
      expect(s.source_refs.length, s.strategy_id).toBeGreaterThan(0);
      for (const r of s.source_refs) {
        expect(r.file).toMatch(/^[1-5]\.txt$/);
        expect(r.start_line).toBeGreaterThan(0);
      }
    }
  });
});

describe("never invent missing parameters", () => {
  it("a block whose fields are UNKNOWN yields UNKNOWN, not a guess", () => {
    const lines = [
      "نام استراتژی: تست",
      "تایم‌فریم: UNKNOWN",
      "شرایط ورود Long: UNKNOWN",
      "Stop Loss: UNKNOWN",
      "Take Profit: UNKNOWN",
      "شرایط خروج: UNKNOWN",
    ];
    const blocks = parseStrategyBlocks("9.txt", lines);
    expect(blocks).toHaveLength(1);
    const unknown = unknownCriticalFields(blocks[0]);
    expect(unknown.sort()).toEqual(["entry", "invalidation", "stop", "target", "timeframe"]);
  });

  it("parses a real specified field without altering its text", () => {
    const lines = ["نام استراتژی: X", "Stop Loss: کمی پایین‌تر از حمایت PRZ"];
    const b = parseStrategyBlocks("9.txt", lines)[0];
    const stop = b.fields.find((f) => f.field === "stop");
    expect(stop?.value).toBe("کمی پایین‌تر از حمایت PRZ");
    expect(stop?.is_unknown).toBe(false);
  });
});

describe("unavailable TTT fields never become fabricated values", () => {
  it("liquidation / L-S ratio / CVD stay UNAVAILABLE with a reason", () => {
    const feats = buildFeatures();
    for (const id of ["FTR-LIQ", "FTR-LSR", "FTR-CVD"]) {
      const f = feats.find((x) => x.feature_id === id)!;
      expect(f.availability).toBe("UNAVAILABLE");
      expect(f.unavailable_reason).toBeTruthy();
      expect(f.formula).toBe("N/A");
    }
  });

  it("tape flow is PROXY, never MEASURED, because aggressor semantics are unverified", () => {
    const f = buildFeatures().find((x) => x.feature_id === "FTR-TAPE-FLOW")!;
    expect(f.availability).toBe("PROXY");
    expect(f.edge_cases.join(" ")).toContain("UNVERIFIED");
  });

  it("every UNAVAILABLE primitive carries a reason", () => {
    for (const p of buildPrimitives()) {
      if (p.availability === "UNAVAILABLE") expect(p.unavailable_reason, p.primitive_id).toBeTruthy();
      if (p.availability === "PROXY") expect(p.unavailable_reason, p.primitive_id).toBeTruthy();
    }
  });
});

describe("multi-line field values are not lost", () => {
  it("collects continuation lines under a bare field header", () => {
    // Real shape from RAW_2: "Take Profit:" then indented target lines.
    const lines = [
      "نام استراتژی: X",
      "Take Profit:",
      "تارگت ۱: اولین سطح حمایت نامرئی قبلی.",
      "تارگت ۲: ناحیه PRZ.",
      "Risk/Reward: بالا",
    ];
    const b = parseStrategyBlocks("9.txt", lines)[0];
    const target = b.fields.find((f) => f.field === "target")!;
    expect(target.is_unknown).toBe(false);
    expect(target.value).toContain("تارگت ۱");
    expect(target.value).toContain("تارگت ۲");
  });

  it("an empty field with no continuation stays UNKNOWN", () => {
    const b = parseStrategyBlocks("9.txt", ["نام استراتژی: X", "Take Profit:", "", "Stop Loss: y"])[0];
    expect(b.fields.find((f) => f.field === "target")!.is_unknown).toBe(true);
  });
});

describe.runIf(hasCorpus)("gate and compiler agree", () => {
  it("a strategy has an executable spec if and only if no critical field is UNKNOWN", () => {
    const compiled = JSON.parse(store.meta("compiled_specs_full") ?? "[]") as {
      strategy_id: string; executable: boolean;
    }[];
    const byId = new Map(compiled.map((c) => [c.strategy_id, c]));
    for (const s of store.strategies()) {
      const spec = byId.get(s.strategy_id);
      if (!spec) continue;
      expect(spec.executable, `${s.strategy_id} gate/compile disagreement`).toBe(s.unknown_critical.length === 0);
    }
  });
});
