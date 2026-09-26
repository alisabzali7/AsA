/**
 * Reusable primitives + feature specs.
 *
 * CRITICAL HONESTY RULE: `availability` reflects what TTT actually provides,
 * measured during earlier live probes and recorded in the project README /
 * capability report:
 *   MEASURED    - TTT returns the field directly
 *   DERIVED     - computed deterministically from MEASURED data
 *   PROXY       - approximated with UNVERIFIED semantics; must be labeled
 *   UNAVAILABLE - not exposed by verified public TTT; feature disables itself
 *
 * A feature marked UNAVAILABLE must never be silently substituted from another
 * exchange, and must never be fabricated. Detectors pointing at real code are
 * named in `detector`; a null detector means "not yet implemented" and the
 * dependent rule cannot be executable.
 */
import type { FeatureSpec, Primitive } from "./types";

const R = (file: string, line: number, quote: string) => ({ file, start_line: line, end_line: line, quote });

export function buildPrimitives(): Primitive[] {
  const p = (
    id: string, kind: Primitive["kind"], name: string, desc: string,
    detector: string | null, availability: Primitive["availability"],
    aliases: string[] = [], unavailable_reason: string | null = null,
  ): Primitive => ({
    primitive_id: id, kind, canonical_name: name, description: desc, aliases,
    source_refs: [], source_status: "SOURCE_VERIFIED", detector, availability, unavailable_reason,
  });

  return [
    // structure
    p("PRM-SWING", "structure", "Swing high/low", "Fractal pivot highs and lows over a lookback window.", "analysis/structure:findSwings", "DERIVED", ["پیوت", "سقف/کف"]),
    p("PRM-TREND", "structure", "Trend state", "Trend classification from swing sequence and EMA alignment.", "analysis/structure:classifyTrend", "DERIVED", ["روند"]),
    p("PRM-BOS", "structure", "Break of structure", "Close beyond the prior swing in trend direction.", "analysis/structure:structureEvents", "DERIVED", ["شکست ساختار"]),
    p("PRM-CHOCH", "structure", "Change of character", "First counter-trend structural break.", "analysis/structure:structureEvents", "DERIVED", ["CHOCH", "تغییر کرکتر", "QM"]),
    p("PRM-RANGE", "structure", "Range / consolidation", "Bounded price region with repeated rejections at both edges.", null, "DERIVED", ["رنج"]),
    p("PRM-IMPULSE", "structure", "Impulse leg", "Directional expansion leg preceding a correction.", null, "DERIVED", ["موج ایمپالس"]),

    // levels
    p("PRM-SR", "level", "Support / resistance", "Horizontal levels from clustered swing touches.", "analysis/structure:clusterSwingLevels", "DERIVED", ["حمایت", "مقاومت"]),
    p("PRM-PRZ", "level", "Potential reversal zone", "Confluence band of levels/fib/structure.", null, "DERIVED", ["PRZ"]),
    p("PRM-ROUND", "level", "Round / psychological number", "Round price levels used as magnet/《sentimental》 levels.", null, "DERIVED", ["اعداد رند"]),

    // candles
    p("PRM-BODY", "candle", "Body/wick ratio", "Candle body vs total range and wick proportions.", "features/detectors:candleAnatomy", "DERIVED"),
    p("PRM-PINBAR", "candle", "Pin bar", "Long-wick rejection candle meeting corpus size rules.", "features/detectors:detectPinbar", "DERIVED", ["پین بار"]),
    p("PRM-REJECTION", "candle", "Rejection", "Wick rejection at a level.", "features/detectors:detectRejectionAt", "DERIVED"),

    // indicators
    p("PRM-RSI", "indicator", "RSI state", "RSI(14) value and overbought/oversold zone state.", "analysis/indicators:rsi", "DERIVED", ["RSI", "اشباع"]),
    p("PRM-MACD", "indicator", "MACD state", "MACD line/signal/histogram state (parameters not in source: OPEN SPECIFICATION).", null, "DERIVED", ["مکدی"]),
    p("PRM-MA", "indicator", "MA alignment", "EMA20/EMA50 (and configured MAs) relative alignment.", "analysis/indicators:ema", "DERIVED", ["مووینگ"]),
    p("PRM-ICHIMOKU", "indicator", "Ichimoku state", "Tenkan/Kijun/cloud relationships.", null, "DERIVED", ["ایچیموکو"]),
    p("PRM-ATR", "volatility", "ATR", "Average true range (14) absolute and % of price.", "analysis/indicators:atr", "DERIVED"),
    p("PRM-MOMENTUM", "momentum", "Momentum", "Slope/strength of the last swing leg, judged relative to prior legs (RAW_4:1193/1196); strength thresholds are OPEN SPECIFICATION.", "analysis/momentum:legMomentum", "DERIVED", ["مومنتوم"]),
    p("PRM-DIVERGENCE", "divergence", "Divergence", "Price vs RSI swing divergence (regular bullish/bearish, hidden bullish; RAW_1:891/892/899). PARTIAL: MACD confirmation (RAW_1:787) not implemented.", "analysis/divergence:detectRsiDivergences", "DERIVED", ["واگرایی", "دایورجنس"]),

    // fib / harmonic / smc
    p("PRM-FIB", "fibonacci", "Fibonacci levels", "Retracement levels of the last confirmed alternating swing leg.", "analysis/structure:fibOfLastLeg", "DERIVED", ["فیبوناچی"]),
    p("PRM-HARMONIC", "harmonic", "Harmonic structure", "AB=CD and ratio-based harmonic patterns.", null, "DERIVED", ["هارمونیک", "AB=CD"]),
    p("PRM-OB", "smc", "Order block", "Last opposing candle before a structural break (RAW_5:679/957).", "analysis/structure:findOrderBlocks", "DERIVED", ["اردر بلاک"]),
    p("PRM-RB", "smc", "Rejection block", "Wick-defined block left by aggressive rejection.", null, "DERIVED", ["رجکشن بلاک"]),

    // regime & market data
    p("PRM-REGIME", "regime", "Market regime", "Volatility regime (ATR expansion/compression vs its average); trending/ranging is PRM-TREND.", "features/detectors:detectVolatilityRegime", "DERIVED"),
    p("PRM-FUNDING", "regime", "Funding rate", "Perp funding rate and history.", "ttt/client:getStats", "MEASURED"),
    p("PRM-OI", "regime", "Open interest", "Current OI (measured); OI delta derived from AsA snapshot ring.", "ttt/client:getStats", "MEASURED"),
    p("PRM-BASIS", "regime", "Mark/index basis", "Mark vs index spread.", "ttt/client:getStats", "DERIVED"),
    p("PRM-BOOK", "liquidity", "Order book imbalance", "Top-of-book spread and depth imbalance (focus lane).", "ttt/client:getOrderBook", "MEASURED"),
    p("PRM-TAPE", "liquidity", "Trade tape flow", "Aggressor-side flow from the trade tape.", "ttt/client:getTrades", "PROXY", ["تیک"],
      "TTT trade payload does not expose verified BID/ASK aggressor semantics; side inference is UNVERIFIED and labeled PROXY"),
    p("PRM-LIQUIDATION", "liquidity", "Liquidation pressure", "Liquidation clusters / forced-flow pressure.", null, "UNAVAILABLE", ["لیکوییدیشن"],
      "no documented public TTT liquidation endpoint; never estimated from unverified data"),
    p("PRM-LSRATIO", "liquidity", "Long/short ratio", "Crowd positioning ratio.", null, "UNAVAILABLE", [],
      "not exposed by verified public TTT interface"),
    p("PRM-CVD", "liquidity", "Cumulative volume delta", "Signed cumulative delta of aggressor volume.", null, "UNAVAILABLE", [],
      "requires verified aggressor semantics which TTT does not document"),
  ];
}

