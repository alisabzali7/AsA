/**
 * Team 04 provider-boundary contract (regression locks).
 *
 * These source-level scans keep the normalized state model from silently
 * degrading later (the same "contracts in comments drift unless tested"
 * discipline the repo already applies in ai-clone.test.ts):
 *
 *  1. the polling provider classifies failures through resource-state and
 *     NEVER drops the server's structured verdict (no bare `throw new Error`
 *     on non-2xx);
 *  2. every primary data surface consumes the normalized status (TruthState),
 *     so UNAVAILABLE can never regress into "loading…" or a fake EMPTY;
 *  3. the settings form hydrates from server prefs — no fabricated defaults;
 *  4. no production component may import mock/fixture data;
 *  5. the palette's symbol source is the live universe endpoint, never a
 *     hardcoded symbol list.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("provider layer", () => {
  const hooks = read("src/components/hooks.tsx");

  it("usePoll classifies through the normalized resource-state layer", () => {
    expect(hooks).toContain("loadResource");
    expect(hooks).toContain('status: ResourceStatus');
  });

  it("a non-2xx response is parsed for its structured verdict, never swallowed", () => {
    // the old shape threw on !r.ok, destroying the server's state/reason
    expect(hooks).not.toMatch(/if \(!r\.ok\) throw/);
    expect(read("src/components/resource-state.ts")).toContain("parseFailureBody");
  });

  it("failure never clears the last authoritative payload (cached-not-live, not fake-fresh)", () => {
    // the failure branch must not clear the retained payload and must carry
    // the server's verdict through (merged setSnap architecture — same guard)
    const fail = hooks.match(/} else \{[^]*?\n      \}/)?.[0] ?? "";
    expect(fail).not.toContain("setData(null)");
    expect(fail).toMatch(/data: p\.url === url \? p\.data : null/);
    expect(fail).toContain("status: r.status");
  });

  it("mutations attach the operator token and surface denials (no silent catch-all)", () => {
    expect(hooks).toContain("x-asa-token");
    expect(hooks).toContain("offline — request not sent");
  });
});

describe("surfaces consume the state model", () => {
  const surfaces = [
    "src/app/page.tsx",
    "src/app/opportunities/page.tsx",
    "src/app/signals/page.tsx",
    "src/app/psychology/page.tsx",
    "src/app/backtest/page.tsx",
    "src/app/system/page.tsx",
    "src/app/ai-clone/page.tsx",
    "src/app/fundamental/page.tsx",
    "src/app/ai/page.tsx",
    "src/components/market-board.tsx",
    "src/components/chart-view.tsx",
  ];
  for (const f of surfaces) {
    it(`${f} renders normalized provider states`, () => {
      const s = read(f);
      expect(s, `${f} must import the shared state primitive`).toContain("data-state");
      expect(s, `${f} must render TruthState (UNAVAILABLE/ERROR/OFFLINE/LOADING)`).toContain("<TruthState");
    });
  }

  it("no production component imports fixtures or mocks", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(ROOT, "src", "app"));
    walk(path.join(ROOT, "src", "components"));
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from ["'].*(mock|fixture|fake)/i);
    }
  });
});

describe("settings truth", () => {
  it("risk/AI forms hydrate from server prefs instead of fabricated defaults", () => {
    const s = read("src/app/settings/page.tsx");
    expect(s).not.toContain('useState("10000")');
    expect(s).not.toContain('useState("5")');
    expect(s).toContain("prefs");
  });
});

describe("palette truth", () => {
  it("symbol entries come from the live universe endpoint, not a hardcoded list", () => {
    const s = read("src/components/palette.tsx");
    expect(s).toContain("/api/market/symbols");
    expect(s).not.toContain('"BTCUSDT", "ETHUSDT"');
    // and it says so when there is no universe to offer
    expect(s).toContain("symbolsEmpty");
  });
});
