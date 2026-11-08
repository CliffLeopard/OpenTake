# Route B playback scripts

Isolated playback slice lives in `crates/opentake-playback` (standalone workspace;
not added to the root `Cargo.toml`).

- `probe.sh` — core tests, cpal feature tests, optional audio-device probe, and
  both demos.
- `benchmark.sh [frames] [queue]` — deterministic decode+tick speed smoke test.

These scripts only build/test the isolated crate; they do not touch the addon or
Host bridge. See `docs/architecture/route-b-playback.md` for integration points.
