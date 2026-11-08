#!/usr/bin/env bash
# Attempt a Route B Windows addon build — or report exactly what is missing.
#
# This script never edits source. It performs a preflight of the real Windows
# prerequisites (Rust target + MSVC or mingw toolchain), then builds only when
# they are genuinely present. Authenticode signing is checked but never
# attempted without a certificate.
#
# Usage:
#   ./scripts/route-b/platform/build-windows.sh            # preflight only
#   ROUTE_B_ATTEMPT=1 ./scripts/route-b/platform/build-windows.sh
#
# Exit codes: 0 = preflight ready (preflight-only mode) or build succeeded;
#             1 = build attempted and failed; 78 = blocked (missing toolchain/SDK).
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

# MSVC is the default Rust Windows target. `x86_64-pc-windows-gnullvm` is the
# LLVM/mingw alternative and needs llvm-mingw or clang + lld-link.
TARGET="${ROUTE_B_WINDOWS_TARGET:-x86_64-pc-windows-msvc}"
ATTEMPT="${ROUTE_B_ATTEMPT:-0}"
BLOCKED=0

log()  { printf '%-9s %s\n' "$1" "$2"; }
pass() { log PASS "$1"; }
warn() { log WARN "$1"; }
fail() { log BLOCKED "$1"; BLOCKED=$((BLOCKED + 1)); }
note() { log "INFO" "$1"; }

if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi

echo "Route B Windows build — host $(uname -s)/$(uname -m), target $TARGET"
echo

command -v cargo >/dev/null 2>&1 && pass "cargo present ($(cargo --version 2>/dev/null | head -1))" || fail "cargo not on PATH"
command -v rustup >/dev/null 2>&1 && pass "rustup present" || warn "rustup not on PATH; cannot inspect targets"

if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    pass "Rust target $TARGET installed"
  else
    fail "Rust target $TARGET not installed (rustup target add $TARGET)"
  fi
fi

case "$TARGET" in
  *windows-msvc)
    if command -v link.exe >/dev/null 2>&1 || command -v lld-link >/dev/null 2>&1; then
      pass "MSVC-compatible linker present (link.exe/lld-link)"
    else
      fail "no MSVC linker; building $TARGET requires Windows + Visual Studio Build Tools (or cross-compilation with xwin/lld-link)"
    fi
    if [ "${OS:-}" = "Windows_NT" ]; then
      pass "running on Windows (MSVC is native)"
    else
      note "host is not Windows; the MSVC target needs a Windows SDK, libraries and linker (not available on this host)"
    fi
    ;;
  *windows-gnu*|*windows-gnullvm)
    if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || command -v llvm-mingw >/dev/null 2>&1 || command -v x86_64-w64-mingw32-clang >/dev/null 2>&1; then
      pass "mingw/llvm-mingw linker present"
    else
      fail "no mingw/llvm-mingw toolchain for $TARGET"
    fi
    ;;
esac

# The render crate currently enables only the Metal wgpu backend.
if grep -q 'features = \["wgsl", "metal"\]' crates/opentake-render/Cargo.toml 2>/dev/null; then
  fail "opentake-render enables wgpu Metal only; Windows needs a dx12 backend feature (source change outside this task)"
fi

# Authenticode.
if command -v signtool.exe >/dev/null 2>&1 || command -v signtool >/dev/null 2>&1; then
  pass "signtool present"
else
  fail "signtool not available (Authenticode signing cannot be performed on this host)"
fi
note "Windows code-signing certificate: not inspected here; no certificate is assumed present"

# Container fallback (Windows containers are not available on macOS).
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    warn "Docker daemon up, but Windows containers are unavailable on a macOS host"
  else
    fail "Docker CLI present but daemon unreachable"
  fi
else
  fail "no Docker/Windows container runtime"
fi

echo
if [ "$BLOCKED" -gt 0 ]; then
  echo "BLOCKED: $BLOCKED prerequisite(s) missing; no Windows build was attempted."
  echo "Build on a Windows host/CI runner, then rerun this script there with ROUTE_B_ATTEMPT=1."
  exit 78
fi

if [ "$ATTEMPT" != "1" ]; then
  echo "Preflight OK. Re-run with ROUTE_B_ATTEMPT=1 to build."
  exit 0
fi

echo "Building with the host toolchain ..."
ROUTE_B_TARGET="$TARGET" ./scripts/build-route-b-addon.sh
status=$?
if [ "$status" -ne 0 ]; then
  echo "BUILD FAILED (exit $status)"
  exit 1
fi
echo "Build finished. Inspect with:"
echo "  node scripts/route-b/platform/inspect-native.mjs plugins/opentake-studio-route-b/native/win32-*/"
exit 0
