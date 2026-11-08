#!/usr/bin/env bash
# Attempt a Route B Linux addon build — or report exactly what is missing.
#
# This script never edits source. It performs a preflight of the real
# prerequisites, then (only when they are genuinely present) either builds with
# the existing `scripts/build-route-b-addon.sh` or runs a CI-style Docker build.
#
# Usage:
#   ./scripts/route-b/platform/build-linux.sh            # preflight only
#   ROUTE_B_ATTEMPT=1 ./scripts/route-b/platform/build-linux.sh
#
# Exit codes: 0 = preflight ready (preflight-only mode) or build succeeded;
#             1 = build attempted and failed; 78 = blocked (missing toolchain/SDK).
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

TARGET="${ROUTE_B_LINUX_TARGET:-x86_64-unknown-linux-gnu}"
DOCKER_IMAGE="${ROUTE_B_DOCKER_IMAGE:-}"
ATTEMPT="${ROUTE_B_ATTEMPT:-0}"
BLOCKED=0

log()  { printf '%-9s %s\n' "$1" "$2"; }
pass() { log PASS "$1"; }
warn() { log WARN "$1"; }
fail() { log BLOCKED "$1"; BLOCKED=$((BLOCKED + 1)); }

if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi

echo "Route B Linux build — host $(uname -s)/$(uname -m), target $TARGET"
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
  *linux-gnu)
    if command -v x86_64-linux-gnu-gcc >/dev/null 2>&1 || command -v x86_64-unknown-linux-gnu-gcc >/dev/null 2>&1; then
      pass "Linux GNU cross-linker present"
    else
      fail "no Linux GNU cross-linker (x86_64-linux-gnu-gcc / x86_64-unknown-linux-gnu-gcc)"
    fi
    ;;
  *linux-musl)
    command -v musl-gcc >/dev/null 2>&1 && pass "musl-gcc present" || fail "no musl linker (musl-gcc)"
    ;;
esac

if command -v zig >/dev/null 2>&1 && command -v cargo-zigbuild >/dev/null 2>&1; then
  pass "zig + cargo-zigbuild present (alternate linker path)"
fi

# The render crate currently enables only the Metal wgpu backend.
if grep -q 'features = \["wgsl", "metal"\]' crates/opentake-render/Cargo.toml 2>/dev/null; then
  fail "opentake-render enables wgpu Metal only; Linux needs a vulkan/gles backend feature (source change outside this task)"
fi

# Container fallback.
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "Docker daemon available"
    if [ -n "$DOCKER_IMAGE" ]; then
      if docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
        pass "Docker image $DOCKER_IMAGE present"
      else
        warn "Docker image $DOCKER_IMAGE not present locally (pull may be blocked)"
      fi
    else
      warn "Docker daemon is up but ROUTE_B_DOCKER_IMAGE is unset; no image to use"
    fi
  else
    fail "Docker CLI present but daemon unreachable"
  fi
else
  fail "no Docker/Podman container runtime"
fi

echo
if [ "$BLOCKED" -gt 0 ]; then
  echo "BLOCKED: $BLOCKED prerequisite(s) missing; no Linux build was attempted."
  echo "Install the Rust target + linker (or run on Linux/CI) and set ROUTE_B_ATTEMPT=1."
  exit 78
fi

if [ "$ATTEMPT" != "1" ]; then
  echo "Preflight OK. Re-run with ROUTE_B_ATTEMPT=1 to build."
  exit 0
fi

if [ -n "$DOCKER_IMAGE" ]; then
  # CI-style container build from the repository root. The image must carry the
  # Rust toolchain plus the Linux system libraries required by the crate.
  echo "Building in Docker image $DOCKER_IMAGE ..."
  docker run --rm -v "$PWD":/src -w /src "$DOCKER_IMAGE" \
    cargo build -p opentake-node --release --target "$TARGET"
  status=$?
else
  echo "Building with the host cross toolchain ..."
  ROUTE_B_TARGET="$TARGET" ./scripts/build-route-b-addon.sh
  status=$?
fi

if [ "$status" -ne 0 ]; then
  echo "BUILD FAILED (exit $status)"
  exit 1
fi
echo "Build finished. Inspect with:"
echo "  node scripts/route-b/platform/inspect-native.mjs plugins/opentake-studio-route-b/native/linux-*/"
exit 0
