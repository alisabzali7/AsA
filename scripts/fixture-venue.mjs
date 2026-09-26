#!/usr/bin/env node
/**
 * FIXTURE VENUE — TTT-shaped test server for local/runtime verification.
 *
 *   node scripts/fixture-venue.mjs [port]        (default 18081)
 *
 * Serves the documented TTT public endpoints from DETERMINISTIC synthetic
 * bars so the full AsA pipeline (transport → normalization → history →
 * persistence → boundary → engine → API) can be exercised end-to-end when the
 * REAL venue is unreachable from the environment.
 *
 * ⚠ REPLAY / FIXTURE — NEVER LIVE TTT.
 * Data served here is synthetic test data. Do not point production at it, do
 * not report its outputs as live market truth, and keep TTT_API_BASE unset
 * (or pointed at apiv2.thetruetrade.io) for production runs.
 *
 * Failure injection via env (runtime failure-path matrix, §24):
 *   MODE=ok          normal operation (default)
 *   MODE=http500     every request answers 500 (5xx is never retried)
 *   MODE=http429     every request answers 429 (rate-limit note fires once)
 *   MODE=malformed   every request answers invalid JSON with a JSON content-type
 *   MODE=emptybody   every request answers an empty body (HTTP 200)
 *   MODE=wrongct     bodies are valid JSON but labelled text/html (transport
 *                    must reject on content-type, never parse-and-continue)
 *   MODE=ok_empty    UDF answers s:"ok" with empty arrays (AMBIGUOUS_EMPTY —
 *                    zero candles alone must never prove a boundary)
 *   MODE=zerorows    UDF bars have step-misaligned timestamps (every row must
 *                    be dropped by normalization; no synthetic repair)
 *   MODE=zeroprice   UDF bars are o=h=l=c=0 AND stats prices are "0"
 *                    (invalid prices must never become truth)
 *   MODE=futurets    UDF bar timestamps are in the future (must be dropped)
 *   MODE=frozen      stats rows carry stale source timestamps (venue freeze)
 *   MODE=slow        every response delayed SLOW_MS (default 1500ms) — used to
 *                    kill/restart a sync mid-flight and inspect the crash window
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 18081);
let MODE = process.env.MODE ?? "ok";
const SLOW_MS = Number(process.env.SLOW_MS ?? 1500);

const SYMBOLS = [
  { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", price: 64000 },
  { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", price: 3200 },
];

const TF_MINUTES = { "1": 1, "5": 5, "15": 15, "30": 30, "45": 45, "60": 60, "120": 120, "240": 240, "480": 480, "1D": 1440 };

/** How far back synthetic history reaches (the fixture's "venue boundary"). */
const HISTORY_DAYS = 7;

function marketRow(s) {
  return {
    symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, category: "crypto",
    name: s.symbol.replace("USDT", ""), tickSize: "0.1", stepSize: "0.001",
    minLeverage: 1, maxLeverage: 50, defaultLeverage: 10, maintenanceMarginRate: "0.005",
    maxPriceImpact: "0.05", leverageTiers: [{ minNotional: "0", maxNotional: "1000000", maxLeverage: 50, maintenanceMarginRate: "0.005" }],
    precisions: ["0.1", "0.001"], isActive: true, makerFeeCoefficient: "0.0002", takerFeeCoefficient: "0.0005",
  };
}

function statsRow(s, now) {
  // MODE=frozen: the venue keeps answering on time but its own row timestamp
  // stopped moving — the classic source-staleness failure.
  const ts = MODE === "frozen" ? new Date(now - 3600_000).toISOString() : new Date(now).toISOString();
  // MODE=zeroprice: the venue answers on time with structurally invalid prices.
  const p = MODE === "zeroprice" ? 0 : s.price;
  return {
    symbol: s.symbol, lastPrice: String(p), markPrice: String(p * 1.0001), indexPrice: String(p * 0.9999),
    fundingRate: "0.0001", nextFundingTime: new Date(now + 8 * 3600_000).toISOString(),
    minFundingRate: "-0.003", maxFundingRate: "0.003", interestRate: "0", fundingIntervalHours: 8,
    change24h: "100", change24hPct: "0.01", high24h: String(p * 1.02), low24h: String(p * 0.98),
    volume24hBase: "1000", volume24hQuote: String(p * 1000), openInterest: "5000",
    openValue: String(p * 5000), turnover24hQuote: String(p * 900), timestamp: ts,
  };
}

function floorTs(ms, stepSec) {
  return Math.floor(ms / 1000 / stepSec) * stepSec;
}

/** Deterministic OHLCV bars for [from,to] at `stepSec`, only below the boundary. */
function udfBars(sym, stepSec, from, to) {
  const end = floorTs(Date.now(), stepSec); // newest bar = currently forming (venue behaviour)
  const boundary = floorTs(Date.now() - HISTORY_DAYS * 86400_000, stepSec);
  const lo = Math.max(from, boundary);
  const hi = Math.min(to, end);
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (let ts = floorTs(lo * 1000, stepSec); ts <= hi; ts += stepSec) {
    if (ts < boundary) continue;
    const base = sym.price * (1 + 0.0004 * Math.sin(ts / (stepSec * 7)));
    const open = base, close = base * 1.0003, high = Math.max(open, close) * 1.001, low = Math.min(open, close) * 0.999;
    t.push(ts); o.push(Number(open.toFixed(2))); h.push(Number(high.toFixed(2)));
    l.push(Number(low.toFixed(2))); c.push(Number(close.toFixed(2))); v.push(10 + (ts % 17));
  }
  return { t, o, h, l, c, v };
}

