/** Optional browser QA. First exercise the real API/empty state; intercepted
 * failure/partial states below are TEST FIXTURES ONLY, never persisted or sent.
 * Run with PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE when installed externally.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.env.ASA_QA_URL ?? "http://127.0.0.1:3000";
const output = process.env.ASA_QA_OUTPUT_DIR ?? "_verify/team05-ui";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];
const errors = [];
const record = (name, evidence) => results.push({ name, status: "PASS", evidence });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const response = await page.request.get(`${base}/api/signals`);
  assert.equal(response.status(), 200);
  const real = await response.json();
  assert.equal(real.ok, true);
  await page.goto(`${base}/signals`);
  if (real.items.length === 0) await page.getByText("No signals yet.", { exact: false }).waitFor();
  assert.match(await page.locator("body").innerText(), /ADVISORY ONLY/);
  await page.screenshot({ path: path.join(output, "real-desktop.png"), fullPage: true });
  record("real API → empty/success UI", { http: 200, real_signal_count: real.items.length });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile horizontal overflow");
  await page.getByRole("button", { name: "switch language", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl");
  await page.screenshot({ path: path.join(output, "real-mobile-rtl.png"), fullPage: true });
  record("390px mobile + Persian/RTL", "no horizontal overflow; language button switches dir=rtl");

  // Isolated browser context: these fixtures do not alter the running server.
  const qa = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const test = await qa.newPage();
  test.on("pageerror", (e) => errors.push(e.message));
  await test.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    const label = document.createElement("div"); label.textContent = "TEST ONLY — browser-intercepted failure/state fixture, not live evidence";
    label.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#78350f;color:white;padding:10px;text-align:center;font:12px sans-serif";
    document.body.append(label);
  }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let mode = "loading";
  const fixture = { ok: true, items: [{ id: "TEST-ONLY-partial", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "TEST ONLY", created_ms: 1, updated_ms: 1, opp_id: "TEST-ONLY-opportunity", delivery: { delivery_state: "FAILED", outbox_id: 1, attempts: 1, error: "TEST ONLY: text rejected", link: "outbox_id", progress: { photo_required: true, photo_sent: true, text_sent: false } } }] };
  await test.route("**/api/signals?*", async (route) => {
    if (mode === "loading") await gate;
    if (mode === "error") return route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"error":"TEST ONLY"}' });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
  });
  await test.goto(`${base}/signals`);
  await test.getByText("Loading advisory signals…", { exact: true }).waitFor();
  assert.equal(await test.getByText("No signals yet.", { exact: false }).count(), 0);
  await test.screenshot({ path: path.join(output, "test-only-loading.png"), fullPage: true });
  record("loading is not empty success", "delayed API test interception");
  mode = "error"; release();
  await test.getByRole("alert").filter({ hasText: "Signals unavailable" }).waitFor();
  assert.equal(await test.getByText("No signals yet.", { exact: false }).count(), 0);
  await test.screenshot({ path: path.join(output, "test-only-error.png"), fullPage: true });
  record("HTTP 503 → visible error", "test interception; not reported as empty");

  mode = "partial";
  await test.reload();
  await test.getByText("delivery FAILED", { exact: true }).waitFor();
  assert.equal(await test.getByText("delivery SENT", { exact: true }).count(), 0);
  assert.match(await test.locator("body").innerText(), /chart accepted · text pending/);
  assert.equal(await test.getByRole("link", { name: "Signal provenance" }).getAttribute("href"), "/api/signals/TEST-ONLY-partial");
  await test.screenshot({ path: path.join(output, "test-only-partial.png"), fullPage: true });
  record("partial delivery + provenance", "test-only photo accepted/text pending; never SENT");

  await test.clock.install();
  mode = "error";
  await test.clock.fastForward(31_000);
  await test.getByRole("alert").filter({ hasText: "last received state" }).waitFor();
  // fastForward intentionally coalesces intervals; advance age one tick at a time.
  await test.clock.runFor(31_000);
  await test.getByText("STALE — last successful signal refresh", { exact: false }).waitFor();
  await test.screenshot({ path: path.join(output, "test-only-stale.png"), fullPage: true });
  record("failed refresh preserves explicitly stale cached state", "test clock and HTTP failure; delivery remains FAILED");
  await qa.setOffline(true);
  await test.getByText("OFFLINE", { exact: false }).first().waitFor();
  await test.screenshot({ path: path.join(output, "test-only-offline.png"), fullPage: true });
  record("offline", "browser offline mode produces explicit offline state");
  assert.deepEqual(errors, []);
  record("browser runtime", "zero uncaught page errors across real and injected scenarios");
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ results, errors, note: "No market/Telegram provider success claimed; all nonempty signal UI states were intercepted test fixtures." }, null, 2));
  console.log(JSON.stringify({ checks: results.length, results, errors }, null, 2));
} finally { await browser.close(); }
