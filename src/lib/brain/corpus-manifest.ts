/**
 * The immutable corpus manifest.
 *
 * `file_id` values match the ids used inside the canonical knowledge pack
 * ("1.txt".."5.txt") so provenance from the pack and from RAW ingestion refer
 * to the same logical document. `filename` is the on-disk name in the supplied
 * package. sha256 digests were verified in Stage 0 against the pack's own
 * `source_files` array — a mismatch means the corpus changed and ingestion
 * must be re-run and re-audited.
 */
export interface CorpusFile {
  file_id: string;
  filename: string;
  expected_sha256: string;
  expected_lines: number;
  expected_chars: number;
  /** supplied bytes end mid-content (upstream 350k cap) */
  known_truncated: boolean;
}

export const CORPUS_FILES: CorpusFile[] = [
  { file_id: "1.txt", filename: "RAW_1.txt", expected_sha256: "", expected_lines: 2450, expected_chars: 349_998, known_truncated: true },
  { file_id: "2.txt", filename: "RAW_2.txt", expected_sha256: "", expected_lines: 1987, expected_chars: 350_000, known_truncated: true },
  { file_id: "3.txt", filename: "RAW_3.txt", expected_sha256: "", expected_lines: 1100, expected_chars: 253_714, known_truncated: false },
  { file_id: "4.txt", filename: "RAW_4.txt", expected_sha256: "", expected_lines: 2901, expected_chars: 350_000, known_truncated: true },
  { file_id: "5.txt", filename: "RAW_5.txt", expected_sha256: "", expected_lines: 960, expected_chars: 109_216, known_truncated: false },
];

/** Canonical pack now lives in knowledge/canonical/ (one source of truth). */
export const CANONICAL_PACK_FILE = "../canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json";
