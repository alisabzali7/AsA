/**
 * DECISION-PROVENANCE INTEGRITY — regression suite.
 *
 * Observed defect (reproduced by tampering a LOCAL TEST scenario database and
 * querying the running server): a published payload stores the decision-window
 * identity TWICE —
 *   `chart_evidence.snapshot`   (the copy `/api/charts` verifies)
 *   `provenance.data.snapshot`  (the copy the signals API returns)
 * — and nothing compared them. Changing one copy left the other intact, so
 * `/api/charts` still answered `snapshot_check: VERIFIED` while the payload now
 * carried a DIFFERENT, unverified decision fingerprint. A consumer reading the
 * provenance copy had no way to learn it disagreed with the verified one.
 *
 * Repair (structural): the contradiction is detected and reported, and the
 * chart route refuses to render a record whose stored identities disagree —
 * it never silently picks a copy.
 *
 * The healthy case (both copies identical, as the publisher always writes them)
 * must stay AGREED and keep rendering.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-snapid-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");

type Repo = import("../src/db/repo").Repo;
let repo: Repo;
let closeRepo: () => void;
let snapshotIdentityCheck: typeof import("../src/lib/pipeline/provenance").snapshotIdentityCheck;
let chartRoute: { GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };

const SNAPSHOT = {
  symbol: "BTCUSDT",
  timeframe: "1h",
  closed_bars: 200,
  first_t: 1_790_031_600,
  as_of_t: 1_790_748_000,
  knowable_at_ms: 1_790_751_600_000,
  engines: "strategy:STR-X@1|detectors:1.1.0",
  input_fingerprint: "09bf0591a1b2c3d4e5f6a7b8c9d0e1f2",
};

function payloadWith(overrides: { evidence?: unknown; provenance?: unknown } = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long",
    chart_evidence: {
      symbol: "BTCUSDT",
      timeframe: "1h",
      strategy_id: "STR-X",
      setup_id: "SET-X",
      direction: "long",
      bar_time: SNAPSHOT.as_of_t,
      annotations: [],
      rules: [],
      score: 90,
      score_semantics: "test",
      assumptions: [],
      lineage_complete: true,
      snapshot: overrides.evidence === undefined ? SNAPSHOT : overrides.evidence,
    },
    provenance: {
      generated_at_ms: 1,
      data: {
        series_fetched_ms: 1,
        stats_fetched_ms: null,
        native_1d: true,
        candles: { macro: null, context: null, trigger: 200 },
        snapshot: overrides.provenance === undefined ? SNAPSHOT : overrides.provenance,
      },
    },
  };
}

beforeAll(async () => {
  const sqlite = await import("../src/db/sqlite");
  const prov = await import("../src/lib/pipeline/provenance");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  snapshotIdentityCheck = prov.snapshotIdentityCheck;
  chartRoute = (await import("../src/app/api/charts/[id]/route")) as unknown as typeof chartRoute;
});

afterAll(() => {
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("snapshotIdentityCheck: the two stored decision identities must agree", () => {
  it("identical copies are AGREED (the only state a healthy publisher produces)", () => {
    const check = snapshotIdentityCheck(payloadWith());
    expect(check.state).toBe("AGREED");
    expect(check.reason).toMatch(/same decision window/);
  });

  it("a changed fingerprint in one copy is CONTRADICTION — reported, never resolved", () => {
    const check = snapshotIdentityCheck(payloadWith({ provenance: { ...SNAPSHOT, input_fingerprint: "deadbeef".repeat(4) } }));
    expect(check.state).toBe("CONTRADICTION");
    expect(check.reason).toMatch(/provenance\.data\.snapshot/);
    expect(check.reason).toMatch(/chart_evidence\.snapshot/);
    expect(check.reason).toMatch(/refusing to present either as verified/);
  });

  it("a shifted window (as_of_t / closed_bars) is CONTRADICTION", () => {
    expect(snapshotIdentityCheck(payloadWith({ evidence: { ...SNAPSHOT, as_of_t: SNAPSHOT.as_of_t + 3_600_000 } })).state).toBe("CONTRADICTION");
    expect(snapshotIdentityCheck(payloadWith({ evidence: { ...SNAPSHOT, closed_bars: 199 } })).state).toBe("CONTRADICTION");
    expect(snapshotIdentityCheck(payloadWith({ evidence: { ...SNAPSHOT, symbol: "ETHUSDT" } })).state).toBe("CONTRADICTION");
  });

  it("a single or absent stored copy is reported as SINGLE_SOURCE / ABSENT (legacy), never as agreement", () => {
    expect(snapshotIdentityCheck(payloadWith({ evidence: null })).state).toBe("SINGLE_SOURCE");
    expect(snapshotIdentityCheck(payloadWith({ provenance: null })).state).toBe("SINGLE_SOURCE");
    const noCopies = payloadWith({ evidence: null, provenance: null });
    expect(snapshotIdentityCheck(noCopies).state).toBe("ABSENT");
    expect(snapshotIdentityCheck({})).toMatchObject({ state: "ABSENT" });
  });
});

describe("chart route: contradictory provenance cannot be rendered", () => {
  function seedSignal(id: string, payload: Record<string, unknown>): void {
    repo.signalInsert({
      id,
      state: "published",
      symbol: "BTCUSDT",
      timeframe: "1h",
      direction: "long",
      score: 90,
      strategy_id: "STR-X",
      opp_id: `opp-${id}`,
      payload_json: JSON.stringify(payload),
      created_ms: Date.now(),
      updated_ms: Date.now(),
      outbox_id: null,
    });
  }

  it("refuses with 409 and names the contradiction instead of rendering one copy as the decision", async () => {
    const id = "sig-contradiction-1";
    seedSignal(id, payloadWith({ provenance: { ...SNAPSHOT, input_fingerprint: "deadbeef".repeat(4) } }));
    const res = await chartRoute.GET(new Request("http://local.test/api/charts/sig-contradiction-1.json"), {
      params: Promise.resolve({ id: `${id}.json` }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; reason: string; snapshot_identity: { state: string } };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("contradictory decision provenance");
    expect(body.snapshot_identity.state).toBe("CONTRADICTION");
    expect(body.reason).toMatch(/disagree/);
  });

  it("an agreeing record is not refused for provenance reasons", async () => {
    const id = "sig-agreed-1";
    seedSignal(id, payloadWith());
    const res = await chartRoute.GET(new Request("http://local.test/api/charts/sig-agreed-1.json"), {
      params: Promise.resolve({ id: `${id}.json` }),
    });
    // no candles exist in this fixture database, so the route stops at the
    // dataset boundary — the point is that it is NOT the provenance refusal.
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("contradictory decision provenance");
  });
});
