#!/usr/bin/env bash
# Run the Route B platform checks that can execute on this host.
#
# This is a CI/release checklist, not a build: it verifies the current package
# tarball, the native ABI of the current-platform addon, the package matrix and
# the host toolchain audit, then runs the Linux/Windows build preflights (which
# are expected to report blockers when those toolchains are absent).
#
# Usage: ./scripts/route-b/platform/run-all.sh [--tarball <path>]
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

TARBALL=""
if [ "${1:-}" = "--tarball" ] && [ -n "${2:-}" ]; then
  TARBALL="$2"
fi

status=0
run_check() {
  local label="$1"
  shift
  echo
  echo "=================================================================="
  echo "== $label"
  echo "=================================================================="
  "$@"
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "!! $label exited $code"
    status=1
  fi
  return 0
}

run_check "environment audit" node scripts/route-b/platform/env-audit.mjs
run_check "wgpu platform features" node scripts/route-b/platform/check-wgpu-features.mjs
run_check "web-build prerequisites" ./scripts/route-b/platform/build-web.sh --check
run_check "package matrix" node scripts/route-b/platform/package-matrix.mjs --check
run_check "N-API ABI (static; load covered by verify-package)" node scripts/route-b/platform/abi-compat.mjs --no-load
run_check "native artifact inspection" node scripts/route-b/platform/inspect-native.mjs
if [ -n "$TARBALL" ]; then
  run_check "package verification" node scripts/route-b/platform/verify-package.mjs --tarball "$TARBALL"
else
  run_check "package verification" node scripts/route-b/platform/verify-package.mjs
fi
run_check "signing dry run (skips without Apple secrets)" ./scripts/route-b/platform/sign-macos.sh
run_check "CI workflow / script validation" ./scripts/route-b/platform/validate-workflows.sh

echo
echo "=================================================================="
echo "== Linux build preflight (expected to block without a Linux toolchain)"
echo "=================================================================="
./scripts/route-b/platform/build-linux.sh
linux_code=$?
[ "$linux_code" -eq 0 ] || [ "$linux_code" -eq 78 ] || status=1
echo "Linux preflight exit: $linux_code (78 = blocked by missing toolchain, expected on this host)"

echo
echo "=================================================================="
echo "== Windows build preflight (expected to block off Windows)"
echo "=================================================================="
./scripts/route-b/platform/build-windows.sh
windows_code=$?
[ "$windows_code" -eq 0 ] || [ "$windows_code" -eq 78 ] || status=1
echo "Windows preflight exit: $windows_code (78 = blocked by missing toolchain, expected on this host)"

echo
if [ "$status" -eq 0 ]; then
  echo "run-all: checks completed (platform builds may still be blocked; see exit 78 notes above)"
else
  echo "run-all: at least one check FAILED"
fi
exit "$status"
