#!/usr/bin/env bash
# Probe the isolated Route B playback slice.
#
# Usage: scripts/route-b/playback/probe.sh
# Runs: deterministic core tests, cpal-feature compile/tests, an optional
# hardware audio-clock probe, and both demos. Hardware output is reported rather
# than required: headless CI may have no audio device.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE="$ROOT/crates/opentake-playback"
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

echo "== route-b playback probe =="
echo "host: $(uname -srm)"
echo "rust: $(rustc --version 2>/dev/null || echo 'rustc unavailable')"
echo "crate: $CRATE"
echo

echo "== default core tests (no cpal/ffmpeg/GPU) =="
cargo test --offline --manifest-path "$CRATE/Cargo.toml" -- --nocapture
echo

echo "== cpal feature build/tests =="
if ! cargo test --offline --manifest-path "$CRATE/Cargo.toml" --features cpal-output --test cpal_output; then
  echo "offline cpal build unavailable; retrying with network access for cpal native deps"
  cargo test --manifest-path "$CRATE/Cargo.toml" --features cpal-output --test cpal_output
fi
echo

echo "== optional hardware audio-clock probe (may skip/fail on headless hosts) =="
if cargo test --manifest-path "$CRATE/Cargo.toml" --features cpal-output \
    --test cpal_output -- --ignored --nocapture; then
  echo "hardware audio probe: PASS (output device callback advanced the clock)"
else
  echo "hardware audio probe: UNAVAILABLE/FAILED (audio-device output is unverified here)"
fi
echo

echo "== deterministic cadence demo (300 frames, queue 8) =="
cargo run --offline --manifest-path "$CRATE/Cargo.toml" --example cadence_demo -- 300 8 30
echo

echo "== wall-clock streaming demo (60 frames) =="
cargo run --offline --manifest-path "$CRATE/Cargo.toml" --example streaming_demo -- 60
echo

echo "probe: OK"
