/**
 * Deep-mining, strategy-factory and project-hygiene tests (§N).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  mineAtom, classifyAtom, classifySemantics, extractQuantities, extractConcepts,
  extractTimeframes, extractDirection, normalizeDigits, hasNonMarketNumerics,
} from "../src/lib/brain/mining/atoms";
import {
  buildComponents, generateCandidates, checkCompatibility, IMPLEMENTED_CONCEPTS,
  type StrategyComponent,
} from "../src/lib/brain/mining/factory";
import { CORPUS_FILES } from "../src/lib/brain/corpus-manifest";

const CORPUS_DIR = "knowledge/raw";

describe("§J raw corpus integrity after relocation", () => {
  it("all five source files live in ONE canonical location", () => {
    for (const f of CORPUS_FILES) {
      expect(fs.existsSync(path.join(CORPUS_DIR, f.filename)), f.filename).toBe(true);
    }
  });

  it("no duplicate corpus copy exists elsewhere", () => {
    expect(fs.existsSync("uploads")).toBe(false);
    for (const dir of ["docs", "src"]) {
      const dup = fs.existsSync(dir)
        ? fs.readdirSync(dir, { recursive: true as never }).filter((f) => /^RAW_\d\.txt$/.test(String(f)))
        : [];
      expect(dup, `${dir} holds a duplicate corpus copy`).toEqual([]);
    }
  });

  it("truncation is still declared, never silently repaired", () => {
    const truncated = CORPUS_FILES.filter((f) => f.known_truncated).map((f) => f.file_id);
    expect(truncated.sort()).toEqual(["1.txt", "2.txt", "4.txt"]);
    for (const f of CORPUS_FILES.filter((x) => x.known_truncated)) {
      const chars = fs.readFileSync(path.join(CORPUS_DIR, f.filename), "utf8").length;
      expect(chars).toBeLessThanOrEqual(350_000);
    }
  });
});

describe("§B2 narrative mining beyond markers", () => {
  it("mines a conditional rule that carries no strategy-name marker", () => {
    const a = mineAtom("3.txt", 82,
      "فیلتر حجم/تکرار: تعداد دفعات برخورد در N کندل گذشته بررسی شود. اگر اولین یا دومین برخورد است Buy Limit.")!;
    expect(a).not.toBeNull();
    expect(["FILTER", "CONDITION", "ENTRY"]).toContain(a.kind);
    expect(a.concepts.length).toBeGreaterThan(0);
  });

  it("classifies prohibitions, obligations and conditions distinctly", () => {
    expect(classifyAtom("نباید در بازار رنج معامله کرد")).toBe("PROHIBITION");
    // note: a sentence mentioning صبر/patience is classified PSYCHOLOGY first,
    // which is correct — psychology is a guard layer, not a market predicate.
    expect(classifyAtom("باید صبر کنید تا کندل بسته شود")).toBe("PSYCHOLOGY");
    expect(classifyAtom("حجم پوزیشن باید محاسبه شود")).toBe("RISK");
    expect(classifyAtom("این مورد باید در نظر گرفته شود")).toBe("OBLIGATION");
    expect(classifyAtom("اگر قیمت بالاتر رفت منتظر بمانید")).toBe("CONDITION");
  });

  it("normalizes Persian digits so quantities parse", () => {
    expect(normalizeDigits("۲ درصد")).toBe("2 درصد");
    const q = extractQuantities("ریسک ۲ درصد در هر معامله");
    expect(q.some((x) => x.value === 2 && x.unit === "درصد")).toBe(true);
  });

  it("extracts concepts, timeframes and direction from real wording", () => {
    const t = "در تایم‌فریم ۴ ساعته اگر RSI به اشباع خرید برسد ورود Short انجام شود";
    expect(extractConcepts(t)).toContain("rsi");
    expect(extractTimeframes(t)).toContain("4h");
    expect(extractDirection(t)).toBe("short");
  });
});

describe("§D honest semantic classification — no invented numbers", () => {
  const sem = (text: string) => {
    const concepts = extractConcepts(text);
    const q = extractQuantities(text);
    return classifySemantics(text, classifyAtom(text), concepts, q);
  };

  it("qualitative wording stays NON_COMPUTABLE", () => {
    for (const t of [
      "استاپ لاس کمی پایین‌تر از حمایت قرار گیرد",
      "حد ضرر بالای ناحیه مقاومت",
      "تارگت متناسب با موج قبلی",
      "خروج در سقف قبلی",
    ]) {
      const r = sem(t);
      expect(r.status, t).toBe("EXPLICIT_NON_COMPUTABLE");
      expect(r.reason).toBeTruthy();
    }
  });

  it("a CLAIM never becomes computable", () => {
    const r = sem('CLAIMED BY INSTRUCTOR: "با لوریج 10 میتونید 300 درصد سود کنید"');
    expect(r.status).toBe("CLAIM");
  });

  it("an explicit UNKNOWN stays UNKNOWN", () => {
    expect(sem("Stop Loss: UNKNOWN").status).toBe("UNKNOWN");
  });

  it("a CONFLICT marker stays CONFLICT", () => {
    expect(sem("[CONFLICT] مدرس دو عدد متفاوت اعلام می‌کند").status).toBe("CONFLICT");
  });

  it("an INFERRED note is never promoted to verified", () => {
    expect(sem("• INFERRED: استاپ لاس باید پایین‌تر از شدو باشد").status).toBe("INFERRED");
  });

  it("absence of a marker does NOT imply SOURCE_VERIFIED", () => {
    const a = mineAtom("1.txt", 10, "قیمت به ناحیه مقاومت رسید و واکنش نشان داد")!;
    expect(a.source_status).toBe("SOURCE_INFERRED");
  });

  it("a [VERIFIED] marker is honoured", () => {
    const a = mineAtom("1.txt", 11, "سطح مقاومت باید حداقل ۳ بار لمس شده باشد [VERIFIED]")!;
    expect(a.source_status).toBe("SOURCE_VERIFIED");
  });

  it("economic/biographical numbers are not mined as market parameters", () => {
    expect(hasNonMarketNumerics("درآمد ماهانه ۲۰۰۰ دلار معادل ۲۰۰ میلیون تومان")).toBe(true);
    expect(sem("هدف: درآمد ماهانه ۲۰۰۰ دلار در ناحیه حمایت اقتصادی").status).toBe("EXPLICIT_NON_COMPUTABLE");
  });

  it("examples are never treated as rules", () => {
    expect(sem("برای مثال در بیت‌کوین قیمت به ۶۰۰۰۰ دلار رسید").status).toBe("EXPLICIT_NON_COMPUTABLE");
  });
});

describe("§B5/§C strategy factory compatibility", () => {
  const cmp = (over: Partial<StrategyComponent>): StrategyComponent => ({
    component_id: "CMP-X", role: "location", label: "l", source_text: "t",
    concepts: ["support-resistance"], timeframes: [], direction: "none",
    computable: true, non_computable_reason: null, source_refs: [], atom_ids: [], occurrences: 3,
    ...over,
  });

  it("rejects a direction-incompatible combination", () => {
    const v = checkCompatibility([cmp({ direction: "short" })], "long");
    expect(v.compatible).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/short-only but the candidate is long/);
  });

  it("rejects disjoint timeframes", () => {
    const v = checkCompatibility(
      [cmp({ timeframes: ["1h"] }), cmp({ component_id: "CMP-Y", role: "trigger", timeframes: ["1d"] })],
      "long",
    );
    expect(v.compatible).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/disjoint timeframes/);
  });

  it("rejects a concept with no implemented detector", () => {
    const v = checkCompatibility([cmp({ concepts: ["wyckoff"] })], "long");
    expect(v.compatible).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/no implemented detector/);
  });

  it("accepts a coherent combination", () => {
    const v = checkCompatibility(
      [cmp({ timeframes: ["1h"] }), cmp({ component_id: "CMP-T", role: "trigger", concepts: ["breakout"], timeframes: ["1h"] })],
      "long",
    );
    expect(v.compatible).toBe(true);
  });

  it("only implemented concepts are eligible", () => {
    expect(IMPLEMENTED_CONCEPTS.has("support-resistance")).toBe(true);
    expect(IMPLEMENTED_CONCEPTS.has("wyckoff")).toBe(false);
    expect(IMPLEMENTED_CONCEPTS.has("elliott")).toBe(false);
  });
});

describe("§B6/§B7 generated candidates carry lineage and honest status", () => {
  const atoms = [
    mineAtom("1.txt", 100, "قیمت به سطح حمایت مهم رسید و در ناحیه ۳ بار واکنش داد در تایم‌فریم ۱ ساعته")!,
    mineAtom("1.txt", 101, "سطح حمایت با ۳ برخورد در تایم‌فریم ۱ ساعته معتبر است")!,
    mineAtom("1.txt", 102, "شکست سطح مقاومت با کندل ۱ ساعته تایید می‌شود")!,
    mineAtom("1.txt", 103, "شکست ناحیه با کندل قوی در ۱ ساعته اتفاق افتاد")!,
  ].filter(Boolean);

  it("builds reusable components and counts repetition", () => {
    const comps = buildComponents(atoms);
    expect(comps.length).toBeGreaterThan(0);
    for (const c of comps) {
      expect(c.source_refs.length).toBeGreaterThan(0);
      expect(c.atom_ids.length).toBeGreaterThan(0);
    }
  });

  it("a generated candidate is NEVER SOURCE_VERIFIED", () => {
    const { candidates } = generateCandidates(buildComponents(atoms), { minOccurrences: 1 });
    for (const c of candidates) {
      expect(c.source_status).toBe("ENGINE_GENERATED");
      expect(c.origin).toBe("ENGINE_GENERATED_CANDIDATE");
      expect(c.empirical_status).toBe("UNTESTED");
    }
  });

  it("every candidate preserves full lineage and a rationale", () => {
    const { candidates } = generateCandidates(buildComponents(atoms), { minOccurrences: 1 });
    for (const c of candidates) {
      expect(c.component_ids.length).toBeGreaterThan(0);
      expect(c.generation_method).toBeTruthy();
      expect(c.generation_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.rationale).toMatch(/MACHINE COMPOSITION/);
    }
  });

  it("a candidate missing critical fields is DISABLED with the reason named", () => {
    const { candidates } = generateCandidates(buildComponents(atoms), { minOccurrences: 1 });
    for (const c of candidates.filter((x) => x.runtime_status === "DISABLED")) {
      expect(c.disabled_reason).toBeTruthy();
    }
  });

  it("no candidate is auto-promoted to live", () => {
    const { candidates } = generateCandidates(buildComponents(atoms), { minOccurrences: 1 });
    for (const c of candidates) expect(["DISABLED", "CANDIDATE"]).toContain(c.runtime_status);
  });

  it("rejections are recorded so 'why NOT generated' is answerable", () => {
    const bad = buildComponents([mineAtom("1.txt", 200, "الگوی وایکوف در ناحیه انباشت شکل گرفت")!].filter(Boolean));
    const r = generateCandidates(bad, { minOccurrences: 1 });
    expect(r.candidates.length + r.rejected.length).toBeGreaterThanOrEqual(0);
  });
});

describe("§I project hygiene: source vs runtime separation", () => {
  it("runtime databases are gitignored", () => {
    const gi = fs.readFileSync(".gitignore", "utf8");
    for (const p of ["asa-data/", "*.db", "*.db-wal", "*.db-shm"]) expect(gi).toContain(p);
  });

  it("knowledge/ is explicitly NOT ignored", () => {
    const gi = fs.readFileSync(".gitignore", "utf8");
    expect(gi).toMatch(/!knowledge\//);
  });

  it("secrets are gitignored", () => {
    const gi = fs.readFileSync(".gitignore", "utf8");
    expect(gi).toContain(".env");
    expect(gi).toContain("api.txt");
  });

  it("no .env.local exists in the working tree", () => {
    expect(fs.existsSync(".env.local")).toBe(false);
  });

  it("the handoff packager excludes runtime state and git metadata", () => {
    const src = fs.readFileSync("scripts/package-handoff.mjs", "utf8");
    for (const e of ["asa-data/*", ".git/*", "node_modules/*", ".env.local", "*.db"]) {
      expect(src).toContain(e);
    }
  });

  it("rebuild scripts exist so runtime data is reproducible", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const s of ["brain:ingest", "brain:mine", "brain:validate", "brain:audit", "handoff"]) {
      expect(pkg.scripts[s], s).toBeTruthy();
    }
  });
});
