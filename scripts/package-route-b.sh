#!/usr/bin/env bash
# Build and pack the Route B DSH plugin for the current platform.
#
# Output: dist/opentake-studio-route-b-<version>-<os>-<arch>.tgz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/opentake-studio-route-b"
DIST="$ROOT/dist"
mkdir -p "$DIST"

"$ROOT/scripts/build-route-b-addon.sh"

if [ ! -f "$PLUGIN/web/index.html" ]; then
  echo "Missing built web app at $PLUGIN/web; build it first (see README)." >&2
  exit 1
fi

VERSION="$(node -p "require('$PLUGIN/package.json').version")"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
TARBALL="$DIST/opentake-studio-route-b-${VERSION}-${OS}-${ARCH}.tgz"
rm -f "$TARBALL"
(cd "$PLUGIN" && npm pack --pack-destination "$DIST" >/dev/null)
PACKED="$(ls -t "$DIST"/opentake-studio-route-b-*.tgz | head -1)"
mv "$PACKED" "$TARBALL"
echo "Wrote $TARBALL"
tar -tzf "$TARBALL" | sed -n '1,40p'
