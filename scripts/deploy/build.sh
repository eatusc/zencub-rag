#!/usr/bin/env bash
# Build both production surfaces from one codebase.
#
#   .next-public -> APP_MODE=public (search.zencub.com)
#   .next-demo   -> APP_MODE=full   (demo.zencub.com)
#
# Two builds rather than one shared build because APP_MODE is inlined into the
# middleware bundle at build time, and because the dev server on port 3417 keeps
# rewriting plain `.next` while these are serving traffic.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Stamp the commit into both bundles so /api/health reports what is actually
# running. This has to happen at build time: `next start` runs later, from a
# different process, and cannot recover which commit produced the bundle.
BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export BUILD_SHA BUILD_TIME
echo "==> Stamping build $BUILD_SHA ($BUILD_TIME)"

echo "==> Building public surface (.next-public)"
APP_MODE=public NEXT_DIST_DIR=.next-public npx next build

echo "==> Building full demo surface (.next-demo)"
APP_MODE=full NEXT_DIST_DIR=.next-demo npx next build

echo "==> Built $BUILD_SHA. The servers are still on the previous build."
echo "    Prefer scripts/deploy/deploy.sh, which builds and restarts as one step."
echo "    To restart these builds by hand:"
echo "    launchctl kickstart -k gui/$(id -u)/local.zencub-rag-public"
echo "    launchctl kickstart -k gui/$(id -u)/local.zencub-rag-demo"
