#!/usr/bin/env bash
# Build the OpenTake Rust engine Node-API addon and place it where the Route B
# DSH plugin expects it.
#
# Requires: Rust stable (cargo) and the platform C/C++ toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p opentake-node --release

case "$(uname -s)" in
  Darwin) LIB="target/release/libopentake_node.dylib" ;;
  Linux)  LIB="target/release/libopentake_node.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIB="target/release/opentake_node.dll" ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  mingw*|msys*|cygwin*) OS="win32" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
esac

DEST="plugins/opentake-studio-route-b/native/${OS}-${ARCH}"
mkdir -p "$DEST"
cp "$LIB" "$DEST/opentake_engine_v14.node"
echo "Wrote $DEST/opentake_engine_v14.node"
