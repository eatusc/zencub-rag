import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Allow accessing the dev server over a LAN/Tailscale hostname (not just localhost).
  // Without this, Next 16 blocks cross-origin /_next requests and the client never hydrates.
  // Set DEV_ORIGIN (e.g. your Tailscale hostname) in your local env to enable it.
  allowedDevOrigins: process.env.DEV_ORIGIN ? [process.env.DEV_ORIGIN] : [],
  // Each deployment builds into its own directory: APP_MODE is inlined into the
  // middleware bundle, and the dev server on 3417 keeps rewriting plain `.next`
  // while the production servers are running.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Stamped in by scripts/deploy/build.sh and inlined into the bundles at build
  // time, so /api/health reports the commit a server was built from. `next
  // start` re-evaluates this file, so reading git here instead of the
  // environment would report whatever HEAD is now and never look stale.
  env: {
    BUILD_SHA: process.env.BUILD_SHA ?? "unknown",
    BUILD_TIME: process.env.BUILD_TIME ?? "unknown",
  },
};

export default nextConfig;
