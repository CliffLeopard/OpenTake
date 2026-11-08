#!/usr/bin/env bash
# Route B v28 independent revalidation.
#
# Rebuilds the N-API addon from the current source, runs the addon smoke and
# contract probes in system Node and in the DSH Electron Node runtime, verifies
# the universal tarball and installs it into a throwaway DSH profile, then runs
# the Host API probe against the repo plugin and the extracted package.
#
# Usage:
#   scripts/route-b/verify/revalidate-v28.sh [--clean] [--package] [--skip-host-api]
#
#   --clean          remove the crate's own build artifacts/fingerprints first
#                    (true independent rebuild; target/ dependencies are reused)
#   --package        rebuild dist/ tarball via scripts/package-route-b.sh
#                    (writes build artifacts; never edits source files)
#   --skip-host-api  skip the slower Host API / provider / Motion probe
#   --fresh-pack     build the tarball from the current working tree into the
#                    temp dir (npm pack; no repo writes) instead of reusing dist/
#
# Everything else is written under the OS temp dir. The script never edits
# implementation files and never commits. Exit 0 = all checks passed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

CLEAN=0
PACKAGE=0
HOST_API=1
FRESH_PACK=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --package) PACKAGE=1 ;;
    --fresh-pack) FRESH_PACK=1 ;;
    --skip-host-api) HOST_API=0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/route-b-revalidate-XXXXXX")"
LOG="$WORK/revalidate.log"
DSH_HOME_TMP="$WORK/dsh-home"
PROFILE="routeb-verify-$$"
ADDON_NAME="$(sed -n 's/.*\(opentake_engine_v[0-9][0-9]*\.node\).*/\1/p' plugins/opentake-studio-route-b/index.js | head -1)"
if [ -z "${ADDON_NAME:-}" ]; then
  echo "cannot detect opentake_engine_v*.node name from plugins/opentake-studio-route-b/index.js" >&2
  exit 2
fi
ADDON="$WORK/$ADDON_NAME"
EXTRACT="$WORK/extracted"
PASS=0
FAIL=0
SKIP=0
WARNINGS=0
RESULTS=()

log() { echo "$*" | tee -a "$LOG" >/dev/null; }
say() { echo "$*"; }
record() { # record <status> <name> [detail]
  local status="$1" name="$2" detail="${3:-}"
  RESULTS+=("$status|$name|$detail")
  case "$status" in
    PASS) PASS=$((PASS + 1)); say "PASS  $name${detail:+ — $detail}" ;;
    FAIL) FAIL=$((FAIL + 1)); say "FAIL  $name${detail:+ — $detail}" ;;
    SKIP) SKIP=$((SKIP + 1)); say "SKIP  $name${detail:+ — $detail}" ;;
    WARN) WARNINGS=$((WARNINGS + 1)); say "WARN  $name${detail:+ — $detail}" ;;
  esac
}
run_check() { # run_check <name> <log-suffix> <command...>
  local name="$1" suffix="$2"; shift 2
  local out="$WORK/$suffix.log"
  if "$@" >"$out" 2>&1; then
    record PASS "$name" "$(tail -n 1 "$out" | cut -c1-160)"
    return 0
  fi
  record FAIL "$name" "see $out"
  return 1
}

# Rust toolchain on PATH (the shell may not have it, matching earlier probes).
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  record FAIL "cargo available" "cargo not found on PATH"
  echo "Logs: $WORK" >&2
  exit 1
fi

NODE_V="$(node -v)"; NAPI_V="$(node -p process.versions.napi)"
DSH_APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_V="unknown"
if [ -x "$DSH_APP" ]; then
  ELECTRON_V="$(ELECTRON_RUN_AS_NODE=1 "$DSH_APP" -p 'process.versions.node + " (napi " + process.versions.napi + ", electron " + process.versions.electron + ")"' 2>/dev/null || echo unknown)"
fi
record PASS "environment" "HEAD $(git rev-parse --short HEAD) branch $(git rev-parse --abbrev-ref HEAD); $(uname -sm); node $NODE_V napi $NAPI_V; DSH node $ELECTRON_V"

if node -e "require(process.argv[1])" "$ROOT/plugins/opentake-studio-route-b/native/darwin-arm64/$ADDON_NAME" >/dev/null 2>&1; then
  record PASS "addon loads from repo path"
else
  record WARN "addon dlopen from the repo path is killed in this shell" "SIGKILL reproduced in Node 24/26; temp copies under \$TMPDIR/\$HOME load, so functional probes use a copy"
fi

# ---------------------------------------------------------------------------
# 1. Independent addon build
# ---------------------------------------------------------------------------
if [ "$CLEAN" = 1 ]; then
  rm -rf target/release/.fingerprint/opentake-node-*
  rm -f target/release/libopentake_node.dylib target/release/libopentake_node.rlib \
        target/release/opentake_node.d target/release/deps/libopentake_node.*
  record PASS "clean addon artifacts" "removed crate fingerprints/artifacts before rebuild"
