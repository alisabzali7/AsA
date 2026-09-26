/**
 * TEAM 02 browser verification driver (Task 10; release-gate: scenario 4
 * really delays the old response, scenario 6 = upstream failure).
 *
 * Drives the REAL production Next app (`next start`, final code) in headless
 * Chromium. Scenario 0 is LIVE (no interception: shows the app's real state
 * while TTT is unreachable). Scenarios 1-5 intercept ONLY the chart's own
 * market/analysis API calls and answer them with payloads produced by the
 * real server code (generate-fixtures.ts). Every screenshot is written as-is;
 * nothing is edited or annotated afterwards.
 *
 * Run (from the repo root, app on :3000):
 *   LD_LIBRARY_PATH=/tmp/chrlibs/lib node scripts/team02-visual/capture.mjs
 * Needs playwright-core + @sparticuz/chromium resolvable from /tmp/pw.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const require = createRequire("/tmp/pw/package.json");
const { chromium: pw } = require("playwright-core");
const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");

const pkgVersion = (name) => { try { return JSON.parse(readFileSync(`/tmp/pw/node_modules/${name}/package.json`, "utf8")).version; } catch { return null; } };
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const FIX = path.join(ROOT, "FINAL_ARTIFACTS/visual/fixtures");
const SHOTS = path.join(ROOT, "FINAL_ARTIFACTS/visual");
const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
mkdirSync(SHOTS, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(FIX, "manifest.json"), "utf8"));

const log = { started_utc: new Date().toISOString(), app: BASE, scenarios: [] };
const fixture = (name) => {
  const p = path.join(FIX, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

/** intercept only the chart's market/analysis endpoints */
async function installFixtures(page, opts = {}) {
  const served = [];
  await page.route(/\/api\/(market|analysis)\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    let body = null, status = 200;
    if (p === "/api/market/symbols") body = fixture("symbols.json");
    else if (p === "/api/market/focus") body = JSON.stringify({ ok: true, symbol: opts.focus ?? "FIXTUREA" });
    else if (p === "/api/market/candles") body = fixture(`${u.searchParams.get("symbol")}_${u.searchParams.get("tf")}_candles.json`);
    else if (p === "/api/market/history") body = JSON.stringify({ ok: true, candles: [], metadata: { earliest_available: null, earliest_boundary_reached: false } });
    else if (p.startsWith("/api/analysis/mtf/")) body = fixture(`${p.split("/").pop()}_mtf.json`);
    else {
      const m = p.match(/^\/api\/analysis\/([^/]+)\/([^/]+)$/);
      if (m) body = fixture(`${m[1]}_${m[2]}_analysis.json`);
    }
    // endpoints the chart does not own (layout status widgets etc.) go to the real server
    if (body === null) { served.push({ path: p + u.search, passthrough: true }); return route.continue(); }
    const delay = opts.delay?.(p, u) ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    served.push({ path: p + u.search, status, delay });
    await route.fulfill({ status, contentType: "application/json", body });
  });
  return served;
}

async function panelText(page) {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll("div")].filter((d) => /analysis$/.test(d.textContent?.split("\n")[0] ?? ""));
    return document.body.innerText;
  });
}
const canvasCount = (page) => page.evaluate(() => document.querySelectorAll("canvas").length);

