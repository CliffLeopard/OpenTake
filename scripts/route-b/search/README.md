# Route B search probes

Read-only, offline probes for the isolated visual-search slice
[`crates/opentake-search`](../../../crates/opentake-search/). They never download
the ~1.53 GB SigLIP2 ONNX assets and never claim a text fallback is visual
search.

| Script | Purpose |
|---|---|
| `model-assets.mjs` | Inspect the local `<models_dir>/siglip2-base-patch16-256-v2/` layout; report `installed` / `visual_unavailable` + detail. `--hash` streams the 1.53 GB assets through SHA-256 (opt-in, slow). |
| `probe-search.mjs` | Build + run the dependency-free Rust `search-probe` binary and assert the deterministic text fallback and explicit image-query `visual_unavailable` contract. Runs `cargo test --offline`. |
| `search.test.mjs` | `node:test` wrapper for the above; run `node --test scripts/route-b/search/search.test.mjs`. |
| `benchmark-search.mjs` | Synthetic 2,000-asset fallback benchmark through the Rust probe (no model). |

Environment:

- `OPENTAKE_SEARCH_MODELS_DIR` — default models directory for `model-assets.mjs`.
- `CARGO` — override the cargo executable (defaults to `~/.cargo/bin/cargo`).

The Rust crate is standalone (its own `[workspace]`) because the root workspace
is owned by the Route B integration workstream. Promotion into the root
workspace and the Host/addon adapter are documented in
[`docs/architecture/route-b-search.md`](../../../docs/architecture/route-b-search.md).
