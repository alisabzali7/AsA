import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  USER_PSYCHOLOGY_SECTIONS,
  USER_PSYCHOLOGY_SOURCES,
  USER_PSYCHOLOGY_SOURCE_RULES,
  verifyUserPsychologySources,
} from "../src/lib/psychology/user-source";

describe("user psychology source pack", () => {
  it("keeps exactly two immutable, hash-pinned source documents", () => {
    const verified = verifyUserPsychologySources();
    expect(verified).toHaveLength(2);
    expect(USER_PSYCHOLOGY_SOURCES.map((s) => s.file_id)).toEqual(["USER-PSY-1", "USER-PSY-2"]);
    expect(verified.map((s) => s.sha256)).toEqual(USER_PSYCHOLOGY_SOURCES.map((s) => s.sha256));
    expect(verified.every((s) => s.truncated)).toBe(true);
  });

  it("maps the supplied material conservatively without creating executable psychology rules", () => {
    expect(USER_PSYCHOLOGY_SECTIONS.length).toBeGreaterThanOrEqual(7);
    expect(USER_PSYCHOLOGY_SOURCE_RULES).toHaveLength(11);
    expect(USER_PSYCHOLOGY_SOURCE_RULES.every((r) => r.formalization_status === "SOURCE_ONLY")).toBe(true);
    expect(USER_PSYCHOLOGY_SOURCE_RULES.every((r) => r.runtime_status === "DISABLED")).toBe(true);
    expect(USER_PSYCHOLOGY_SOURCE_RULES.every((r) => r.executable === false)).toBe(true);
    for (const rule of USER_PSYCHOLOGY_SOURCE_RULES) {
      expect(rule.source_refs.length).toBeGreaterThan(0);
      for (const ref of rule.source_refs) {
        expect(["USER_PSYCHOLOGY_1.txt", "USER_PSYCHOLOGY_2.txt"]).toContain(ref.file);
        expect(ref.start_line).toBeGreaterThan(0);
        expect(ref.end_line).toBeGreaterThanOrEqual(ref.start_line);
      }
    }
  });

  it("keeps the manifest in sync with the section map and never drops the last source line from provenance", () => {
    // every source's final section must cover the file down to its real last line
    for (const source of USER_PSYCHOLOGY_SOURCES) {
      const sections = USER_PSYCHOLOGY_SECTIONS.filter((s) => s.file_id === source.file_id);
      expect(sections.length).toBeGreaterThan(0);
      const last = sections.reduce((a, b) => (b.start_line > a.start_line ? b : a));
      expect(last.end_line).toBe(source.total_lines);
    }

    // the committed manifest must carry the exact same provenance section map
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "knowledge", "psychology", "USER_PSYCHOLOGY_MANIFEST.json"), "utf8"),
    ) as { sections: unknown };
    expect(manifest.sections).toEqual(USER_PSYCHOLOGY_SECTIONS);
  });
});
