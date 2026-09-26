/**
 * Cinematic rebuild governance — locks the rules this pass established so
 * future work cannot silently regress them:
 *
 *  · motion is centralized: keyframes/easings exist ONLY in the design layer
 *  · state vocabulary is centralized: no page may re-define shell primitives
 *  · RTL correctness: logical properties only, no physical left/right in rows
 *  · anti-fabrication: no fake LIVE verdicts, no placeholder zeros (§77)
 *  · route transitions never remount the shell
 *  · reduced-motion is wired to both the OS setting and the product toggle
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = join(dir, e);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const PAGES = walk("src/app").filter((p) => p.endsWith("page.tsx"));

describe("motion system is centralized (design layer owns all keyframes)", () => {
  it("@keyframes and cubic-bezier are declared only in globals.css", () => {
    const tsx = [...walk("src/app"), ...walk("src/components")];
    for (const f of tsx) {
      const s = read(f);
      expect(s, `${f} must not define @keyframes`).not.toMatch(/@keyframes/);
      expect(s, `${f} must not hand-roll easing curves`).not.toMatch(/cubic-bezier\(/);
    }
  });

  it("globals.css carries the four motion tiers and honors reduced motion twice", () => {
    const css = read("src/app/globals.css");
    for (const tier of ["--t-micro", "--t-short", "--t-med", "--t-long"]) expect(css).toContain(tier);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain('html[data-motion="reduced"]');
    // entrance animations are opacity+transform only (compositor-safe)
    expect(css).toMatch(/@keyframes asa-rise[\s\S]{0,120}opacity[\s\S]{0,120}transform/);
  });

  it("reduced-motion preference persists per-device and applies pre-paint", () => {
    expect(read("src/components/selection.tsx")).toContain('makePref<"full" | "reduced">("asa-motion"');
    expect(read("src/app/layout.tsx")).toContain('localStorage.getItem("asa-motion")');
  });
});

describe("state vocabulary is centralized (design system governance)", () => {
  it("no page re-defines shell primitives", () => {
    for (const f of PAGES) {
      const s = read(f);
      expect(s, `${f} defines its own StatusChip`).not.toMatch(/function (StatusChip|StatusBadge|TruthState|PageHead|Panel)\(/);
    }
  });
  it("StatusChip is one alias over StatusBadge (icon + word, never color alone)", () => {
    const s = read("src/components/ui.tsx");
    expect(s).toContain("export const StatusChip = StatusBadge");
    expect(s).toMatch(/title=\{state\}/); // raw machine state always disclosed
  });
});

describe("RTL discipline — logical properties only", () => {
  it("pages and the chart workspace use no physical direction utilities", () => {
    const files = [...PAGES, "src/components/chart-view.tsx", "src/components/chrome.tsx", "src/components/market-board.tsx"];
    for (const f of files) {
      const s = read(f);
      expect(s, `${f} uses physical padding`).not.toMatch(/className="[^"]*\b(pl|pr)-\d/);
      expect(s, `${f} uses physical margins`).not.toMatch(/className="[^"]*\b(ml|mr)-\d[^"]*"/);
      expect(s, `${f} uses physical alignment`).not.toMatch(/className="[^"]*\btext-(left|right)\b/);
    }
  });
  it("the writing-mode-aware motion follows direction from CSS, not JS", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/html\[dir="rtl"\] \.drawer-panel/);
    // Persian drops the uppercase letter-spacing that breaks cursive joining
    expect(css).toMatch(/html\[lang="fa"\][\s\S]{0,120}letter-spacing: 0/);
  });
});

describe("anti-fabrication locks (mission §77)", () => {
  it("Home's LIVE verdict is gated by the re-derived sweep age, never by data presence", () => {
    const s = read("src/app/page.tsx");
    // the verdict variable is defined ONLY from readiness AND elapsed age —
    // not from "we received something" and not from row counts
    expect(s).toMatch(/const marketLive = boardReady && sweepEff !== null && sweepEff < 30000/);
    expect(s).toContain("STALE/DEGRADED");
    expect(s).toContain("treated as STALE, not live");
  });

  it("null market values render as em-dash, never as 0 or +0.00%", () => {
    const s = read("src/components/market-board.tsx");
    expect(s).toContain('change24hPct === null ? "—"');
    for (const f of [...PAGES, "src/components/market-board.tsx"]) {
      expect(read(f), `${f} contains a fabricated +0.00` ).not.toContain('"+0.00%"');
    }
  });

  it("flash effects fire only on real snapshot diffs", () => {
    const s = read("src/components/market-board.tsx");
    // the ONLY source of a flash is the price comparison between two payloads
    expect(s).toMatch(/prev !== undefined && prev !== r\.price/);
    expect(s).toMatch(/up: r\.price > prev/);
  });

  it("no placebo controls — no disabled 'coming soon' buttons in the vocabulary", () => {
    for (const f of ["src/components/ui.tsx", "src/components/chrome.tsx", "src/components/palette.tsx", "src/components/toast.tsx", "src/components/overlay.tsx"]) {
      expect(read(f)).not.toMatch(/coming soon|under construction/i);
    }
  });

  it("long universes are windowed instead of dumping every row into the DOM", () => {
    const s = read("src/components/market-board.tsx");
    expect(s).toContain("WINDOW_ROWS = 60");
    expect(s).toContain("windowed rows"); // the mechanism is disclosed, not hidden
  });
});

describe("shell continuity", () => {
  it("only <main> re-keys per route — the shell, rail and bottom nav persist", () => {
    const s = read("src/components/chrome.tsx");
    const mainKey = s.match(/<main id="main" key=\{path \?\? "root"\}/);
    expect(mainKey).not.toBeNull();
    expect(s.match(/key=\{path/g)?.length).toBe(1); // nowhere else may remount wholesale
  });
  it("mobile navigation is a real bottom bar with a More sheet, safe areas included", () => {
    const s = read("src/components/chrome.tsx");
    expect(s).toContain("env(safe-area-inset-bottom)");
    expect(s).toContain("MoreSheet");
    expect(s).toContain('aria-label="primary mobile navigation"');
  });
});
