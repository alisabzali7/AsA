import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSourceTreeIdentity } from "../src/lib/release";

const REQUIRED_INPUTS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "vitest.config.ts",
  "eslint.config.mjs",
  "docs/roadmap/ASA_100_PERCENT_CONTRACT.md",
  "docs/archive/AsA_Master_Build_Bible_v1.0.pdf",
  "docs/ttt/ttt-api-reference.pdf",
  "docs/psychology/USER_PSYCHOLOGY_SOURCE_PACK.md",
  "scripts/validate-asa-closure.mjs",
  "src/lib/strategy/compiled/source-contract.ts",
  "src/lib/strategy/compiled/source-contracts.json",
  "src/lib/strategy/compiled/source-contracts.lock.json",
  "knowledge/raw/RAW_1.txt",
  "knowledge/raw/RAW_2.txt",
  "knowledge/raw/RAW_3.txt",
  "knowledge/raw/RAW_4.txt",
  "knowledge/raw/RAW_5.txt",
  "knowledge/canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json",
  "knowledge/psychology/USER_PSYCHOLOGY_1.txt",
  "knowledge/psychology/USER_PSYCHOLOGY_2.txt",
  "knowledge/psychology/USER_PSYCHOLOGY_MANIFEST.json",
  "knowledge/psychology/inbox/AsA_user_psychology_integration.patch.txt",
];

function writeTree(root: string): void {
  for (const [index, relative] of REQUIRED_INPUTS.entries()) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `required-input-${index}`);
  }
}

describe("release source-tree identity", () => {
  it("hashes exact included file paths and bytes deterministically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asa-source-tree-"));
    try {
      writeTree(root);
      const first = computeSourceTreeIdentity(root);
      const second = computeSourceTreeIdentity(root);
      expect(first.status).toBe("COMPLETE");
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.sha256).toBe(second.sha256);
      expect(first.files).toBe(REQUIRED_INPUTS.length);

      fs.writeFileSync(path.join(root, "src.ts"), "untracked-but-included");
      expect(computeSourceTreeIdentity(root).sha256).not.toBe(first.sha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes secret environment files and runtime databases from the digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asa-source-tree-exclude-"));
    try {
      writeTree(root);
      fs.writeFileSync(path.join(root, ".env.local"), "SECRET=first");
      fs.mkdirSync(path.join(root, "asa-data"), { recursive: true });
      fs.writeFileSync(path.join(root, "asa-data", "brain.db"), "runtime-one");
      const first = computeSourceTreeIdentity(root);
      fs.writeFileSync(path.join(root, ".env.local"), "SECRET=changed");
      fs.writeFileSync(path.join(root, "asa-data", "brain.db"), "runtime-two");
      const second = computeSourceTreeIdentity(root);
      expect(first.status).toBe("COMPLETE");
      expect(second.status).toBe("COMPLETE");
      expect(second.sha256).toBe(first.sha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing required inputs as PARTIAL instead of treating a hash as complete", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asa-source-tree-partial-"));
    try {
      fs.writeFileSync(path.join(root, "one.ts"), "some source");
      const result = computeSourceTreeIdentity(root);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.status).toBe("PARTIAL");
      expect(result.missing_required_inputs).toContain("package-lock.json");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks symlink-containing source trees INVALID rather than hashing a partial view", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asa-source-tree-link-"));
    try {
      writeTree(root);
      const target = path.join(root, "actual.ts");
      fs.writeFileSync(target, "actual source");
      fs.symlinkSync(target, path.join(root, "alias.ts"));
      const result = computeSourceTreeIdentity(root);
      expect(result.status).toBe("INVALID");
      expect(result.errors.some((error) => error.includes("alias.ts"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