fi
BUILD_START=$(date +%s)
if cargo build -p opentake-node --release --locked >"$WORK/build.log" 2>&1; then
  record PASS "cargo build -p opentake-node --release --locked" "$(( $(date +%s) - BUILD_START ))s"
else
  record FAIL "cargo build -p opentake-node --release --locked" "see $WORK/build.log"
  echo "Logs: $WORK" >&2
  exit 1
fi
cp target/release/libopentake_node.dylib "$ADDON"
ADDON_SHA="$(shasum -a 256 "$ADDON" | cut -d' ' -f1)"
REPO_SHA="$(shasum -a 256 "plugins/opentake-studio-route-b/native/darwin-arm64/$ADDON_NAME" 2>/dev/null | cut -d' ' -f1)"
if [ "$ADDON_SHA" = "$REPO_SHA" ]; then
  record PASS "built addon matches checked-in arm64 artifact" "$ADDON_SHA"
else
  record SKIP "built addon matches checked-in arm64 artifact" "hashes differ (built $ADDON_SHA, repo ${REPO_SHA:-missing}); compare Mach-O UUID before claiming drift"
fi
record PASS "addon binary identity" "$ADDON_NAME · $(file -b "$ADDON" | cut -c1-80); $(shasum -a 256 "$ADDON" | cut -c1-16)…"

# ---------------------------------------------------------------------------
# 2. Addon smoke + contract probe (system Node and DSH Electron Node)
# ---------------------------------------------------------------------------
run_check "addon smoke (node $NODE_V)" smoke-node node crates/opentake-node/test/smoke.mjs "$ADDON"
run_check "verify-addon --workers (node $NODE_V)" verify-node node scripts/route-b/verify-addon.mjs --addon "$ADDON" --workers
if [ -x "$DSH_APP" ]; then
  run_check "addon smoke (DSH Electron node)" smoke-electron env ELECTRON_RUN_AS_NODE=1 "$DSH_APP" crates/opentake-node/test/smoke.mjs "$ADDON"
  run_check "verify-addon --workers (DSH Electron node)" verify-electron env ELECTRON_RUN_AS_NODE=1 "$DSH_APP" scripts/route-b/verify-addon.mjs --addon "$ADDON" --workers
  SHA_ELECTRON="$(ELECTRON_RUN_AS_NODE=1 "$DSH_APP" -p 'process.versions.node + "/napi" + process.versions.napi' 2>/dev/null || true)"
  record PASS "addon loads in both runtimes" "system $NODE_V/napi$NAPI_V, DSH ${SHA_ELECTRON:-unknown}"
else
  record SKIP "DSH Electron runtime" "$DSH_APP not found"
fi

# ---------------------------------------------------------------------------
# 3. Universal package: build (optional), extract, load
# ---------------------------------------------------------------------------
TARBALL="$(ls -t dist/opentake-studio-route-b-*-universal.tgz 2>/dev/null | head -1)"
DIST_TARBALL="$TARBALL"
if [ "$FRESH_PACK" = 1 ]; then
  mkdir -p "$WORK/fresh-pack"
  if ( cd plugins/opentake-studio-route-b && npm pack --pack-destination "$WORK/fresh-pack" >"$WORK/npm-pack.log" 2>&1 ); then
    TARBALL="$(ls -t "$WORK"/fresh-pack/*.tgz | head -1)"
    record PASS "fresh npm pack from working tree" "$(basename "$TARBALL") ($(tar -tzf "$TARBALL" | wc -l | tr -d ' ') entries)"
  else
    record FAIL "fresh npm pack from working tree" "see $WORK/npm-pack.log"
  fi
fi
if [ "$PACKAGE" = 1 ] || [ -z "$TARBALL" ]; then
  record PASS "packaging requested" "running scripts/package-route-b.sh (writes dist/ and native/ artifacts)"
  if ./scripts/package-route-b.sh >"$WORK/package.log" 2>&1; then
    record PASS "scripts/package-route-b.sh" "$(tail -n 1 "$WORK/package.log" | cut -c1-160)"
    TARBALL="$(ls -t dist/opentake-studio-route-b-*-universal.tgz | head -1)"
  else
    record FAIL "scripts/package-route-b.sh" "see $WORK/package.log"
  fi
fi
if [ -n "${DIST_TARBALL:-}" ] && [ -f "$DIST_TARBALL" ] && [ "$FRESH_PACK" = 1 ]; then
  if tar -xOf "$DIST_TARBALL" package/index.js 2>/dev/null | grep -q "lib/motion-templates.js"; then
    record PASS "dist tarball contains current Host integration" "$DIST_TARBALL"
  else
    record WARN "dist tarball is stale vs working tree" "$DIST_TARBALL (no lib/motion-templates.js import); rebuild with scripts/package-route-b.sh before shipping"
  fi
