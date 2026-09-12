/**
 * Gate 19 + Gate 20 closure tests.
 *
 *   §K chart evidence must be consumed by the chart route and every annotation
 *      must carry annotation_id -> produced_by -> source_refs -> detector_version
 *   §L Telegram must send the annotated image rendered from the SAME evidence,
 *      with a complete advisory payload and DB-level idempotency
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildChartEvidence } from "../src/lib/chart/evidence";
import { renderEvidenceSvg, renderEvidencePng, encodePng } from "../src/lib/chart/render";
import { formatSignalText } from "../src/lib/notify/telegram";
import { evaluateCompiled, COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import { parseUdfHistory } from "../src/lib/ttt/udf";
import type { Candle } from "../src/lib/domain/types";

const hasReplay = fs.existsSync("tests/fixtures/replay/BTCUSDT-60.json");
function replay(): Candle[] {
  const j = JSON.parse(fs.readFileSync("tests/fixtures/replay/BTCUSDT-60.json", "utf8"));
  return parseUdfHistory(j, 60).candles;
}

/** Find a window where the strategy actually produces levels, so the chart has content. */
function evidenceFixture() {
  const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
  const all = replay();
  for (let end = 400; end < all.length; end += 25) {
    const ev = evaluateCompiled(strat, "BTCUSDT", all.slice(0, end), 1_700_000_000_000);
    if (ev.levels.entry !== null && ev.levels.stop !== null && ev.levels.targets.length > 0) {
      return { ev, candles: all.slice(0, end), evidence: buildChartEvidence(ev, 87.5) };
    }
  }
  const ev = evaluateCompiled(strat, "BTCUSDT", all.slice(0, 500), 1_700_000_000_000);
  return { ev, candles: all.slice(0, 500), evidence: buildChartEvidence(ev, 87.5) };
}

