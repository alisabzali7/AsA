/**
 * Source recovery must preserve epistemic limits and commit every source/artifact
 * as one evidence-bound unit. Fault injection is exercised against a populated DB.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrainStore } from "../src/lib/brain/store";
import { ingestAllSources, type IngestFaultPoint } from "../src/lib/brain/ingest";
import type { ConflictHistoryRecord } from "../src/lib/brain/types";

const CORPUS_DIR = path.resolve("knowledge/raw");
const PSYCHOLOGY_DIR = path.resolve("knowledge/psychology");
const FAULT_POINTS: IngestFaultPoint[] = ["after-corpus", "after-psychology", "before-manifest"];

interface RecoveryManifest {
  schema_version: string;
  raw_corpus: { file_id: string; source_path: string; sha256: string; bytes: number; lines: number; completeness: string; truncated: boolean }[];
  canonical_pack: { filename: string; role: string; sha256: string } | null;
  psychology_sources: { file_id: string; original_filename: string; source_path: string; sha256: string; completeness: string; truncated: boolean }[];
  completeness: string;
}

describe("atomic source-to-runtime recovery", () => {
  it("persists source-level UNKNOWN and rolls back all writes at every recovery boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asa-source-recovery-"));
    const store = new BrainStore(path.join(tmp, "brain.db"));
    try {
      const committed = ingestAllSources(store, { corpusDir: CORPUS_DIR, psychologyDir: PSYCHOLOGY_DIR });
      expect(committed.ok).toBe(true);
      expect(committed.rolled_back).toBe(false);
      expect(committed.completeness).toBe("PARTIAL");
      expect(committed.corpus?.documents).toHaveLength(5);
      expect(committed.psychology?.documents).toHaveLength(2);

      const manifestText = store.meta("source_recovery_manifest");
      expect(manifestText).not.toBeNull();
      const manifest = JSON.parse(manifestText!) as RecoveryManifest;
      expect(manifest.schema_version).toBe("1.1.0");
      expect(manifest.completeness).toBe("PARTIAL");
      expect(manifest.raw_corpus.map((source) => [source.file_id, source.completeness]).sort()).toEqual([
        ["1.txt", "TRUNCATED"],
        ["2.txt", "TRUNCATED"],
        ["3.txt", "UNKNOWN"],
        ["4.txt", "TRUNCATED"],
        ["5.txt", "UNKNOWN"],
      ]);
      expect(manifest.raw_corpus.every((source) => source.sha256.length === 64 && source.bytes > 0 && source.lines > 0)).toBe(true);
      expect(manifest.raw_corpus.every((source) => source.source_path.startsWith("knowledge/raw/"))).toBe(true);
      expect(manifest.canonical_pack).toMatchObject({ role: "INDEX_ONLY" });
      expect(manifest.psychology_sources.map((source) => source.original_filename)).toEqual([
        "my phychology/1.txt",
        "my phychology/2.txt",
      ]);
      expect(manifest.psychology_sources.every((source) => source.completeness === "TRUNCATED" && source.truncated)).toBe(true);

      const expectedManifestHash = createHash("sha256").update(manifestText!, "utf8").digest("hex");
      expect(store.meta("source_recovery_manifest_sha256")).toBe(expectedManifestHash);
      expect(committed.source_manifest_sha256).toBe(expectedManifestHash);
      expect(store.meta("source_recovery_manifest_status")).toBe("PARTIAL");

      // Seed a real operator adjudication and history row so rollback proves it
      // does not erase or partially rewrite governed conflict state.
      const target = store.conflicts()[0];
      expect(target).toBeDefined();
      if (!target) throw new Error("source corpus produced no conflict groups");
      const chosen = target.variants[0]?.label ?? "test-variant";
      const adjudicated = {
        ...target,
        resolution: "OPERATOR_CHOSEN" as const,
        chosen_variant: chosen,
        resolved_by: "operator:source-recovery-test",
        resolved_at_ms: 1_800_000_000_000,
      };
      store.putConflicts(store.conflicts().map((group) => group.conflict_group_id === target.conflict_group_id ? adjudicated : group));
      const historyRow: ConflictHistoryRecord = {
        ...adjudicated,
        history_id: "history-source-recovery-test",
        prior_source_manifest_sha256: store.meta("source_manifest_sha256"),
        lifecycle: "ACTIVE",
        replaced_by: null,
        recorded_at_ms: 1_800_000_000_001,
      };
      store.recordConflictHistory([historyRow]);
      expect(store.conflictHistory()).toHaveLength(1);

      const snapshot = () => ({
        stats: store.stats(),
        conflicts: store.conflicts(),
        conflictHistory: store.conflictHistory(),
        metadata: [
          "source_recovery_manifest",
          "source_recovery_manifest_sha256",
          "source_recovery_manifest_status",
          "source_recovery_committed_at_ms",
          "source_manifest_sha256",
        ].map((key) => [key, store.meta(key)]),
      });
      const committedState = snapshot();
      for (const faultAt of FAULT_POINTS) {
        const failed = ingestAllSources(store, { corpusDir: CORPUS_DIR, psychologyDir: PSYCHOLOGY_DIR, faultAt });
        expect(failed.ok, faultAt).toBe(false);
        expect(failed.rolled_back, faultAt).toBe(true);
        expect(failed.source_manifest_sha256, faultAt).toBeNull();
        expect(failed.errors.join(" "), faultAt).toContain(`fault injection: ${faultAt}`);
        expect(snapshot(), faultAt).toEqual(committedState);
      }
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
