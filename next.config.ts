import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module used only by the server (src/db).
  serverExternalPackages: ["better-sqlite3"],
  // Keep default output (single Next.js process); VPS runs the same process.
};

export default nextConfig;
