/**
 * Release / build identity (closure §AD).
 *
 * A single source for the version stamped into every experiment lineage entry
 * and the final status report. The git commit is resolved at runtime and
 * cached; when git is unavailable (e.g. a container without the .git dir) the
 * value is reported as "unavailable" rather than a fabricated hash.
 */
import { execSync } from "node:child_process";
import { APP_VERSION } from "./env";

export interface ReleaseIdentity {
  app_version: string;
  git_commit: string;
  build_id: string;
  build_time_ms: number;
  node_version: string;
}

let cached: ReleaseIdentity | null = null;

function resolveCommit(): string {
  if (process.env.ASA_GIT_COMMIT) return process.env.ASA_GIT_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

export function buildReleaseIdentity(): ReleaseIdentity {
  if (cached) return cached;
  const commit = resolveCommit();
  const buildTime = Number(process.env.ASA_BUILD_TIME_MS ?? Date.now());
  cached = {
    app_version: APP_VERSION,
    git_commit: commit,
    build_id: process.env.ASA_BUILD_ID ?? `${APP_VERSION}+${commit}`,
    build_time_ms: buildTime,
    node_version: process.version,
  };
  return cached;
}
