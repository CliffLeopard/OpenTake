#!/usr/bin/env bash
# Build the OpenTake Rust engine Node-API addon and place it where the Route B
# DSH plugin expects it.
#
# Usage:
#   ./scripts/build-route-b-addon.sh                       # host target
#   ROUTE_B_TARGET=x86_64-apple-darwin ./scripts/build-... # cross target
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

TARGET="${ROUTE_B_TARGET:-}"
if [ -n "$TARGET" ]; then
  cargo build -p opentake-node --release --target "$TARGET"
  OUT="target/$TARGET/release"
  HOST="$TARGET"
else
  cargo build -p opentake-node --release
  OUT="target/release"
  HOST="$(rustc -vV | awk '/^host:/ {print $2}')"
fi

case "$HOST" in
  *apple-darwin) LIB="$OUT/libopentake_node.dylib" ;;
  *linux*) LIB="$OUT/libopentake_node.so" ;;
  *windows*) LIB="$OUT/opentake_node.dll" ;;
  *) echo "Unsupported target: $HOST" >&2; exit 1 ;;
esac

case "$HOST" in
  aarch64-apple-darwin) OS=darwin; ARCH=arm64 ;;
  x86_64-apple-darwin) OS=darwin; ARCH=x64 ;;
  x86_64-unknown-linux-gnu) OS=linux; ARCH=x64 ;;
  aarch64-unknown-linux-gnu) OS=linux; ARCH=arm64 ;;
  x86_64-pc-windows-msvc) OS=win32; ARCH=x64 ;;
  *) echo "Unsupported target: $HOST" >&2; exit 1 ;;
esac

DEST="plugins/opentake-studio-route-b/native/${OS}-${ARCH}"
mkdir -p "$DEST"
cp "$LIB" "$DEST/opentake_engine_v43.node"
echo "Wrote $DEST/opentake_engine_v43.node"