async function scenario(browser, name, fn) {
  // explicit locale/timezone: the sandbox's POSIX locale makes headless
  // Chromium report "en-US@posix", which Intl rejects (environment artifact)
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
  const network = [];
  const responses = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    const sameOrigin = u.origin === new URL(BASE).origin;
    responses.push({ status: r.status(), path: u.pathname, same_origin: sameOrigin, type: r.request().resourceType() });
    if (r.status() >= 400) network.push({ status: r.status(), url: u.pathname + u.search });
  });
  page.on("requestfailed", (r) => network.push({ failed: r.failure()?.errorText ?? "failed", url: new URL(r.url()).pathname }));
  const rec = { name, errors, checks: {}, network_errors: network };
  try {
    await fn(page, rec);
  } catch (e) {
    rec.failure = String(e?.stack ?? e);
  }
  rec.errors = errors;
  // Absolute-final: every console error and failed response gets exactly one
  // class from REAL_BUG / EXPECTED_UPSTREAM_FAILURE / TEST_ONLY / THIRD_PARTY /
  // PRE_EXISTING. Anything not positively explained is REAL_BUG (never hidden).
  const netClass = (n) => {
    if (n.failed) return { class: "REAL_BUG", why: `request failed: ${n.failed}` };
    if (n.status === 502 && name.startsWith("6-")) return { class: "TEST_ONLY", why: "502 injected by the driver to simulate an upstream failure (scenario 6)" };
    if (n.status === 503 && /^\/api\/(analysis|market)\//.test(n.url)) return { class: "EXPECTED_UPSTREAM_FAILURE", why: "real production server, TTT market source unreachable from the sandbox (TLS reset) → 503 MARKET_SOURCE_UNAVAILABLE" };
    if (!n.url.startsWith("/")) return { class: "THIRD_PARTY", why: "non-app origin" };
    return { class: "REAL_BUG", why: "not positively explained" };
  };
  rec.network_error_classification = network.map((n) => ({ ...n, ...netClass(n) }));
  // console "Failed to load resource" lines are the browser's echo of a failed
  // response: pair them 1:1 in order with the classified responses
  const failedNet = [...rec.network_error_classification];
  rec.console_error_classification = errors.map((e) => {
    if (/Failed to load resource: the server responded with a status of (\d+)/.test(e)) {
      const st = Number(e.match(/status of (\d+)/)[1]);
      const i = failedNet.findIndex((n) => n.status === st);
      if (i >= 0) { const n = failedNet.splice(i, 1)[0]; return { error: e, class: n.class, why: `browser echo of HTTP ${st} ${n.url} — ${n.why}` }; }
    }
    return { error: e, class: "REAL_BUG", why: "console error not matched to an explained cause" };
  });
  rec.console_errors_understood = rec.console_error_classification.every((c) => c.class !== "REAL_BUG")
    && rec.network_error_classification.every((c) => c.class !== "REAL_BUG");
  rec.network_summary = {
    total_responses: responses.length,
    by_status: responses.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
    api_paths: [...new Set(responses.filter((r) => r.path.startsWith("/api/")).map((r) => `${r.status} ${r.path}`))].sort(),
    third_party_responses: responses.filter((r) => !r.same_origin).length,
  };
  log.scenarios.push(rec);
  await page.close();
  return rec;
}
const check = (rec, k, cond, detail) => { rec.checks[k] = { pass: !!cond, observed: detail ?? null }; };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = await chromium.executablePath();
// --single-process (a Lambda default of @sparticuz/chromium) kills the browser
// when its last page closes; this driver opens one page per scenario
const browser = await pw.launch({ executablePath: exe, args: chromium.args.filter((a) => a !== "--single-process"), headless: true });
log.browser = `Chromium ${browser.version()} (headless, @sparticuz/chromium via playwright-core)`;
log.environment = {
  browser: browser.version(),
  engine: "@sparticuz/chromium (headless) via playwright-core; Playwright CDN is blocked in this sandbox",
  playwright_core: pkgVersion("playwright-core"),
  sparticuz_chromium: pkgVersion("@sparticuz/chromium"),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  locale: "en-US",
  timezone: "UTC",
  app_url: BASE,
  next_build_id: existsSync(path.join(ROOT, ".next/BUILD_ID")) ? readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim() : null,
  interception: "Playwright page.route on /api/(market|analysis)/ serves deterministic FIXTURE JSON; every other request passes through to the real production server",
};

