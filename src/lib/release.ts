/**
 * Release / source identity. The digest covers the complete non-secret source
 * tree and declared build inputs, including uncommitted and untracked files.
 * Runtime data, dependencies already installed on disk, VCS internals and build
 * caches are excluded by explicit policy; package-lock.json is mandatory.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { APP_VERSION } from "./env";

export type IdentityStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN" | "INVALID";
export type WorktreeStatus = "CLEAN" | "DIRTY" | "UNKNOWN";

export interface SourceTreeIdentity {
  status: IdentityStatus;
  sha256: string | null;
  files: number;
  bytes: number;
  missing_required_inputs: string[];
  errors: string[];
}

export interface ReleaseIdentity {
  app_version: string;
  git_commit: string;
  build_id: string;
  build_time_ms: number;
  node_version: string;
  source_tree_sha256: string;
  source_tree_digest_status: IdentityStatus;
  source_tree_file_count: number;
  source_tree_bytes: number;
  source_tree_missing_inputs: string[];
  source_tree_errors: string[];
  worktree_status: WorktreeStatus;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", ".next", ".turbo", ".cache", ".vite", ".output",
  ".svelte-kit", "coverage", "dist", "build", "out", "target", "asa-data", ".venv",
]);
const REQUIRED_INPUTS = [
  "package.json", "package-lock.json", "tsconfig.json", "next.config.ts",
  "postcss.config.mjs", "vitest.config.ts", "eslint.config.mjs",
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
] as const;

function isSecretEnvFile(name: string): boolean {
  return /^\.env(?:\.|$)/.test(name) && name !== ".env.example";
}

function visitTree(root: string, relative: string, files: string[], errors: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch (err) {
    errors.push(`cannot read ${relative || "."}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name) || isSecretEnvFile(entry.name) || entry.name.endsWith(".db") || entry.name.endsWith(".db-wal") || entry.name.endsWith(".db-shm") || entry.name.endsWith(".tsbuildinfo")) continue;
    const child = path.posix.join(relative, entry.name);
    const absolute = path.join(root, child);
    if (entry.isDirectory()) visitTree(root, child, files, errors);
    else if (entry.isFile()) files.push(child);
    else if (entry.isSymbolicLink()) errors.push(`symbolic link excluded from source identity: ${child}`);
  }
}

/** Hash exact included bytes. Missing required build inputs yield PARTIAL, never AVAILABLE. */
export function computeSourceTreeIdentity(root = process.cwd()): SourceTreeIdentity {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];
  const errors: string[] = [];
  const missing = REQUIRED_INPUTS.filter((name) => !fs.existsSync(path.join(absoluteRoot, name)));
  visitTree(absoluteRoot, "", files, errors);
  files.sort();
  if (files.length === 0) return { status: "UNKNOWN", sha256: null, files: 0, bytes: 0, missing_required_inputs: missing, errors: [...errors, "no source-tree inputs available to hash"] };

  const digest = createHash("sha256");
  let totalBytes = 0;
  try {
    for (const relative of files) {
      const bytes = fs.readFileSync(path.join(absoluteRoot, relative));
      totalBytes += bytes.byteLength;
      digest.update(relative).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes).update("\0");
    }
  } catch (err) {
    return { status: "INVALID", sha256: null, files: files.length, bytes: totalBytes, missing_required_inputs: missing, errors: [...errors, `source read failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const sha256 = digest.digest("hex");
  const status: IdentityStatus = errors.length > 0 ? "INVALID" : missing.length > 0 ? "PARTIAL" : "COMPLETE";
  return { status, sha256, files: files.length, bytes: totalBytes, missing_required_inputs: missing, errors };
}

/** Backward-compatible digest helper; consumers must also inspect its status. */
export function computeSourceTreeSha256(root = process.cwd()): string {
  const identity = computeSourceTreeIdentity(root);
  if (!identity.sha256) throw new Error(identity.errors.join("; ") || "source identity is unavailable");
  return identity.sha256;
}

function resolveCommit(): string {
  if (process.env.ASA_GIT_COMMIT) return process.env.ASA_GIT_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

function resolveWorktreeStatus(): WorktreeStatus {
  try {
    const status = execSync("git status --porcelain --untracked-files=all", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return status.trim().length === 0 ? "CLEAN" : "DIRTY";
  } catch {
    return "UNKNOWN";
  }
}

let cached: ReleaseIdentity | null = null;

export function buildReleaseIdentity(): ReleaseIdentity {
  if (cached) return cached;
  const commit = resolveCommit();
  const identity = computeSourceTreeIdentity();
  const worktree = resolveWorktreeStatus();
  const status: IdentityStatus = identity.status === "COMPLETE" && commit !== "unavailable" && worktree !== "UNKNOWN"
    ? "COMPLETE"
    : identity.status === "INVALID" ? "INVALID"
      : identity.status === "UNKNOWN" ? "UNKNOWN" : "PARTIAL";
  const hash = identity.sha256 ?? "";
  const buildTime = Number(process.env.ASA_BUILD_TIME_MS ?? Date.now());
  const buildId = process.env.ASA_BUILD_ID ?? `${APP_VERSION}+${commit}+${hash.slice(0, 12) || "source-unknown"}${worktree === "DIRTY" ? "+dirty" : ""}`;
  cached = {
    app_version: APP_VERSION,
    git_commit: commit,
    build_id: buildId,
    build_time_ms: buildTime,
    node_version: process.version,
    source_tree_sha256: hash,
    source_tree_digest_status: status,
    source_tree_file_count: identity.files,
    source_tree_bytes: identity.bytes,
    source_tree_missing_inputs: identity.missing_required_inputs,
    source_tree_errors: identity.errors,
    worktree_status: worktree,
  };
  return cached;
}
