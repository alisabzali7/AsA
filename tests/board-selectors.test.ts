/**
 * Regression: dashboard (Command Center) board selectors.
 *
 * The old inline derivations on the dashboard:
 *   - titled the top-8 table "top by market cap" although market cap is NOT a
 *     TTT /futures/markets/stats metric and the table was sorted by price
 *   - built "day gainers" as top-5 by 24h change with NO > 0 filter (a down
 *     market rendered losers under "day gainers")
 *   - rendered an unmeasured change as `change24hPct ?? 0` → "+0.00%" green
 * These are truthfulness defects (unavailable ≠ 0, losers ≠ gainers, no
 * fabricated ranking claim). The selectors are pure so the rules are testable.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { topByPrice, topGainers, type BoardRowLite } from "../src/components/board-selectors";

const ROOT = path.join(__dirname, "..");
const PAGE_SRC = () => fs.readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");

const row = (symbol: string, price: number | null, change24hPct: number | null): BoardRowLite => ({
  symbol,
  price,
  change24hPct,
});

describe("topGainers", () => {
  it("returns only strictly positive 24h changes, descending, capped at n", () => {
    const rows = [
      row("AAAUSDT", 1, 2.5),
      row("BBBUSDT", 2, 9.9),
      row("CCCUSDT", 3, 0.1),
      row("DDDUSDT", 4, 50.0),
      row("EEEUSDT", 5, 3.3),
      row("FFFUSDT", 6, 1.1),
    ];
    expect(topGainers(rows, 3).map((r) => r.symbol)).toEqual(["DDDUSDT", "BBBUSDT", "EEEUSDT"]);
  });

  it("never treats an unmeasured (null) change as 0 — null rows are excluded, not rendered as 0", () => {
    const rows = [row("AAAUSDT", 1, null), row("BBBUSDT", 2, 1.0)];
    expect(topGainers(rows).map((r) => r.symbol)).toEqual(["BBBUSDT"]);
    expect(topGainers([row("AAAUSDT", 1, null)])).toEqual([]);
  });

  it("returns empty in a down market — losers (and flat rows) are never presented as gainers", () => {
    const rows = [row("AAAUSDT", 1, -0.4), row("BBBUSDT", 2, -2.2), row("CCCUSDT", 3, 0)];
    expect(topGainers(rows)).toEqual([]);
  });

  it("does not mutate the input row order", () => {
    const rows = [row("AAAUSDT", 1, 0.2), row("BBBUSDT", 2, 9.0), row("CCCUSDT", 3, 1.5)];
    topGainers(rows);
    expect(rows.map((r) => r.symbol)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
  });
});

describe("topByPrice", () => {
  it("sorts by measured last price descending and excludes unmeasured rows", () => {
    const rows = [
      row("AAAUSDT", 0.05, 1),
      row("BBBUSDT", null, 1),
      row("CCCUSDT", 118_000, 1),
      row("DDDUSDT", 3_500, 1),
    ];
    expect(topByPrice(rows).map((r) => r.symbol)).toEqual(["CCCUSDT", "DDDUSDT", "AAAUSDT"]);
  });

  it("caps at n", () => {
    const rows = [
      row("A", 1, null),
      row("B", 2, null),
      row("C", 3, null),
      row("D", 4, null),
    ];
    expect(topByPrice(rows, 2).map((r) => r.symbol)).toEqual(["D", "C"]);
  });
});

describe("dashboard page copy (regression: no fabricated market presentation)", () => {
  it("does not claim a market-cap ranking (market cap is not a TTT stats metric)", () => {
    expect(PAGE_SRC().toLowerCase()).not.toContain("market cap");
  });

  it("derives gainers from the strict selector and never coalesces a null change to 0", () => {
    const src = PAGE_SRC();
    expect(src).toContain("topGainers(rows");
    expect(src).toContain("topByPrice(rows");
    expect(src).not.toContain("change24hPct ?? 0");
  });

  it("states the honest empty state when a snapshot has no gainers", () => {
    expect(PAGE_SRC()).toContain("no 24h gainers in this snapshot");
  });
});
