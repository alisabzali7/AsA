/**
 * CANONICAL BAR VALIDITY (Team 02 absolute-final canonicalisation).
 *
 * One per-bar OHLCV rule shared by every producer/boundary that previously
 * carried its own copy:
 *   - ttt/udf.ts normaliseUdf      (venue normaliser: DROPS the bar, counts it)
 *   - market/history.ts validateCandles (history backfill: DROPS, counts)
 *   - analysis/input.ts barViolation   (analysis boundary: REFUSES the series)
 * The callers keep their own POLICY (drop vs refuse) and their own time rules
 * (alignment, future, ordering); only the bar rule is shared, so a bar can
 * never be valid at one boundary and invalid at another.
 *
 * Rule (as enforced by the venue normaliser since Team 01): finite o/h/l/c/v,
 * strictly positive prices, non-negative volume, high ≥ max(open, close),
 * low ≤ min(open, close). Returns the first defect, or null when valid.
 */
export function ohlcvDefect(k: unknown): string | null {
  if (!k || typeof k !== "object") return "malformed bar";
  const { o, h, l, c, v } = k as Record<string, unknown>;
  for (const [name, x] of [["o", o], ["h", h], ["l", l], ["c", c], ["v", v]] as const) {
    if (typeof x !== "number" || !Number.isFinite(x)) return `non-finite or missing ${name}`;
  }
  const [oo, hh, ll, cc, vv] = [o, h, l, c, v] as number[];
  if (oo <= 0 || hh <= 0 || ll <= 0 || cc <= 0) return "non-positive price";
  if (vv < 0) return "negative volume";
  if (hh < Math.max(oo, cc) || ll > Math.min(oo, cc)) return "incoherent OHLC (high/low do not bound open/close)";
  return null;
}
