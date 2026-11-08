#!/usr/bin/env bash
# Pack the Route B plugin from the native binaries already in the tree.
#
# This is the CI/release counterpart to `scripts/package-route-b.sh` (which
# rebuilds the host addon first). Keeping "build" and "pack" separate lets the
# workflow sign the `.node` files between the two steps without a rebuild
# overwriting the signatures.
#
# Usage: ./scripts/route-b/platform/package-from-native.sh
#
# Output: dist/opentake-studio-route-b-<version>-<platform>-<arch>.tgz
# Naming rules match the existing packaging script: one architecture -> that arch;
# several architectures of the same OS (darwin-arm64 + darwin-x64) -> universal.
set -euo pipefail
cd "$(dirname "$0")/../../.." || exit 2

PLUGIN="plugins/opentake-studio-route-b"
DIST="dist"
mkdir -p "$DIST"

fail() { echo "package-from-native: $*" >&2; exit 1; }

[ -f "$PLUGIN/package.json" ] || fail "$PLUGIN/package.json not found"
[ -f "$PLUGIN/web/index.html" ] || fail "$PLUGIN/web/index.html not found (run build-web.sh first)"
[ -f "$PLUGIN/web/tauri-shim.js" ] || fail "$PLUGIN/web/tauri-shim.js not found"
[ -d "$PLUGIN/native" ] || fail "$PLUGIN/native not found (build an addon first)"

platforms=()
dirs=()
for dir in "$PLUGIN"/native/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  case "$name" in
    darwin-*|linux-*|win32-*) ;;
    *) fail "unexpected native directory: $name" ;;
  esac
  binaries=$(find "$dir" -maxdepth 1 -name '*.node' -type f | wc -l | tr -d ' ')
  [ "$binaries" -ge 1 ] || fail "no .node in $dir"
  dirs+=("$name")
  platforms+=("${name%%-*}")
done
[ "${#dirs[@]}" -gt 0 ] || fail "no native platform directories"

unique_platforms=$(printf '%s\n' "${platforms[@]}" | sort -u)
if [ "$(printf '%s\n' "$unique_platforms" | wc -l | tr -d ' ')" -gt 1 ]; then
  fail "native/ contains multiple OS platforms (${unique_platforms//$'\n'/, }); pack one platform at a time"
fi

PLATFORM=$(printf '%s' "$unique_platforms")
if [ "${#dirs[@]}" -gt 1 ]; then
  ARCH_LABEL="universal"
  for dir in "${dirs[@]}"; do
    case "$dir" in
      *-universal) fail "ambiguous native dir: $dir" ;;
    esac
  done
else
  ARCH_LABEL="${dirs[0]#*-}"
fi

VERSION=$(node -p "require('./$PLUGIN/package.json').version")
TARBALL="$DIST/opentake-studio-route-b-${VERSION}-${PLATFORM}-${ARCH_LABEL}.tgz"
rm -f "$TARBALL"

REPO_ROOT="$(pwd)"
echo "package-from-native: packing $PLUGIN"
echo "package-from-native: native dirs: ${dirs[*]}"
(cd "$PLUGIN" && npm pack --pack-destination "$REPO_ROOT/$DIST" >/dev/null)
PACKED=$(ls -t "$DIST"/opentake-studio-route-b-*.tgz | head -1)
mv "$PACKED" "$TARBALL"
echo "package-from-native: wrote $TARBALL"
tar -tzf "$TARBALL" | sed -n '1,40p'