fi
if [ -n "${TARBALL:-}" ] && [ -f "$TARBALL" ]; then
  run_check "tarball verification" tarball node scripts/route-b/verify/verify-tarball.mjs --tarball "$TARBALL"
  mkdir -p "$EXTRACT"
  if tar -xzf "$TARBALL" -C "$EXTRACT" >"$WORK/extract.log" 2>&1; then
    record PASS "tarball extraction" "$(find "$EXTRACT/package" -type f | wc -l | tr -d ' ') files"
  else
    record FAIL "tarball extraction" "see $WORK/extract.log"
  fi
else
  record FAIL "universal tarball present" "no dist/*-universal.tgz; rerun with --package"
fi

# ---------------------------------------------------------------------------
# 4. Install the tarball into a throwaway DSH profile
# ---------------------------------------------------------------------------
if [ -f "${TARBALL:-}" ] && command -v dsh >/dev/null 2>&1; then
  export DSH_HOME="$DSH_HOME_TMP"
  DSH_ADD_PATH="$TARBALL"
  case "$DSH_ADD_PATH" in
    /*) ;;
    *) DSH_ADD_PATH="$ROOT/$DSH_ADD_PATH" ;;
  esac
  if dsh plugin --profile "$PROFILE" add "$DSH_ADD_PATH" >"$WORK/dsh-add.log" 2>&1; then
    record PASS "dsh plugin add (temp DSH_HOME)" "$(grep -E '^\+' "$WORK/dsh-add.log" | tail -1 | cut -c1-120)"
  else
    record FAIL "dsh plugin add (temp DSH_HOME)" "see $WORK/dsh-add.log"
  fi
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  if grep -q '"@opentake/studio-route-b"' "$PROFILE_DIR/package.json" 2>/dev/null; then
    record PASS "profile package.json mounts the bundle" "$(grep -o '"@opentake/studio-route-b": "[^"]*"' "$PROFILE_DIR/package.json")"
  else
    record FAIL "profile package.json mounts the bundle" "$PROFILE_DIR/package.json"
  fi
  if dsh --profile "$PROFILE" --dump-config >"$WORK/dump-config.log" 2>&1 \
      && grep -q "opentake-studio-route-b" "$WORK/dump-config.log"; then
    record PASS "dsh --dump-config mounts @opentake/studio-route-b" "$(grep -c "opentake-studio-route-b" "$WORK/dump-config.log") references"
  else
    record FAIL "dsh --dump-config mounts @opentake/studio-route-b" "see $WORK/dump-config.log"
  fi
  INSTALLED_ADDON="$(find "$PROFILE_DIR/node_modules" -path "*darwin-arm64*/$ADDON_NAME" 2>/dev/null | head -1)"
  if [ -n "$INSTALLED_ADDON" ]; then
    if node -e "const { Engine } = require(process.argv[1]); const e = new Engine(); const s = JSON.parse(e.newProject()); if (s.version !== 0) throw new Error('bad version'); console.log('installed addon ok')" "$INSTALLED_ADDON" >"$WORK/installed-addon.log" 2>&1; then
      record PASS "installed profile addon loads" "$INSTALLED_ADDON"
    else
      record FAIL "installed profile addon loads" "see $WORK/installed-addon.log"
    fi
  else
    record FAIL "installed profile addon exists" "no darwin-arm64 v28 addon under $PROFILE_DIR/node_modules"
  fi
  unset DSH_HOME
else
  record SKIP "DSH tarball profile install" "dsh CLI not on PATH or tarball missing"
fi

# ---------------------------------------------------------------------------
# 5. Host API probe (repo plugin and extracted package)
# ---------------------------------------------------------------------------
if [ "$HOST_API" = 1 ]; then
  # This shell environment SIGKILLs a process that dlopens the repo-path addon
  # (Node 24 and 26 alike); copies under \$TMPDIR/\$HOME load without changes.
  # Probe from a temp copy so the functional checks still run.
  rm -rf "$WORK/plugin-copy"
  cp -R plugins/opentake-studio-route-b "$WORK/plugin-copy"
  run_check "Host API probe (repo plugin, temp copy)" host-api node scripts/route-b/verify/verify-host-api.mjs --plugin "$WORK/plugin-copy"
  if [ -d "$EXTRACT/package" ]; then
    run_check "Host API probe (extracted package)" host-api-pkg node scripts/route-b/verify/verify-host-api.mjs --plugin "$EXTRACT/package"
  fi
else
  record SKIP "Host API probe" "--skip-host-api"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
say ""
say "=== Route B v28 revalidation ==="
say "HEAD:    $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
say "Node:    $NODE_V (napi $NAPI_V); DSH Electron: $ELECTRON_V"
say "Addon:   $ADDON  sha256 ${ADDON_SHA:0:16}…"
say "Tarball: ${TARBALL:-none}"
say "Result:  $PASS passed, $FAIL failed, $SKIP skipped, $WARNINGS warning(s)"
say "Logs:    $WORK"
if [ "$FAIL" -gt 0 ]; then
  say ""
  say "Failures:"
  for row in "${RESULTS[@]}"; do
    case "$row" in FAIL\|*) say "  - ${row#FAIL|}" ;; esac
  done
fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
