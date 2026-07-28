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

echo "==> Building public surface (.next-public)"
APP_MODE=public NEXT_DIST_DIR=.next-public npx next build

echo "==> Building full demo surface (.next-demo)"
APP_MODE=full NEXT_DIST_DIR=.next-demo npx next build

echo "==> Done. Restart the servers to pick up the new builds:"
echo "    launchctl kickstart -k gui/$(id -u)/local.zencub-rag-public"
echo "    launchctl kickstart -k gui/$(id -u)/local.zencub-rag-demo"