export function buildFeatures(): FeatureSpec[] {
  const f = (
    id: string, primitive: string, name: string, formula: string, inputs: string[],
    tfs: string[], lookback: number | null, minBars: number,
    availability: FeatureSpec["availability"], edge: string[] = [],
    unavailable_reason: string | null = null,
  ): FeatureSpec => ({
    feature_id: id, primitive_id: primitive, canonical_name: name, formula, inputs,
    timeframes: tfs, lookback,
    data_quality: { min_bars: minBars, max_staleness_ms: 15 * 60_000 },
    edge_cases: edge, availability, unavailable_reason, source_refs: [],
  });

  const CORE = ["15m", "1h", "4h"];
  return [
    f("FTR-RSI14", "PRM-RSI", "RSI(14)", "Wilder RSI over 14 closes", ["close"], CORE, 14, 100, "DERIVED",
      ["flat series -> RSI undefined, returns null", "fewer than 15 bars -> null"]),
    f("FTR-RSI-ZONE", "PRM-RSI", "RSI zone", "overbought >= 70, oversold <= 30 (corpus thresholds)", ["FTR-RSI14"], CORE, 14, 100, "DERIVED",
      ["thresholds are SOURCE values, not optimized"]),
    f("FTR-EMA20", "PRM-MA", "EMA(20)", "exponential MA, alpha=2/21", ["close"], CORE, 20, 100, "DERIVED"),
    f("FTR-EMA50", "PRM-MA", "EMA(50)", "exponential MA, alpha=2/51", ["close"], CORE, 50, 100, "DERIVED"),
    f("FTR-MA-ALIGN", "PRM-MA", "MA alignment", "sign(EMA20-EMA50) with flat band = 0.05% of price", ["FTR-EMA20", "FTR-EMA50"], CORE, 50, 100, "DERIVED"),
    f("FTR-ATR14", "PRM-ATR", "ATR(14)", "Wilder ATR of true range", ["high", "low", "close"], CORE, 14, 100, "DERIVED"),
    f("FTR-ATRPCT", "PRM-ATR", "ATR %", "ATR14 / close * 100", ["FTR-ATR14", "close"], CORE, 14, 100, "DERIVED"),
    f("FTR-SWINGS", "PRM-SWING", "Swing points", "fractal pivots with configurable strength", ["high", "low"], CORE, 50, 100, "DERIVED",
      ["low-volatility series can yield zero swings"]),
    f("FTR-TREND", "PRM-TREND", "Trend state", "swing sequence (HH/HL vs LH/LL) confirmed by MA alignment", ["FTR-SWINGS", "FTR-MA-ALIGN"], CORE, 50, 100, "DERIVED",
      ["conflicting swing/MA evidence -> 'range'", "missing swings or EMA50 warmup -> 'undetermined' (never 'range')"]),
    f("FTR-BOS", "PRM-BOS", "Break of structure", "close beyond prior swing extreme in trend direction", ["FTR-SWINGS", "close"], CORE, 50, 100, "DERIVED"),
    f("FTR-CHOCH", "PRM-CHOCH", "Change of character", "first close beyond opposing swing after a trend leg", ["FTR-SWINGS", "close"], CORE, 50, 100, "DERIVED"),
    f("FTR-SR", "PRM-SR", "S/R levels", "clustered swing touches within ATR-scaled tolerance", ["FTR-SWINGS", "FTR-ATR14"], CORE, 100, 100, "DERIVED"),
    f("FTR-FIB", "PRM-FIB", "Fibonacci retracement", "levels 0/0.236/0.382/0.5/0.618/0.786/1 of the last confirmed alternating swing leg (0 = leg end)", ["FTR-SWINGS"], CORE, 50, 100, "DERIVED",
      ["undefined when no alternating confirmed leg exists"]),
    f("FTR-PINBAR", "PRM-PINBAR", "Pin bar", "wick >= 2x body AND body <= 1/3 range AND size > prior candles (corpus rule 4)", ["open", "high", "low", "close"], CORE, 3, 50, "DERIVED",
      ["equal-size pinbars vs prior candles are INVALID per corpus RAW_4"]),
    f("FTR-FUNDING", "PRM-FUNDING", "Funding rate", "TTT /futures/markets/stats fundingRate", ["ttt.stats"], ["*"], null, 0, "MEASURED"),
    f("FTR-OI", "PRM-OI", "Open interest", "TTT /futures/markets/stats openInterest", ["ttt.stats"], ["*"], null, 0, "MEASURED"),
    f("FTR-OI-DELTA", "PRM-OI", "OI delta", "difference across AsA snapshot ring samples", ["FTR-OI"], ["*"], null, 0, "DERIVED",
      ["requires >= 2 snapshots; otherwise UNAVAILABLE with reason"]),
    f("FTR-BOOK-IMB", "PRM-BOOK", "Depth imbalance", "(bidDepth-askDepth)/(bidDepth+askDepth) top N levels", ["ttt.orderbook"], ["*"], null, 0, "MEASURED",
      ["focus-symbol lane only; other symbols report UNAVAILABLE(reason=not in focus lane)"]),
    f("FTR-TAPE-FLOW", "PRM-TAPE", "Tape flow", "signed trade flow inferred from tape", ["ttt.trades"], ["*"], null, 0, "PROXY",
      ["aggressor side UNVERIFIED — must be displayed as PROXY, never as measured buy/sell volume"]),
    f("FTR-LIQ", "PRM-LIQUIDATION", "Liquidation pressure", "N/A", [], ["*"], null, 0, "UNAVAILABLE", [],
      "no documented public TTT liquidation endpoint"),
    f("FTR-LSR", "PRM-LSRATIO", "Long/short ratio", "N/A", [], ["*"], null, 0, "UNAVAILABLE", [],
      "not exposed by verified public TTT interface"),
    f("FTR-CVD", "PRM-CVD", "CVD", "N/A", [], ["*"], null, 0, "UNAVAILABLE", [],
      "requires verified aggressor semantics TTT does not document"),
  ];
}