function send(res, status, body, contentType = "application/json") {
  // MODE=wrongct: keep the body valid JSON but lie about the content-type —
  // transport must reject on the label instead of parsing-and-continuing.
  if (MODE === "wrongct" && contentType === "application/json") contentType = "text/html; charset=utf-8";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // Runtime mode switch (failure-matrix orchestration without restarts).
  // Checked FIRST: never delayed by `slow`, never killed by other modes.
  if (p === "/__setmode") {
    MODE = url.searchParams.get("m") ?? "ok";
    return send(res, 200, { mode: MODE });
  }

  // MODE=slow: hold every answer open (restart/kill window for crash tests).
  if (MODE === "slow") await new Promise((r) => setTimeout(r, SLOW_MS));

  if (MODE === "http500") return send(res, 500, { errors: [{ message: "fixture outage" }] });
  if (MODE === "http429") return send(res, 429, { errors: [{ message: "fixture rate limit" }] });
  if (MODE === "malformed") return send(res, 200, "{not-json", "application/json");
  if (MODE === "emptybody") return send(res, 200, "");

  const now = Date.now();

  if (p === "/futures/markets") return send(res, 200, SYMBOLS.map(marketRow));
  if (p === "/futures/markets/stats") return send(res, 200, SYMBOLS.map((s) => statsRow(s, now)));
  if (p === "/futures/quote-rates") return send(res, 200, [{ quoteAsset: "USDT", rate: "1", timestamp: new Date(now).toISOString() }]);
  if (p === "/futures/markets/trades") {
    const sym = SYMBOLS.find((s) => s.symbol === url.searchParams.get("symbol")) ?? SYMBOLS[0];
    return send(res, 200, { symbol: sym.symbol, trades: [
      { price: String(sym.price), size: "0.5", side: "BID", timestamp: now - 1000 },
      { price: String(sym.price * 1.0001), size: "0.2", side: "ASK", timestamp: now },
    ] });
  }
  if (p === "/futures/markets/orderbook") {
    const sym = SYMBOLS.find((s) => s.symbol === url.searchParams.get("symbol")) ?? SYMBOLS[0];
    return send(res, 200, { symbol: sym.symbol, depthDecimal: 1,
      asks: [{ price: String(sym.price * 1.0002), size: "1", total: "1", count: 1 }],
      bids: [{ price: String(sym.price * 0.9998), size: "1", total: "1", count: 1 }] });
  }
  if (p === "/futures/markets/funding-history") {
    const sym = url.searchParams.get("symbol") ?? "BTCUSDT";
    return send(res, 200, { meta: { totalItems: 2, itemCount: 2, itemsPerPage: 20, totalPages: 1, currentPage: 1 }, items: [
      { calcTime: new Date(now - 8 * 3600_000).toISOString(), symbol: sym, lastFundingRate: "0.0001", markPrice: "64000", minFundingRate: "-0.003", maxFundingRate: "0.003", interestRate: "0", fundingIntervalHours: 8 },
      { calcTime: new Date(now - 16 * 3600_000).toISOString(), symbol: sym, lastFundingRate: "0.0002", markPrice: "63900", minFundingRate: "-0.003", maxFundingRate: "0.003", interestRate: "0", fundingIntervalHours: 8 },
    ] });
  }
  if (p === "/futures/udf/history") {
    const sym = SYMBOLS.find((s) => s.symbol === url.searchParams.get("symbol"));
    if (!sym) return send(res, 200, { s: "no_data" });
    const resolution = url.searchParams.get("resolution") ?? "60";
    const stepSec = (TF_MINUTES[resolution] ?? 60) * 60;
    const from = Number(url.searchParams.get("from") ?? 0);
    const to = Number(url.searchParams.get("to") ?? Math.floor(now / 1000));
    const boundary = floorTs(now - HISTORY_DAYS * 86400_000, stepSec);
    if (to < boundary) return send(res, 200, { s: "no_data" }); // explicit venue boundary
    // MODE=ok_empty: answer s:"ok" with empty arrays — a well-formed success
    // that carries ZERO candles (must never be read as boundary proof).
    if (MODE === "ok_empty") return send(res, 200, { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] });
    const bars = udfBars(sym, stepSec, from, to);
    if (MODE === "zerorows") bars.t = bars.t.map((ts) => ts + 1); // step-misaligned: every row invalid
    if (MODE === "zeroprice") { bars.o = bars.o.map(() => 0); bars.h = bars.h.map(() => 0); bars.l = bars.l.map(() => 0); bars.c = bars.c.map(() => 0); }
    if (MODE === "futurets") bars.t = bars.t.map(() => Math.floor(Date.now() / 1000) + 7200); // in the future: dropped
    if (bars.t.length === 0) return send(res, 200, { s: "no_data" });
    return send(res, 200, { s: "ok", ...bars });
  }
  return send(res, 404, { errors: [{ message: `fixture: no route ${p}` }] });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fixture-venue] REPLAY/FIXTURE server on :${PORT} mode=${MODE} (NOT live TTT)`);
});
