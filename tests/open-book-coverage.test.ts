import { afterAll, describe, expect, it } from "vitest";
import { SqliteRepo } from "../src/db/sqlite";
import type { SignalRow } from "../src/db/repo";
import { advisoryOpenRisks, loadLiveGateContext } from "../src/lib/pipeline/live-gates";
import { evaluatePortfolio } from "../src/lib/risk/portfolio";
import { TEST_ONLY_SOURCE_RISK_MATH_POLICY } from "./helpers/research-run-options";

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const repo = new SqliteRepo(":memory:");

afterAll(() => repo.close());

function insertSignal(
  id: string,
  state: string,
  updatedMs: number,
  overrides: Partial<SignalRow> = {},
): void {
  const anchor = NOW - 30_000;
  repo.signalInsert({
    id,
    state,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long",
    score: 90,
    strategy_id: "test-strategy",
    opp_id: `opp-${id}`,
    payload_json: JSON.stringify({
      anchor_close_ms: anchor,
      timeframe: "1h",
      risk: { numbers: { risk_notional: 25 } },
    }),
    created_ms: updatedMs,
    updated_ms: updatedMs,
    ...overrides,
  });
}

describe("bounded live advisory-book coverage", () => {
  it("retains active signals with missing, future, or conflicting anchors as UNKNOWN exposure", () => {
    const row = (id: string, payload: unknown, overrides: Partial<SignalRow> = {}): SignalRow => ({
      id,
      state: "published",
      symbol: `${id.toUpperCase()}USDT`,
      timeframe: "1h",
      direction: "long",
      score: 90,
      strategy_id: "test-strategy",
      opp_id: `opp-${id}`,
      payload_json: JSON.stringify(payload),
      created_ms: NOW,
      updated_ms: NOW,
      outbox_id: null,
      ...overrides,
    });
    const rows = advisoryOpenRisks([
      row("fresh", { anchor_close_ms: NOW - 30_000, timeframe: "1h", risk: { numbers: { risk_notional: 25 } } }),
      row("unanchored", { timeframe: "1h", risk: { numbers: { risk_notional: 25 } } }),
      row("future", { anchor_close_ms: NOW + 1, timeframe: "1h", risk: { numbers: { risk_notional: 25 } } }),
      row("conflict", { anchor_close_ms: NOW - 30_000, timeframe: "4h", risk: { numbers: { risk_notional: 25 } } }),
    ], NOW)!;

    expect(rows).toContainEqual({ symbol: "FRESHUSDT", direction: "long", risk_amount: 25 });
    for (const symbol of ["UNANCHOREDUSDT", "FUTUREUSDT", "CONFLICTUSDT"]) {
      expect(rows).toContainEqual({ symbol, direction: "long", risk_amount: null });
    }
  });

  it("does not silently drop an active unanchored row from portfolio heat or concurrency", () => {
    const isolated = new SqliteRepo(":memory:");
    try {
      isolated.signalInsert({
        id: "unanchored-active",
        state: "published",
        symbol: "BTCUSDT",
        timeframe: "1h",
        direction: "long",
        score: 90,
        strategy_id: "test-strategy",
        opp_id: "opp-unanchored",
        payload_json: JSON.stringify({ timeframe: "1h", risk: { numbers: { risk_notional: 25 } } }),
        created_ms: NOW,
        updated_ms: NOW,
      });
      const context = loadLiveGateContext(isolated, NOW, { daily_loss_limit_pct: null });
      expect(context.open_risks).toEqual([{ symbol: "BTCUSDT", direction: "long", risk_amount: null }]);
      expect(context.open_book_reason).toContain("freshness-UNKNOWN");

      const portfolio = evaluatePortfolio({
        equity: 10_000,
        policy: TEST_ONLY_SOURCE_RISK_MATH_POLICY,
        open_risks: context.open_risks,
        daily_realized_loss: 0,
        period_realized_loss: 0,
        candidate: { symbol: "ETHUSDT", risk_amount: 25, direction: "long" },
      });
      expect(portfolio.verdict).toBe("unknown");
      expect(portfolio.numbers.open_risk_total).toBeNull();
      expect(portfolio.numbers.concurrent_positions).toBe(1);
    } finally {
      isolated.close();
    }
  });

  it("filters terminal history before applying the query bound", () => {
    for (let i = 0; i < 600; i += 1) {
      insertSignal(`terminal-${i}`, "expired", NOW + i + 1);
    }
    insertSignal("active-old", "published", NOW - 1);

    // Demonstrate the old query's defect: newer terminal rows hid the active row.
    expect(repo.signalList(500).some((row) => row.id === "active-old")).toBe(false);

    const context = loadLiveGateContext(repo, NOW, { daily_loss_limit_pct: null });
    expect(context.open_risks).toEqual([
      { symbol: "BTCUSDT", direction: "long", risk_amount: 25 },
    ]);
    expect(context.open_book_reason).toContain("complete active-signal query");
    expect(context.open_book_reason).toContain("1 fresh");
  });

  it("fails closed and discards partial rows when active coverage reaches the sentinel", () => {
    for (let i = 0; i < 501; i += 1) {
      insertSignal(`active-${i}`, "published", NOW + 1_000 + i);
    }

    const context = loadLiveGateContext(repo, NOW, { daily_loss_limit_pct: null });
    expect(context.open_risks).toBeNull();
    expect(context.open_book_reason).toContain("coverage is incomplete");
    expect(context.open_book_reason).toContain("partial results were discarded");

    const portfolio = evaluatePortfolio({
      equity: 10_000,
      policy: TEST_ONLY_SOURCE_RISK_MATH_POLICY,
      open_risks: context.open_risks,
      daily_realized_loss: null,
      period_realized_loss: null,
      candidate: { symbol: "ETHUSDT", risk_amount: 25, direction: "long" },
    });
    expect(portfolio.verdict).toBe("unknown");
    expect(portfolio.numbers.open_risk_total).toBeNull();
    expect(portfolio.numbers.concurrent_positions).toBeNull();
    expect(portfolio.reasons.join(" ")).toContain("open advisory book UNAVAILABLE");
  });
});
