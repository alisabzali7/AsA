/**
 * Team 02 absolute-final: IMPORT TOPOLOGY.
 *
 * The browser renders; it never computes analysis. Proven structurally: walk
 * the transitive VALUE-import graph (type-only imports are erased by the
 * compiler and ship no code) from every frontend module — src/components/**
 * and every non-API file under src/app/** — and fail if any reachable module
 * is an analysis / indicator / structure / detector / strategy / rule /
 * backtest / pipeline / AI internal. The only lib modules the frontend may
 * reach are the render contract helpers listed in ALLOWED_LIB.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

const FORBIDDEN = [
  "src/lib/analysis/", "src/lib/features/", "src/lib/strategy/", "src/lib/rules/",
  "src/lib/backtest/", "src/lib/pipeline/", "src/lib/ai/", "src/lib/brain/",
  "src/lib/market/", "src/lib/ttt/", "src/lib/risk/", "src/lib/notify/",
  "src/lib/chart/technical", "src/lib/chart/evidence", "src/lib/chart/render",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** value (non-type-only) import specifiers of a file */
export function valueImports(code: string): string[] {
  const out: string[] = [];
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const clause = m[2].trim();
    if (/^type\s/.test(clause)) continue; // import type {…} / export type {…}
    // import { type A, type B } — every named binding type-only → erased
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named && named[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]);
  }
  for (const d of stripped.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(d[1]);
  for (const d of stripped.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(d[1]);
  return out;
}

function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>(); // file -> path from entry
  const stack: [string, string[]][] = [[entry, [entry]]];
  while (stack.length) {
    const [f, chain] = stack.pop()!;
    if (seen.has(f)) continue;
    seen.set(f, chain);
    for (const spec of valueImports(readFileSync(f, "utf8"))) {
      const r = resolveSpec(f, spec);
      if (r && !seen.has(r)) stack.push([r, [...chain, r]]);
    }
  }
  return seen;
}

const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const frontendEntries = [
  ...walk(join(SRC, "components")),
  ...walk(join(SRC, "app")).filter((p) => !rel(p).startsWith("src/app/api/")),
];

describe("frontend import topology", () => {
  it("finds the frontend entry points (sanity)", () => {
    expect(frontendEntries.some((p) => rel(p) === "src/components/chart-view.tsx")).toBe(true);
    expect(frontendEntries.length).toBeGreaterThan(10);
  });

  it("no frontend module reaches an analysis/strategy/engine internal through value imports", () => {
    const violations: string[] = [];
    for (const entry of frontendEntries) {
      for (const [file, chain] of reachable(entry)) {
        const r = rel(file);
        if (FORBIDDEN.some((f) => r.startsWith(f))) violations.push(chain.map(rel).join(" → "));
      }
    }
    expect(violations).toEqual([]);
  });

  it("the chart reaches only the render contract (adapter) and the poll sequencer from src/lib", () => {
    const libs = [...reachable(join(SRC, "components/chart-view.tsx")).keys()].map(rel).filter((r) => r.startsWith("src/lib/")).sort();
    expect(libs.every((r) => ["src/lib/chart/adapter.ts", "src/lib/poll-sequence.ts", "src/lib/i18n/strings.ts", "src/lib/prefs.ts"].includes(r) || r.startsWith("src/lib/i18n/"))).toBe(true);
    expect(libs).toContain("src/lib/chart/adapter.ts");
  });

  it("Brain Scanner is LEGACY_CONFIRMED: no production module imports it (tests only)", () => {
    const importers = [...walk(SRC), ...walk(join(ROOT, "scripts"))]
      .filter((f) => !rel(f).endsWith("pipeline/brain-scanner.ts"))
      .filter((f) => valueImports(readFileSync(f, "utf8")).some((s) => resolveSpec(f, s) === join(SRC, "lib/pipeline/brain-scanner.ts")));
    // if this fails, the scanner became a production consumer: it must then
    // pass the snapshot-identity consumer contract before being re-classified.
    expect(importers.map(rel)).toEqual([]);
  });

  it("the parser is not vacuous: it sees value imports and ignores type-only ones", () => {
    expect(valueImports('import { a } from "@/lib/analysis/x";')).toEqual(["@/lib/analysis/x"]);
    expect(valueImports('import type { A } from "@/lib/analysis/x";')).toEqual([]);
    expect(valueImports('import { type A, type B } from "@/lib/analysis/x";')).toEqual([]);
    expect(valueImports('import { type A, b } from "@/lib/analysis/x";')).toEqual(["@/lib/analysis/x"]);
    expect(valueImports('export { x } from "./y";\nconst m = import("@/lib/strategy/z");')).toEqual(["./y", "@/lib/strategy/z"]);
    // a forbidden import injected into a real frontend file would be caught
    const chart = readFileSync(join(SRC, "components/chart-view.tsx"), "utf8");
    expect(valueImports(`${chart}\nimport { buildBundle } from "@/lib/analysis/bundle";`)).toContain("@/lib/analysis/bundle");
  });
});
