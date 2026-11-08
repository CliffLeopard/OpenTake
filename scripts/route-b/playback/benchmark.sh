#!/usr/bin/env bash
# Lightweight benchmark for the Route B playback core.
#
# Usage: scripts/route-b/playback/benchmark.sh [frames] [queue-capacity]
# Measures the deterministic decode+tick cadence (no hardware) and reports
# per-frame wall time. This is a smoke benchmark, not a GPU/ffmpeg benchmark.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE="$ROOT/crates/opentake-playback"
FRAMES="${1:-1000}"
QUEUE="${2:-8}"
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

echo "== route-b playback deterministic benchmark: frames=$FRAMES queue=$QUEUE =="
/usr/bin/python3 - "$CRATE" "$FRAMES" "$QUEUE" <<'PY'
import subprocess
import sys
import time

crate, frames, queue = sys.argv[1], sys.argv[2], sys.argv[3]
command = [
    "cargo", "run", "--offline", "--quiet", "--manifest-path", f"{crate}/Cargo.toml",
    "--example", "cadence_demo", "--", frames, queue, "30",
]
start = time.monotonic()
proc = subprocess.run(command, capture_output=True, text=True)
elapsed = time.monotonic() - start
if proc.returncode != 0:
    print(proc.stdout)
    print(proc.stderr, file=sys.stderr)
    raise SystemExit(proc.returncode)
lines = [line for line in proc.stdout.strip().splitlines() if line]
for line in lines[-3:]:
    print(line)
total = max(int(frames), 1)
print(f"elapsed={elapsed:.3f}s frames={frames} per_frame={elapsed / total * 1e6:.1f}us (includes cargo startup)")
PY
echo "benchmark: OK"