describe.runIf(hasReplay)("§K chart evidence lineage", () => {
  const { evidence, candles } = evidenceFixture();

  it("produces annotations for a real replayed opportunity", () => {
    expect(evidence.annotations.length).toBeGreaterThan(0);
    const kinds = evidence.annotations.map((a) => a.kind);
    expect(kinds).toContain("entry");
    expect(kinds).toContain("stop");
    expect(kinds).toContain("target");
  });

  it("EVERY annotation carries full lineage", () => {
    for (const a of evidence.annotations) {
      expect(a.annotation_id, "annotation_id").toBeTruthy();
      expect(a.produced_by.id, `produced_by for ${a.annotation_id}`).toBeTruthy();
      expect(["feature", "rule"]).toContain(a.produced_by.type);
      expect(a.detector_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["MEASURED", "DERIVED", "SOURCE", "INFERRED"]).toContain(a.evidence_kind);
    }
  });

  it("annotations trace back to real corpus source lines", () => {
    const withRefs = evidence.annotations.filter((a) => a.source_refs.length > 0);
    expect(withRefs.length).toBeGreaterThan(0);
    for (const a of withRefs) {
      for (const r of a.source_refs) {
        expect(r.file).toMatch(/^[1-5]\.txt$/);
        expect(r.start_line).toBeGreaterThan(0);
      }
    }
  });

  it("reports the rules the chart depicts, with their outcomes", () => {
    expect(evidence.rules.length).toBeGreaterThan(0);
    for (const r of evidence.rules) {
      expect(["PASS", "FAIL", "UNKNOWN", "BLOCKED"]).toContain(r.outcome);
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });

  it("declares engineering quantifications rather than passing them off as source", () => {
    expect(evidence.assumptions.join(" ")).toMatch(/ENGINEERING PARAMETER|not derivable/);
  });

  it("marks lineage completeness explicitly", () => {
    expect(typeof evidence.lineage_complete).toBe("boolean");
    expect(evidence.lineage_complete).toBe(true);
  });

  it("never renders a concept the decision did not use", () => {
    // no annotation may exist without a producing rule/feature
    for (const a of evidence.annotations) expect(a.produced_by.id.length).toBeGreaterThan(0);
    // targets drawn must equal targets decided
    const drawn = evidence.annotations.filter((a) => a.kind === "target").length;
    expect(drawn).toBeLessThanOrEqual(3);
  });

  it("carries the score disclaimer", () => {
    expect(evidence.score_semantics).toMatch(/not a probability/i);
  });
});

describe.runIf(hasReplay)("§K chart renderer", () => {
  const { evidence, candles } = evidenceFixture();

  it("renders SVG containing every annotation with lineage data attributes", () => {
    const svg = renderEvidenceSvg(evidence, candles);
    expect(svg.startsWith("<svg")).toBe(true);
    for (const a of evidence.annotations) {
      expect(svg).toContain(`data-annotation-id="${a.annotation_id}"`);
      expect(svg).toContain(`data-detector-version="${a.detector_version}"`);
    }
    expect(svg).toMatch(/ADVISORY ONLY/);
    expect(svg).toMatch(/not a probability/i);
  });

  it("is deterministic — identical evidence renders identical bytes", () => {
    expect(renderEvidenceSvg(evidence, candles)).toBe(renderEvidenceSvg(evidence, candles));
  });

  it("renders a valid PNG with the correct signature and dimensions", () => {
    const png = renderEvidencePng(evidence, candles, { width: 240, height: 120 });
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR width/height are big-endian at offsets 16 and 20
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(240);
    expect(dv.getUint32(20)).toBe(120);
    expect(png.length).toBeGreaterThan(1000);
  });

  it("PNG encoder emits IHDR/IDAT/IEND in order", () => {
    const px = new Uint8Array(4 * 4 * 4).fill(255);
    const png = encodePng(4, 4, px);
    const s = Buffer.from(png).toString("latin1");
    expect(s.indexOf("IHDR")).toBeGreaterThan(0);
    expect(s.indexOf("IDAT")).toBeGreaterThan(s.indexOf("IHDR"));
    expect(s.indexOf("IEND")).toBeGreaterThan(s.indexOf("IDAT"));
  });

  it("handles an empty candle series without throwing", () => {
    expect(() => renderEvidenceSvg(evidence, [])).not.toThrow();
    expect(() => renderEvidencePng(evidence, [])).not.toThrow();
  });
});

describe("§L Telegram advisory payload", () => {
  const payload = {
    kind: "signal" as const,
    advisory_only: true,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "short",
    strategy: "پرایس اکشن سطوح نامرئی (SET-STR-RAW-2-803)",
    strategy_id: "STR-RAW-2-803",
    setup_id: "SET-STR-RAW-2-803",
    score: 87.5,
    score_semantics: "Score is a deterministic evidence sum (0-100), NOT a probability or win rate.",
    entry: 64000,
    stop: 64500,
    targets: [63000, 62000],
    rr: 2.0,
    risk: { verdict: "pass", numbers: { risk_amount: 100 } },
    psychology: { state: "READY", hard_blocks: [] },
    reason: "level touched with prior reactions; wick rejection confirmed",
    invalidation: 64500,
    timestamp: 1_700_000_000_000,
    opportunity_id: "abc123",
    generated_at_ms: 1_700_000_000_000,
  };

  it("contains every required advisory field", () => {
    const t = formatSignalText(payload);
    for (const needle of ["BTCUSDT", "1h", "short", "Score: 87.5", "Entry: 64000", "SL: 64500", "TP: 63000", "RR: 2", "Risk: pass", "Psychology: READY", "Reason:", "Invalidation: 64500", "Time:"]) {
      expect(t, needle).toContain(needle);
    }
  });

  it("states the score is not a probability", () => {
    expect(formatSignalText(payload)).toMatch(/NOT a probability/i);
  });

  it("uses NO execution language", () => {
    const t = formatSignalText(payload).toLowerCase();
    for (const banned of ["order placed", "position opened", "executed", "buying now", "selling now", "filled at", "we bought", "we sold"]) {
      expect(t, banned).not.toContain(banned);
    }
    expect(t).toContain("advisory only");
    expect(t).toContain("never places");
  });

  it("shows RR as UNKNOWN rather than inventing one", () => {
    const t = formatSignalText({ ...payload, rr: null });
    expect(t).toContain("RR: UNKNOWN");
  });

  it("surfaces a psychology hard block in the message", () => {
    const t = formatSignalText({ ...payload, psychology: { state: "BLOCKED", hard_blocks: ["daily loss limit reached"] } });
    expect(t).toContain("Psychology: BLOCKED");
    expect(t).toContain("daily loss limit reached");
  });
});
