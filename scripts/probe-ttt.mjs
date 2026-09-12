#!/usr/bin/env node
/**
 * Live TTT PUBLIC-endpoint probe (evidence tooling, not app code).
 *
 *   node scripts/probe-ttt.mjs
 *
 * Uses only safe GET requests against the public market-data surface the
 * engine consumes. One summary line per endpoint: HTTP status + latency +
 * a shape fingerprint (row counts, keys, duplicate-tail detection, ...).
 * Auth/private endpoints (orders, positions, ...) are intentionally NOT
 * probed: session scope is public endpoints only, and the HMAC signing
 * scheme is unverified — no guesswork headers are ever sent.
 */
const BASE = process.env.TTT_API_BASE ?? "https://apiv2.thetruetrade.io";
const OUT = [];
let failures = 0;

async function probe(name, uri) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + uri, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-JSON */ }
    const line = `${String(res.status).padEnd(4)} ${ms.toString().padStart(6)}ms  ${name.padEnd(36)} ${fingerprint(j, text)}`;
    OUT.push(line);
    if (res.status >= 400) failures++;
  } catch (e) {
    failures++;
    OUT.push(`ERR            ${name.padEnd(36)} ${e instanceof Error ? e.message : String(e)}`);
  }
}

function fingerprint(j, text) {
  if (!j) return `non-JSON ${text.slice(0, 70).replace(/\n/g, " ")}`;
  if (j.errors && Array.isArray(j.errors)) {
    const m = j.errors[0]?.message ?? "";
    return `errors[${j.errors.length}] ${String(m).slice(0, 90)}`;
  }
  if (Array.isArray(j)) {
    const first = j[0];
    const keys = first && typeof first === "object" ? Object.keys(first).join(",").slice(0, 110) : typeof first;
    return `array[${j.length}] keys: ${keys}`;
  }
  const keys = Object.keys(j).join(",").slice(0, 110);
  const arrKeys = Object.keys(j).filter((k) => Array.isArray(j[k]));
  const counts = arrKeys.map((k) => `${k}:${j[k].length}`).join(" ");
  const s = typeof j.s === "string" ? ` s=${j.s}` : "";
  const extra =
    typeof j.t === "object" && Array.isArray(j.t)
      ? ` t[${j.t.length}] first=${j.t[0]} last=${j.t[j.t.length - 1]}${j.t.length > 1 && j.t[j.t.length - 1] === j.t[j.t.length - 2] ? " DUP-TAIL" : ""}`
      : "";
  return `object keys: ${keys}${counts ? ` counts(${counts})` : ""}${s}${extra}`;
}

async function main() {
  const SYM = "BTCUSDT";
  const now = Math.floor(Date.now() / 1000);
  const from = now - 3600 * 24 * 3;
  const probes = [
    ["markets/stats (full universe)", "/futures/markets/stats"],
    ["markets (list)", "/futures/markets?symbol=" + SYM],
    ["orderbook " + SYM, `/futures/markets/orderbook?symbol=${SYM}`],
    ["trades " + SYM, `/futures/markets/trades?symbol=${SYM}`],
    ["quote-rates " + SYM, `/futures/quote-rates?symbol=${SYM}`],
    ["funding-history " + SYM, `/futures/markets/funding-history?symbol=${SYM}&page=1&limit=5`],
    ["udf 15m " + SYM, `/futures/udf/history?symbol=${SYM}&resolution=15&from=${from}&to=${now}&countback=700`],
    ["udf 1D " + SYM, `/futures/udf/history?symbol=${SYM}&resolution=1D&from=${now - 86400 * 45}&to=${now}&countback=60`],
    ["udf unknown symbol", `/futures/udf/history?symbol=NOPEUSDT&resolution=15&from=${from}&to=${now}`],
  ];
  console.log(`TTT public probe  base=${BASE}  ${new Date().toISOString()}`);
  console.log("-".repeat(104));
  for (const [name, uri] of probes) await probe(name, uri);
  console.log("-".repeat(104));
  console.log(OUT.join("\n"));
  console.log(`\nfailures=${failures}  endpoints=${probes.length}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
