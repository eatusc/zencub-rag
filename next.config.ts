import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Allow accessing the dev server over the Tailscale hostname (not just localhost).
  // Without this, Next 16 blocks cross-origin /_next requests and the client never hydrates.
  allowedDevOrigins: ["your-tailnet-host"],
};

export default nextConfig;
