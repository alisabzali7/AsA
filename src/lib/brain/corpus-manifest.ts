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
  expected_bytes: number;
  /** Explicit epistemic completeness; UNKNOWN is never upgraded from file size or punctuation. */
  completeness: "COMPLETE" | "TRUNCATED" | "UNKNOWN";
  /** Compatibility mirror; true only when the supplied source is explicitly marked TRUNCATED. */
  known_truncated: boolean;
}

export const CORPUS_FILES: CorpusFile[] = [
  { file_id: "1.txt", filename: "RAW_1.txt", expected_sha256: "b430f52e191c763e7c8752359ddc21820cbe8f79ea58b212f14ca0107d3a7244", expected_lines: 2450, expected_chars: 349_998, expected_bytes: 617_254, completeness: "TRUNCATED", known_truncated: true },
  { file_id: "2.txt", filename: "RAW_2.txt", expected_sha256: "0177294c7f5b14b758efab3cd8a3b39e3ed8444766c6bdba318978a3e872fbb1", expected_lines: 1987, expected_chars: 350_000, expected_bytes: 598_290, completeness: "TRUNCATED", known_truncated: true },
  { file_id: "3.txt", filename: "RAW_3.txt", expected_sha256: "bf0ae22b7fdbde3959c5563338058d378f030d5506ca5b15cf92f59a2be06cee", expected_lines: 1100, expected_chars: 253_714, expected_bytes: 424_438, completeness: "UNKNOWN", known_truncated: false },
  { file_id: "4.txt", filename: "RAW_4.txt", expected_sha256: "bc050e2aefbb9a0bf0894114d791a7e93dfa01afe263e25ade0b04b1b560db8a", expected_lines: 2901, expected_chars: 350_000, expected_bytes: 600_086, completeness: "TRUNCATED", known_truncated: true },
  { file_id: "5.txt", filename: "RAW_5.txt", expected_sha256: "1c73c915fe90d7bd5c49f2b93ceab47b15850b795f53989914fa1f53d208baaf", expected_lines: 960, expected_chars: 109_216, expected_bytes: 184_218, completeness: "UNKNOWN", known_truncated: false },
];

/** Canonical pack now lives in knowledge/canonical/ (one source of truth). */
export function sourceCompletenessFor(fileId: string): CorpusFile["completeness"] {
  return CORPUS_FILES.find((file) => file.file_id === fileId)?.completeness ?? "UNKNOWN";
}

export const CANONICAL_PACK_FILE = "../canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json";
export const CANONICAL_PACK_SHA256 = "eecb67c9e21af7563068255f1316f08bee508fd6941e4771a537e6dd7782a891";
export const CANONICAL_PACK_BYTES = 1_330_269;
