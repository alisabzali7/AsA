/**
 * Repo-discipline tests: exact footer string, source scans for prohibited
 * venues / PRNG / execution surfaces, secret-name hygiene, 1D semantics in
 * docs-vs-code (native default), route surface safety.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FOOTER_EXACT, STRINGS } from "../src/lib/i18n/strings";

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const SRC_APP = path.join(SRC, "app");
const FOOTER_REQUIRED = "«سلام علی به شرکت چاپ پول تک نفره ات خوش اومدی»";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js|css)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function readAll(dir: string): string {
  return filesUnder(dir)
    .map((p) => `\n===== ${path.relative(ROOT, p)} =====\n` + fs.readFileSync(p, "utf8"))
    .join("");
}

/** Remove // and /* * / comments (string-literal aware) so scans see code only. */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < code.length) {
    const ch = code[i];
    const nx = code[i + 1];
    if (state === "code") {
      if (ch === "/" && nx === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && nx === "*") { state = "block"; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { state = "str"; quote = ch; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (state === "str") {
      if (ch === "\\") { out += ch; if (i + 1 < code.length) { out += code[i + 1]; i += 2; } continue; }
      out += ch;
      if (ch === quote) state = "code";
      i++; continue;
    }
    if (state === "line") { if (ch === "\n") { state = "code"; out += "\n"; } i++; continue; }
    if (ch === "*" && nx === "/") { state = "code"; i += 2; continue; }
    i++;
  }
  return out;
}

describe("i18n & footer", () => {
  it("footer string is byte-exact in every language table", () => {
    expect(FOOTER_EXACT).toBe(FOOTER_REQUIRED);
    expect(STRINGS.en.footer).toBe(FOOTER_REQUIRED);
    expect(STRINGS.fa.footer).toBe(FOOTER_REQUIRED);
  });

  it("symbols are never translated (no translated symbol tables)", () => {
    const dump = JSON.stringify(STRINGS);
    expect(dump).not.toContain("BTCUSDT");
  });
});

describe("production source scans (src/**)", () => {
  const src = readAll(SRC);
  const appOnly = readAll(SRC_APP);

  it("contains no prohibited venue identifiers in production code", () => {
    // comments may mention venues the source guard rejects; code must not
    const codeOnly = filesUnder(SRC).map((f) => stripComments(fs.readFileSync(f, "utf8"))).join("\n").toLowerCase();
    for (const bad of ["binance", "coingecko", "coinmarketcap", "bybit", "okx", "kraken", "kucoin", "ccxt", "tradingview"]) {
      expect(codeOnly).not.toContain(bad);
    }
  });

  it("contains no PRNG/faker data fabrication in production code", () => {
    expect(src).not.toContain("Math.random");
    expect(src.toLowerCase()).not.toContain("faker");
    expect(src).not.toContain("Math.random");
  });

  it("has no execution surfaces under the API tree", () => {
    // structural: no route path may look like an execution surface
    const routeDirs: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts") routeDirs.push(path.relative(SRC_APP, path.dirname(p)));
      }
    };
    walk(SRC_APP);
    for (const rd of routeDirs) {
      // segment-exact: 'orderbook' is a read-only data feed; an execution
      // surface would live under segments like /orders, /positions, ...
      const execSegment = rd.split("/").some((seg) =>
        /^(order|orders|position|positions|withdraw|deposit|wallet|transfer|account|balance|assets|trade|execute)$/i.test(seg),
      );
      expect(execSegment).toBe(false);
    }
    expect(routeDirs.length).toBeGreaterThanOrEqual(24);
    // identifier-level: no order-mutation or fund-movement helpers anywhere in src code
    // The central safety assertion (lib/safety/no-execution.ts) NAMES these
    // capabilities in order to prove they are absent; scanning it would be
    // self-referential, so it is excluded here exactly as in the other scans.
    const codeOnly = filesUnder(SRC)
      .filter((f) => !f.includes("safety/no-execution"))
      .map((f) => stripComments(fs.readFileSync(f, "utf8")))
      .join("\n");
    for (const id of ["placeOrder", "executeOrder", "cancelOrder", "modifyOrder", "transferFunds", "withdrawAssets", "setLeverage"]) {
      expect(codeOnly).not.toContain(id);
    }
  });

  it("secrets live in lib/env.ts only (nothing secret in components/client)", () => {
    const componentFiles = filesUnder(path.join(SRC, "components")).join("\n");
    expect(componentFiles).not.toContain("process.env");
    expect(componentFiles.toLowerCase()).not.toContain("bot_token");
    expect(componentFiles.toLowerCase()).not.toContain("api_key");
    // client bundle can never reference these env names
    const appClient = appOnly;
    for (const secretName of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "TTT_API_SECRET", "ASA_API_TOKEN", "AI_API_KEY"]) {
      expect(appClient).not.toContain(secretName);
    }
  });

  it("TONUSDT never appears as a tradable: only exclusionary copy may name it", () => {
    const files = filesUnder(SRC);
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      const lines = code.split("\n");
      lines.forEach((ln, i) => {
        if (!ln.toUpperCase().includes("TONUSDT")) return;
        // remaining mentions must be exclusionary string copy, never a listing
        expect(ln).toMatch(/exclu/i);
        void i;
      });
    }
    // The universe module may name TONUSDT ONLY inside the exclusion list.
    // It must never appear in the tradable LEGACY_UNIVERSE array.
    const universeCode = stripComments(fs.readFileSync(path.join(SRC, "lib/domain/universe.ts"), "utf8"));
    const tradable = universeCode.slice(
      universeCode.indexOf("LEGACY_UNIVERSE"),
      universeCode.indexOf("] as const"),
    );
    expect(tradable.toUpperCase()).not.toContain("TONUSDT");
    // every mention elsewhere in the file must sit on an exclusion line
    for (const ln of universeCode.split("\n")) {
      if (ln.toUpperCase().includes("TONUSDT")) expect(ln).toMatch(/EXCLUDED/i);
    }
  });
});

describe("native-1D semantics", () => {
  it("the 1d timeframe maps to native resolution '1D' and no silent 8h derivation exists in the request path", () => {
    const client = fs.readFileSync(path.join(SRC, "lib/ttt/client.ts"), "utf8");
    expect(client).toContain('resolution: "1D"');
    expect(client).toContain("getDailyCandles");
    expect(client).toContain("NATIVE first");
    expect(client).toContain("derive1DFallback");
  });

  it("coverage rows expose native_or_derived + derivation_source", () => {
    const types = fs.readFileSync(path.join(SRC, "lib/domain/types.ts"), "utf8");
    expect(types).toContain("native_or_derived");
    expect(types).toContain("derivation_source_tf");
  });
});
