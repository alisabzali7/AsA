import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module used only by the server (src/db).
  serverExternalPackages: ["better-sqlite3"],
  // Dev-only: sandboxed preview environments proxy the dev server through a
  // generated *.e2b.app host. Without this, Next.js's dev-origin allowlist
  // blocks the HMR websocket from that host (console warning, no functional
  // break, but noisy). Production builds never read this option.
  allowedDevOrigins: ["*.e2b.app"],
  // Keep default output (single Next.js process); VPS runs the same process.
  //
  // PWA correctness: a stale service worker must never outlive a deploy.
  // The shell cache is versioned inside sw.js, but the WORKER SCRIPT itself
  // must always be revalidated (600 s is the browser's own update-check
  // ceiling; no-cache makes every navigation verify) so updates are noticed
  // promptly instead of after an arbitrary CDN TTL. The manifest is small and
  // may reference new icons after a deploy — same policy.
  async headers() {
    return [
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      { source: "/manifest.webmanifest", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