/* 0 — LIVE: no interception, whatever the real app shows right now */
await scenario(browser, "0-live-unavailable", async (page, rec) => {
  await page.goto(`${BASE}/chart`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await settle(6000);
  const text = await panelText(page);
  await page.screenshot({ path: path.join(SHOTS, "scenario-0-live-unavailable.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-0-live-unavailable.png";
  rec.interception = false;
  check(rec, "no candles fabricated", /waiting for real TTT candles|No fabricated candles/.test(text), text.match(/(waiting for real TTT candles…|No fabricated candles[^\n]*)/)?.[0]);
  check(rec, "analysis shows unavailable (not neutral)", /UNAVAILABLE|unavailable/.test(text), text.match(/analysis unavailable[^\n]*|UNAVAILABLE[^\n]*/)?.[0]);
  check(rec, "mtf unavailable surfaced", /MTF unavailable/.test(text), text.match(/MTF unavailable[^\n]*/)?.[0]);
});

/* 1 — NORMAL: FIXTUREA 15m */
await scenario(browser, "1-normal", async (page, rec) => {
  const served = await installFixtures(page);
  await page.goto(`${BASE}/chart`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixturea · 15m analysis"), null, { timeout: 30000 });
  await page.waitForFunction(() => /snapshot [0-9a-f]{14}/.test(document.body.innerText), null, { timeout: 30000 });
  await settle(1500);
  const text = await panelText(page);
  const fp = manifest.symbols.FIXTUREA["15m"].input_fingerprint;
  check(rec, "panel shows the bundle fingerprint of FIXTUREA 15m", text.includes(`snapshot ${fp}`), fp);
  check(rec, "freshness badge from server", /\b(FRESH|STALE|UNAVAILABLE)\b/.test(text), text.match(/(FRESH|STALE)[^\n]*/)?.[0]);
  check(rec, "as-of open + knowable-at close in UTC", /last bar opened .* UTC · knowable at close .* UTC/.test(text), text.match(/last bar opened[^\n]*/)?.[0]);
  check(rec, "EMA lines rendered from server series", /EMA 20 \/ EMA 50 lines/.test(text));
  check(rec, "forming bar disclosed", /drawn translucent with an outline/.test(text));
  check(rec, "source declared fixture", /source=fixture/.test(text) && /FIXTURE/.test(text));
  check(rec, "chart canvases present", (await canvasCount(page)) > 0, await canvasCount(page));
  rec.served = served.length;
  await page.screenshot({ path: path.join(SHOTS, "scenario-1-normal.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-1-normal.png";
});

/* 2 — STRUCTURE-RICH: FIXTUREB 1h (zones, BOS/CHoCH, S/R, fib, EMA, volume, forming bar) */
let finalRec = null;
await scenario(browser, "2-structure-rich", async (page, rec) => {
  const served = await installFixtures(page, { focus: "FIXTUREB" });
  await page.goto(`${BASE}/chart?symbol=FIXTUREB`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixtureb · 15m analysis"), null, { timeout: 30000 });
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixtureb · 1h analysis"), null, { timeout: 30000 });
  const fp = manifest.symbols.FIXTUREB["1h"].input_fingerprint;
  await page.waitForFunction((f) => document.body.innerText.includes(`snapshot ${f}`), fp, { timeout: 30000 });
  await settle(2000);
  const text = await panelText(page);
  const drawn = text.match(/drawn:[^\n]*/)?.[0] ?? "";
  check(rec, "fingerprint of FIXTUREB 1h shown", text.includes(`snapshot ${fp}`), fp);
  check(rec, "structure objects drawn (S/R, fib, FVG/OB, BOS/CHoCH)", /S\/R/.test(drawn) && /BOS\/CHoCH/.test(drawn), drawn);
  check(rec, "semantic disclaimers visible", /historical, not "active"/.test(text) && /not entries/.test(text));
  check(rec, "MTF verdict visible", /PARTIAL|ALIGNED|CONFLICT/.test(text), text.match(/(PARTIAL|ALIGNED|CONFLICT)[^\n]*/)?.[0]);
  const unavail = text.match(/not available \(spec missing[^\n]*/i)?.[0] ?? "";
  check(rec, "spec-missing layers disclosed (trendlines, MACD, liquidity, momentum threshold)", /TRENDLINES_SPEC_LOCKED/i.test(unavail) && /MACD PARAMETERS_UNSPECIFIED/i.test(unavail) && /LIQUIDITY LIQUIDITY_SPEC_UNKNOWN/i.test(unavail) && /MOMENTUM_STRENGTH_THRESHOLD_UNKNOWN/i.test(unavail), unavail);
  check(rec, "no zone/marker left unplaced", !/unplaced:/i.test(text), text.match(/unplaced:[^\n]*/i)?.[0] ?? "none");
  rec.drawn = drawn;
  rec.served = served.length;
  await page.screenshot({ path: path.join(SHOTS, "scenario-2-structure-rich.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-2-structure-rich.png";
  await page.screenshot({ path: path.join(ROOT, "FINAL_ARTIFACTS/team02-final-chart.png") });
  finalRec = { symbol: "FIXTUREB", tf: "1h", fp, text, drawn };
});

/* 3 — INSUFFICIENT HISTORY: FIXTUREC 15m (15 bars) */
await scenario(browser, "3-insufficient-history", async (page, rec) => {
  await installFixtures(page, { focus: "FIXTUREC" });
  await page.goto(`${BASE}/chart?symbol=FIXTUREC`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixturec · 15m analysis"), null, { timeout: 30000 });
  await page.waitForFunction(() => /snapshot [0-9a-f]{14}/.test(document.body.innerText), null, { timeout: 30000 });
  await settle(1500);
  const text = await panelText(page);
  check(rec, "indicators show — (not 0) during warmup", /rsi14\s*\n?\s*—/i.test(text) && /ema20\s*\n?\s*—/i.test(text), text.match(/rsi14[\s\S]{0,20}/i)?.[0]);
  check(rec, "trend undetermined (not neutral/up/down)", /undetermined/.test(text));
  check(rec, "warmup reported as not drawn", /not drawn:.*warmup/.test(text), text.match(/not drawn:[^\n]*/)?.[0]);
  check(rec, "MTF INSUFFICIENT surfaced", /insufficient/i.test(text.match(/multi-timeframe hierarchy[\s\S]*?data truth/i)?.[0] ?? ""));
  await page.screenshot({ path: path.join(SHOTS, "scenario-3-insufficient-history.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-3-insufficient-history.png";
});

/* 4 — TF CHANGE while the OLD timeframe's first response is still in flight.
 * The very first FIXTUREA 15m analysis response is held 6 s; the user switches
 * to 1h ~1 s after that request was issued; 1h answers at once; the stale 15m
 * body then arrives. It must never replace the 1h panel. */
await scenario(browser, "4-tf-change-late-response", async (page, rec) => {
  rec.expected = "1h panel/fingerprint stays after the delayed 15m response lands; 15m fingerprint never shown";
  let held = 0;
  let lateFinished = null;
  const served = await installFixtures(page, {
    delay: (p) => (p === "/api/analysis/FIXTUREA/15m" && held++ === 0 ? 6000 : 0),
  });
  let issuedAt = null;
  page.on("request", (r) => { if (issuedAt === null && new URL(r.url()).pathname === "/api/analysis/FIXTUREA/15m") issuedAt = Date.now(); });
  page.on("requestfinished", (r) => { if (new URL(r.url()).pathname === "/api/analysis/FIXTUREA/15m" && lateFinished === null) lateFinished = Date.now(); });
  await page.goto(`${BASE}/chart`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const fp15 = manifest.symbols.FIXTUREA["15m"].input_fingerprint;
  const fp1h = manifest.symbols.FIXTUREA["1h"].input_fingerprint;
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixturea · 15m analysis"), null, { timeout: 30000 });
  const t0 = Date.now();
  while (issuedAt === null && Date.now() - t0 < 15000) await settle(100);
  await settle(1000);
  const clickedAt = Date.now();
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await page.waitForFunction((f) => document.body.innerText.includes(`snapshot ${f}`), fp1h, { timeout: 30000 });
  const t1 = Date.now();
  while (lateFinished === null && Date.now() - t1 < 15000) await settle(100);
  await settle(1500); // give React a chance to (wrongly) apply the late body
  const text = await panelText(page);
  rec.timeline_ms = { request_15m_issued: 0, switch_clicked: clickedAt - issuedAt, late_15m_finished: lateFinished === null ? null : lateFinished - issuedAt };
  rec.delayed_requests = served.filter((x) => x.delay > 0).map((x) => x.path);
  check(rec, "the 15m response really was delayed and arrived AFTER the switch", rec.delayed_requests.length === 1 && lateFinished !== null && lateFinished > clickedAt, rec.timeline_ms);
  check(rec, "header switched to 1h", text.toLowerCase().includes("fixturea · 1h analysis"));
  check(rec, "1h fingerprint shown after the late 15m response", text.includes(`snapshot ${fp1h}`), fp1h);
  check(rec, "15m fingerprint NOT shown", !text.includes(`snapshot ${fp15}`), fp15);
  await page.screenshot({ path: path.join(SHOTS, "scenario-4-tf-change.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-4-tf-change.png";
});

/* 5 — SYMBOL CHANGE to a sub-cent series (adaptive precision) */
await scenario(browser, "5-symbol-change-subcent", async (page, rec) => {
  await installFixtures(page);
  await page.goto(`${BASE}/chart`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("fixturea · 15m analysis"), null, { timeout: 30000 });
  await page.selectOption('select[aria-label="symbol"]', "FIXTURESUB");
  const fp = manifest.symbols.FIXTURESUB["15m"].input_fingerprint;
  await page.waitForFunction((f) => document.body.innerText.includes(`snapshot ${f}`), fp, { timeout: 30000 });
  await settle(2000);
  const text = await panelText(page);
  const close = text.match(/close\s*\n\s*([0-9.,]+)/i)?.[1] ?? "";
  check(rec, "header switched to FIXTURESUB", text.toLowerCase().includes("fixturesub · 15m analysis"));
  check(rec, "FIXTUREA fingerprint gone", !text.includes(`snapshot ${manifest.symbols.FIXTUREA["15m"].input_fingerprint}`));
  check(rec, "sub-cent close keeps significant digits", /^0\.0000\d{4,}/.test(close), close);
  await page.screenshot({ path: path.join(SHOTS, "scenario-5-symbol-change-subcent.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-5-symbol-change-subcent.png";
});

/* 6 — UPSTREAM FAILURE (F). Interception answers the analysis + MTF routes
 * with the exact body shape the real routes emit on a venue failure (502
 * UPSTREAM_FAILURE). Part a: failing from the first request. Part b: a good
 * response, then the next 30 s poll fails → the panel must say LAST GOOD. */
await scenario(browser, "6-upstream-failure", async (page, rec) => {
  rec.expected = "a: analysis/MTF shown as unavailable with HTTP 502 UPSTREAM_FAILURE, nothing drawn, no neutral values; b: after a good response a failed refresh is labelled LAST GOOD";
  rec.interception_note = "502 bodies are written by this driver in the routes' shape (route code: src/app/api/analysis/*); not produced by the server";
  const upstream = (p) => JSON.stringify(p.startsWith("/api/analysis/mtf/")
    ? { ok: false, symbol: "FIXTUREA", error_class: "UPSTREAM_FAILURE", error: "TTT candle history unavailable for all core timeframes" }
    : { ok: false, available: false, error_class: "UPSTREAM_FAILURE", error: "TTT candle history unavailable: simulated venue failure (browser interception)" });
  let failAll = true, analysisCalls = 0;
  // registered AFTER the fixtures: Playwright gives the newest route priority;
  // fallback() hands everything else to the fixture handler
  await installFixtures(page);
  await page.route(/\/api\/analysis\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const isTf = /^\/api\/analysis\/FIXTUREA\/15m$/.test(p);
    if (isTf) analysisCalls++;
    if (failAll || (isTf && analysisCalls > 1)) return route.fulfill({ status: 502, contentType: "application/json", body: upstream(p) });
    return route.fallback();
  });
  await page.goto(`${BASE}/chart`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => /HTTP 502/.test(document.body.innerText), null, { timeout: 30000 });
  await settle(1500);
  let text = await panelText(page);
  check(rec, "a: analysis unavailable with the typed 502 class", /analysis unavailable \(HTTP 502 UPSTREAM_FAILURE\)/i.test(text), text.match(/analysis unavailable[^\n]*/i)?.[0]);
  check(rec, "a: no snapshot / overlay drawn", !/snapshot [0-9a-f]{14}/.test(text) && !/drawn:/.test(text));
  check(rec, "a: no neutral/zero indicator values shown", !/rsi14\s*\n?\s*50\b/i.test(text));
  check(rec, "a: MTF failure surfaced", /MTF unavailable/i.test(text), text.match(/MTF unavailable[^\n]*/i)?.[0]);
  await page.screenshot({ path: path.join(SHOTS, "scenario-6a-upstream-failure.png") });
  rec.screenshot = "FINAL_ARTIFACTS/visual/scenario-6a-upstream-failure.png";
  // part b — fresh page: first analysis OK, the next poll fails
  failAll = false; analysisCalls = 0;
  await page.goto(`${BASE}/chart`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const fp = manifest.symbols.FIXTUREA["15m"].input_fingerprint;
  await page.waitForFunction((f) => document.body.innerText.includes(`snapshot ${f}`), fp, { timeout: 30000 });
  await page.waitForFunction(() => /LAST GOOD/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
  await settle(1000);
  text = await panelText(page);
  check(rec, "b: failed refresh labelled LAST GOOD, previous snapshot kept and identified", /LAST GOOD/.test(text) && text.includes(`snapshot ${fp}`), text.match(/[A-Z]+ · LAST GOOD[^\n]*/)?.[0]);
  check(rec, "b: a second analysis request was really made and failed", analysisCalls >= 2, analysisCalls);
  await page.screenshot({ path: path.join(SHOTS, "scenario-6b-failed-refresh-last-good.png") });
  rec.screenshot_b = "FINAL_ARTIFACTS/visual/scenario-6b-failed-refresh-last-good.png";
});

await browser.close();
log.finished_utc = new Date().toISOString();
log.final = finalRec ? { symbol: finalRec.symbol, tf: finalRec.tf, fp: finalRec.fp, drawn: finalRec.drawn } : null;
writeFileSync(path.join(SHOTS, "browser-run.json"), JSON.stringify(log, null, 2));
writeFileSync(path.join(SHOTS, "browser-environment.json"), JSON.stringify({ ...log.environment, started_utc: log.started_utc, finished_utc: log.finished_utc }, null, 2));
const allConsole = log.scenarios.flatMap((s) => (s.console_error_classification ?? []).map((c) => ({ scenario: s.name, ...c })));
const countBy = (xs) => xs.reduce((a, x) => ((a[x.class] = (a[x.class] ?? 0) + 1), a), {});
writeFileSync(path.join(SHOTS, "console-summary.json"), JSON.stringify({
  classes: ["REAL_BUG", "EXPECTED_UPSTREAM_FAILURE", "TEST_ONLY", "THIRD_PARTY", "PRE_EXISTING"],
  total: allConsole.length, by_class: countBy(allConsole),
  per_scenario: log.scenarios.map((s) => ({ scenario: s.name, errors: s.errors.length, by_class: countBy(s.console_error_classification ?? []), understood: s.console_errors_understood })),
  errors: allConsole,
}, null, 2));
writeFileSync(path.join(SHOTS, "network-summary.json"), JSON.stringify({
  per_scenario: log.scenarios.map((s) => ({ scenario: s.name, ...s.network_summary, failed: s.network_error_classification })),
}, null, 2));
for (const s of log.scenarios) {
  const bad = Object.entries(s.checks).filter(([, v]) => !v.pass).map(([k]) => k);
  console.log(`${s.name}: ${Object.keys(s.checks).length - bad.length}/${Object.keys(s.checks).length} checks${bad.length ? " FAILED: " + bad.join("; ") : ""}${s.failure ? " FAILURE: " + s.failure.split("\n")[0] : ""} errors=${s.errors.length} understood=${s.console_errors_understood}`);
}
