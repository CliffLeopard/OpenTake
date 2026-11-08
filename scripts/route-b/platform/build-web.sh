#!/usr/bin/env bash
# Build the OpenTake React app into the Route B plugin's `web/` directory.
#
# The app build itself is the normal Vite build from `web/`; this script adds the
# two Route-B-specific steps:
#   1. Vite base `/opentake-studio-route-b/app/`.
#   2. Re-attaching and referencing `web/tauri-shim.js`, which is hand-maintained
#      (inventory gap A1 — a rebuild must not drop it).
#
# Usage:
#   ./scripts/route-b/platform/build-web.sh           # build and copy
#   ./scripts/route-b/platform/build-web.sh --check   # verify prerequisites only
#
# `--check` validates paths/tools without touching the generated `web/` tree.
set -euo pipefail
cd "$(dirname "$0")/../../.." || exit 2

PLUGIN="plugins/opentake-studio-route-b"
APP_BASE="${ROUTE_B_APP_BASE:-/opentake-studio-route-b/app/}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

fail() { echo "build-web: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required"
[ -d "web/src" ] || fail "web/ source tree not found"
[ -f "$PLUGIN/web/tauri-shim.js" ] || fail "$PLUGIN/web/tauri-shim.js not found (the shim is hand-maintained)"
[ -f "web/package.json" ] || fail "web/package.json not found"

echo "build-web: base=$APP_BASE"
echo "build-web: shim=$(wc -c < "$PLUGIN/web/tauri-shim.js") bytes"

if [ "$CHECK" = "1" ]; then
  echo "build-web: --check OK (no build performed)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$PLUGIN/web/tauri-shim.js" "$TMP/tauri-shim.js"

echo "build-web: installing locked web dependencies"
pnpm --dir web install --frozen-lockfile

echo "build-web: building Vite app"
pnpm --dir web exec vite build --base="$APP_BASE"

echo "build-web: replacing $PLUGIN/web"
rm -rf "$PLUGIN/web"
cp -R web/dist "$PLUGIN/web"
cp "$TMP/tauri-shim.js" "$PLUGIN/web/tauri-shim.js"

echo "build-web: injecting shim reference into index.html"
node - "$PLUGIN/web/index.html" "$APP_BASE" "$PLUGIN/web/tauri-shim.js" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [indexPath, base, shimPath] = process.argv.slice(2);
const shim = fs.readFileSync(shimPath);
const version = crypto.createHash('sha256').update(shim).digest('hex').slice(0, 12);
const tag = `    <script src="${base}tauri-shim.js?v=${version}"></script>`;
let html = fs.readFileSync(indexPath, 'utf8');
if (html.includes('tauri-shim.js')) {
  html = html.replace(/[ \t]*<script[^>]*tauri-shim\.js[^>]*><\/script>\s*/g, '');
}
if (!html.includes('</head>')) {
  console.error('build-web: index.html has no </head>');
  process.exit(1);
}
html = html.replace('</head>', `${tag}\n  </head>`);
fs.writeFileSync(indexPath, html);
console.log(`build-web: shim v=${version} referenced from ${indexPath}`);
NODE

echo "build-web: OK"
