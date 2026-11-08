# Route B — visual (SigLIP2) search slice & integration contract

> Status: isolated slice implemented and tested offline · Branch `feat/dsh-rust-engine` @ `5caeb7d`
> Scope owned by this workstream: `crates/opentake-search/**`, `scripts/route-b/search/**`, this doc.
> **Not edited** (integration workstream owns them): `crates/opentake-node/**`,
> `plugins/opentake-studio-route-b/index.js`, root `Cargo.toml`, `docs/architecture/route-b.md`.
> No model weights were downloaded; no addon/Host wiring was changed; nothing was committed.

---

## 1. Executive summary

1. The desktop engine already has a complete SigLIP2 visual-search implementation
   (`crates/opentake-media/src/search/`): pinned ONNX assets, SHA-256 verification,
   `PALMEMB1` embed store, frame sampler, tokenizer, ranker, and a dedicated ORT
   worker. What Route B lacks is **the capability-gated integration**: the Host
   currently fakes model status and returns text-only results.
2. The ~1.53 GB SigLIP2 assets are **not present on this machine**, so no real
   image embedding could be verified here without a download/network approval.
   Instead this workstream delivers an **honest, testable slice**:
   - [`crates/opentake-search`](../../crates/opentake-search/): a dependency-free,
     standalone Rust crate with the exact model manifest, install-layout probe,
     capability verdict (`visual_unavailable` + stable detail code), deterministic
     text fallback (Files + Spoken), a `VisualBackend` hook for the real ORT
     embedder, image-query plumbing, ranking, and camelCase JSON payloads.
   - [`scripts/route-b/search/`](../../scripts/route-b/search/): offline Node probes
     (asset probe, contract test, benchmark) that never download or fake visuals.
3. Without assets *and* a linked backend the slice returns empty `moments` with
   `visualError: "visual_unavailable"` — it never fabricates Moments. With assets
   present but no backend it reports `detail: "backend_not_linked"`; with a
   complete install and a linked backend, callers inject the real backend
   (documented in §7).
4. The Host's current text fallback is behaviorally reasonable for Files/Spoken
   but **reports false capabilities**: `search_model_status` returns
   `installed: true, model: "route-b-text-search"`, and `search_index_start`
   claims all assets indexed. The exact replacement contract and Host mapping
   are in §8–§9.
5. The Rust crate is deliberately **not a root workspace member** (root
   `Cargo.toml` is off-limits here). It uses its own `[workspace]` and builds with
   only `rustc`/`cargo` from `~/.cargo/bin`. Promotion steps for the Lead are in
   §10.

---

## 2. Current state

### 2.1 Desktop SigLIP2 path (source of truth)

| Layer | File | Behavior |
|---|---|---|
| Model identity / thresholds | `crates/opentake-media/src/search/config.rs` | `siglip2-base-patch16-256`, version 2, dim 768, image 256, context 64; `VISUAL_MATCH_COSINE_FLOOR = 0.05`, `RELATIVE_CUTOFF = 0.85`, `SEARCH_LIMIT = 20`; pinned HF revision |
| Manifest / install / verify | `crates/opentake-media/src/search/model_download.rs` | Manifest files + SHA-256; install layout `<models_dir>/<model>-v<version>/`; writes `spec.json` + `manifest.json` receipts only after verification; `installed()` checks receipt + sizes, `verify_installed()` hashes before load |
| Embedder | `.../search/embedder.rs`, `.../search/ort_embedder.rs` | `Embedder` trait, squash-resize preprocessing, ONNX image/text encoders (feature `ort-backend`) |
| Index | `.../search/indexer.rs`, `.../search/embed_store.rs`, `.../search/frame_sampler.rs` | sampled frames → embeddings → `PALMEMB1` f16 store; per-asset cache key; sampler v1, 2 s candidates (4 s for ≥3000 px edge), 8 s coverage floor |
| Query | `.../search/ranker.rs` | dot product, best-per-shot, score sort, absolute floor, limit first then relative cutoff |
| Tauri commands | `src-tauri/src/search.rs` | `search_model_status`, `download_search_model`, `search_index_status`, `search_index_start`, `search_query`; `SearchResultsDto { moments, spoken, files, visualError? }`; empty query returns default; no model → visual empty, Files/Spoken still work |

Desktop `search_query` contract (`SearchResultsDto`, camelCase):
`{ moments: [{ mediaId, frame, startSec, endSec, score, isImage }], spoken: [{ mediaId, startSec, endSec, text, score }], files: [{ mediaId, score }], visualError? }`.

### 2.2 Route B Host fallback (read-only inventory, unchanged)

`plugins/opentake-studio-route-b/index.js` implements `search_*` in JS:

| Case | Current behavior | Problem |
|---|---|---|
| `search_model_status` | `{ installed: true, model: "route-b-text-search", bytes: 0 }` | claims a text fallback is an installed model |
| `download_search_model` | same fake success | no assets exist; user cannot actually get visual search |
| `search_index_status` | `{ modelInstalled: true, indexable: <visual count>, indexed: <count with transcript cache> }` | transcript cache is not a visual index; `modelInstalled` is false |
| `search_index_start` | `{ modelInstalled: true, indexable: N, indexed: N }` | claims indexing without any embeddings |
| `search_query` | `textSearch(query)` over media names + cached transcripts; returns `visualError: "visual embeddings unavailable: Route B text search only"`, `moments: []` | text fallback itself is fine; only status/error vocabulary is ad-hoc |

The Route B verification doc records this as the remaining gap:
“Search — text-only; SigLIP visual search missing” and gap #1 “SigLIP2 visual
search (about 1.54 GB ONNX assets + ONNX Runtime backend)”.
Cross-links: [route-b.md](route-b.md), [route-b-verification.md](route-b-verification.md),
[route-b-media-map.md](route-b-media-map.md) (§3.6/§5: keep the default addon free
of ORT; real search belongs in a Host/helper surface).

`crates/opentake-node` currently exposes **no** `search_*` methods, so the Host
fallback is the only search path.

---

## 3. Delivered isolated slice

### 3.1 Files

```
crates/opentake-search/
  Cargo.toml                 # dependency-free, own [workspace] (not a root member)
  src/lib.rs                 # public re-exports
  src/model.rs               # pinned manifest, install-layout probe, capability verdict
  src/lexical.rs             # deterministic Files + Spoken fallback
  src/service.rs             # VisualBackend hook, ranking, queries, camelCase JSON
  src/sha256.rs              # dependency-free SHA-256 (optional asset verification)
  src/json.rs                # tiny JSON writer
  src/bin/search-probe.rs    # offline CLI probe/benchmark
  tests/fallback_contract.rs # public-API contract tests
scripts/route-b/search/
  model-assets.mjs           # read-only asset probe; never downloads
  probe-search.mjs           # builds/runs the Rust probe; contract assertions
  search.test.mjs            # node:test wrapper (8 tests)
  benchmark-search.mjs       # synthetic fallback benchmark
  README.md
```

### 3.2 Rust API (integration surface)

- `model::probe_models(Option<&Path>, verify_hashes) -> ModelProbe` and
  `model::VisualCapability::evaluate(&ModelProbe, backend) -> VisualCapability`.
- `service::VisualBackend` trait:
  `backend_name()`, `embedding_dim()`, `embed_text(&str)`, `embed_image(&[u8])`.
  `service::NoVisualBackend` is the honest default.
- `service::SearchService::query_text(assets, indexes, query)` →
  `SearchResults`; `query_image(assets, indexes, image)` → `SearchResults`.
- `service::rank(...)` mirrors the desktop ranker (tested for best-per-shot,
  floor, limit, relative cutoff).
- `SearchResults::to_json()` / `VisualCapability::to_json()` are the exact
  payloads the probe CLI prints and the Host adapter should consume.

### 3.3 Capability behavior (tested)

| Assets | Backend | `installed` | `visualAvailable` | `reason` | `detail` |
|---|---|---|---|---|---|
| missing / no dir | none | false | false | `visual_unavailable` | `models_dir_not_configured` / `model_not_installed` |
| wrong size / missing files | none | false | false | `visual_unavailable` | `model_incomplete` / `model_not_installed` |
| hash mismatch (verify on) | none | false | false | `visual_unavailable` | `checksum_mismatch` |
| complete | none | true | false | `visual_unavailable` | `backend_not_linked` |
| complete | `ort-native`/`ort-tract`/custom | true | true | `null` | `null` |
| any | backend error | depends | depends | `visual_error` (results only) | error message |

In every gated case: Files/Spoken still return deterministic matches; `moments`
is empty; `visualError` is explicit. Empty query returns the desktop default
(no error, empty groups).

---

## 4. Model assets (exact)

Pinned revision (immutable HF commit, same as desktop config):
`https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/d1114256522a37ffa257a0a58017348ab0058db2`
(revision `d1114256522a37ffa257a0a58017348ab0058db2`; model version 2).

| Download name | Installed path (under `<models_dir>/siglip2-base-patch16-256-v2/`) | Bytes | SHA-256 |
|---|---|---:|---|
| `onnx/vision_model.onnx` | `image_encoder.onnx` | 371,992,072 | `f5cb16728a704703f05516ded628397e11dbca4de2eb5db04b0c0bcee988aa7a` |
| `onnx/text_model.onnx` | `text_encoder.onnx` | 1,129,469,657 | `d3de4a6bbbfcb429b6615ac496790353cf4a4fc0f19fbbe7179e523ae60daaef` |
| `tokenizer.json` | `tokenizer/tokenizer.json` | 34,363,039 | `cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322` |
| **total** | | **1,535,824,768** (1.430 GiB / 1.536 GB) | |

Install layout produced by the desktop installer:

```
<models_dir>/siglip2-base-patch16-256-v2/
  image_encoder.onnx
  text_encoder.onnx
  tokenizer/tokenizer.json
  spec.json       # EmbedderSpec receipt
  manifest.json   # canonical Manifest receipt (required by desktop installed())
```

Our probe mirrors the size + optional SHA-256 checks and reports
`receiptPresent`; the desktop `installed()` additionally requires the
`manifest.json` receipt to equal the manifest exactly. Provenance/checksum
documentation referenced by `config.rs`: `docs/knowledge/2026-09-06-semantic-search-model.md`.

**Download policy:** the slice never downloads. The Host/desktop must obtain the
assets explicitly; a download is ~1.54 GB over TLS, needs ~3 GiB free space for
download + verify + install staging, and must be user-approved. No such download
was performed here.

---

## 5. Runtime & disk requirements

Measured/pinned facts:

- Steady model storage: **1,535,824,768 bytes (1.43 GiB)**; installer staging
  means budget **≈3 GiB free** if downloading fresh.
- Tokenizer JSON: 34.4 MB loaded by `tokenizers` (onig backend, local file).
- Embedding index: `PALMEMB1` row = 24 bytes metadata + `dim*2` f16 bytes =
  **1,560 bytes/row** (dim 768). Cache path:
  `<cache_root>/Embeddings/<file-identity-key>.embed`.
- Frame sampler v1: candidate interval **2 s** (4 s when the source's longest
  edge ≥3000 px), coverage floor 8 s, luma scene-change shots. Worst case
  (every candidate kept) ≈ 1,800 rows/source-hour ≈ **2.8 MB/source-hour per
  asset**; real usage is lower because only shot representatives are kept.
- Inference memory: estimate (not measured here) **≈1.5–2.5 GB resident** for
  both FP32 ORT sessions plus arenas; budget 2–3 GB. CPU inference on Apple
  Silicon via CoreML EP, CPU fallback elsewhere; Windows uses the pure-Rust
  tract CPU backend.
- Native runtime: the `ort` crate's bundled ONNX Runtime dylib is tens of MB
  (platform-dependent); Windows avoids it via tract. The default Route B addon
  build does **not** link ORT.
- No network at query time; no model load unless assets exist and a backend is
  linked.

---

## 6. ORT vs Tract choice (Route B recommendation)

Desktop pinning (unchanged, reuse it):

| Platform | Runtime | Versions / features |
|---|---|---|
| macOS + Linux | native ONNX Runtime via `ort` | `ort = "=2.0.0-rc.11"`, `default-features = false`, features `std`, `ndarray`, `download-binaries`, `copy-dylibs`, `tls-rustls`; execution-provider preference CoreML (macOS) / CPU (Linux), CPU fallback |
| Windows | pure-Rust tract through `ort` alternative backend | `ort = "=2.0.0-rc.11"` features `std`, `ndarray`, `alternative-backend`; `ort-tract = "=0.2.0"`; `tract-onnx = "=0.22.3"` (fixed-shape input binding requires tract-onnx) |

Why: the shipped Windows product must not depend on Server-only DirectX/ONNX
Runtime entry points, while macOS/Linux keep the pinned native ORT backend used
by the verified desktop engine. Both paths are behind `ort-backend`, off in the
default offline build. `crates/opentake-media/src/ort_worker` serializes heavy
inference and yields to active exports via `ExportPause`.

**Route B artifact recommendation:** keep the primary addon ORT-free (as
`route-b-media-map.md` recommends) and add a **separate optional N-API search
artifact** (e.g. `opentake_search_engine.node`) built from a small wrapper crate
that links `opentake-media` with `ort-backend` and this crate's capability/query
contract. The Host loads it only when the model is installed and the platform is
supported; otherwise it uses the honest fallback in §8. Alternative (simpler but
heavier): a feature-gated search build of the existing addon — accepted only if
startup/size/Windows-tract risks are measured. This workstream did not edit the
addon, so the choice remains with the Lead.

---

## 7. Failure modes

| Condition | `reason` / `detail` | Behavior | Recovery |
|---|---|---|---|
| Host never configured a models dir | `visual_unavailable` / `models_dir_not_configured` | Files+Spoken fallback; moments empty | configure persistent models dir |
| No pinned files | `visual_unavailable` / `model_not_installed` | fallback | user-approved download/install |
| Files present but wrong sizes/incomplete set | `visual_unavailable` / `model_incomplete` | fallback | reinstall/repair |
| SHA-256 mismatch while verifying | `visual_unavailable` / `checksum_mismatch` | fallback | delete + re-download, verify again |
| Complete assets, no inference backend linked | `visual_unavailable` / `backend_not_linked` | fallback | link ORT/tract search artifact |
| Inference/encoder error | `visual_error` + message | moments empty; Files/Spoken still returned | retry, inspect stderr/log |
| Index/query dim mismatch (e.g. stale v1 index) | `visual_error` (`embedding dimension mismatch`) | moments empty | delete stale `.embed`; reindex with v2 |
| Model available but asset not indexed | no error; moments empty | index first; idempotent `needs_index` |
| Empty/whitespace query | no error; all groups empty | desktop default behavior |
| Indexing cancelled / export pause | partial index retained; cancelled asset skipped next time | retry later |
| Model download unavailable in Route B | explicit error (recommended), never fake success | desktop install or approved downloader |
| `search_index_status` when model absent | `modelInstalled:false`, `visualAvailable:false`, `indexed:0` | UI disables “index now” / Moments | install assets |

Stable strings (Host may key on them):
`visual_unavailable`, `visual_error`;
details `models_dir_not_configured`, `model_not_installed`, `model_incomplete`,
`checksum_mismatch`, `backend_not_linked`.

---

## 8. Integration API (exact contract)

### 8.1 Capability / model status

`VisualCapability::to_json()` (also printed by `search-probe --status`):

```json
{
  "model": "siglip2-base-patch16-256",
  "version": 2,
  "expectedBytes": 1535824768,
  "modelsDir": "/path/to/models",
  "installed": false,
  "backend": "none",
  "visualAvailable": false,
  "reason": "visual_unavailable",
  "detail": "model_not_installed"
}
```

- `backend`: `"none"` | `"ort-native"` | `"ort-tract"` | custom backend name.
- `visualAvailable` is true only when `installed` **and** a backend is linked.
- `reason` is `null` when available; `detail` is `null` when available.

Recommended Host `search_model_status` payload (superset of the legacy DTO
`{installed, model, bytes}` so the existing UI keeps working):

```json
{
  "installed": false,
  "model": "siglip2-base-patch16-256",
  "bytes": 1535824768,
  "visualAvailable": false,
  "backend": "none",
  "reason": "visual_unavailable",
  "detail": "model_not_installed",
  "downloadSupported": false
}
```

`downloadSupported: false` is a Host-specific recommendation so the UI does not
offer a non-existent 1.5 GB download; if a real downloader is later wired, set
it true and require explicit user approval.

### 8.2 Query results

Text query (unavailable visual):

```json
{
  "moments": [],
  "spoken": [
    { "mediaId": "a1", "startSec": 1, "endSec": 2, "text": "sunset over water", "score": 1 }
  ],
  "files": [{ "mediaId": "a1", "score": 1 }],
  "visualAvailable": false,
  "visualError": "visual_unavailable",
  "visualErrorDetail": "model_not_installed",
  "queryKind": "text"
}
```

Image query (new; unavailable): same shape with `files: []`, `spoken: []`,
`queryKind: "image"`, and empty `moments`. With a linked backend the payload adds
ranked `moments` entries exactly like the desktop `MomentHitDto`
(`mediaId`, `frame`, `startSec`, `endSec`, `score`, `isImage`) and
`visualError: null`.

Legacy compatibility: the desktop/Tauri DTO carries `moments`, `spoken`,
`files`, `visualError?`; the extra fields (`visualAvailable`,
`visualErrorDetail`, `queryKind`) are additive. Keep `visualError` a string for
the existing UI; do not reuse it for model-status text.

### 8.3 Index status / start

Recommended shape (legacy fields + capability):

```json
{
  "modelInstalled": false,
  "visualAvailable": false,
  "indexable": 12,
  "indexed": 0,
  "reason": "visual_unavailable",
  "detail": "model_not_installed"
}
```

`indexable` = project video/image asset count. `indexed` must mean **visual
embedding indexes only** (not transcript caches). Without a model it must be 0,
and `search_index_start` should be a no-op returning the same status (no fake
`indexed: N`). Spoken/Files search needs no index.

### 8.4 Suggested addon methods (future integration; not implemented here)

Names are a proposal for the Lead, matching the existing camelCase N-API style:

```text
Engine.searchConfigure(modelsDir: string, cacheRoot: string) -> string   // JSON capability
Engine.searchModelStatus() -> string                                     // JSON capability
Engine.searchIndexStatus() -> string                                     // JSON index status
Engine.searchIndexStart() -> string                                      // JSON index status
Engine.searchQuery(query: string) -> string                              // JSON results (text)
Engine.searchQueryImage(imageBase64: string) -> string                   // JSON results (image)
```

Implementation notes for the addon wrapper: reuse `opentake_media::search::*`
(`probe_models`, `OrtEmbedder`, `embed_store`, `frame_sampler`, `ranker`) for the
real path; for the fallback path, build `Asset`/`Cue` values from the addon media
catalog + cached transcripts and call this crate. `modelsDir`/`cacheRoot` must be
persistent Host paths (not `tmpdir()`), user-visible, and passed once.

### 8.5 Minimal honest Host-only patch (no Rust changes required)

Even before the addon gains search methods, the Host fallback can stop lying by
changing only its `search_*` cases:

| Case | Replace current with |
|---|---|
| `search_model_status` | `{installed:false, model:"siglip2-base-patch16-256", bytes:1535824768, visualAvailable:false, backend:"none", reason:"visual_unavailable", detail:"model_not_installed", downloadSupported:false}` |
| `download_search_model` | explicit unsupported error (e.g. `Error("SigLIP2 model download is not available in Route B; install the 1.53 GB assets on desktop or via an approved installer")`), never fake success |
| `search_index_status` | `{modelInstalled:false, visualAvailable:false, indexable:<visual count>, indexed:0, reason:"visual_unavailable", detail:"model_not_installed"}` |
| `search_index_start` | same as index status (no fake indexing) |
| `search_query` | keep `textSearch`, but return `{moments:[], spoken, files, visualAvailable:false, visualError:"visual_unavailable", visualErrorDetail:"model_not_installed", queryKind:"text"}` |

This preserves Files/Spoken UX, stops the UI from believing visual search is
available, and gives the Lead a safe intermediate step before the real addon.

---

## 9. Verification (commands & observed results)

Toolchain note: this shell does not put cargo on `PATH`; use
`export PATH="$HOME/.cargo/bin:$PATH"`. Cargo 1.99.1 / rustc 1.99.1.

```console
$ cd crates/opentake-search
$ cargo test --offline
test result: ok. 26 passed; 0 failed  (lib: sha256/model/lexical/service)
test result: ok. 2 passed; 0 failed   (tests/fallback_contract.rs)

$ cd ../..
$ node --test scripts/route-b/search/search.test.mjs
ℹ tests 8   ℹ pass 8   ℹ fail 0

$ node scripts/route-b/search/probe-search.mjs
PASS cargo test --offline (26 unit tests in lib)
PASS node model-assets probe is consistent with the Rust capability
PASS text query fallback: files=2 spoken=1 moments=0
PASS image query fallback: visual_unavailable, moments=0
PASS deterministic fallback (repeated queries byte-identical)
PASS visual_unavailable is explicit: no fabricated Moments without assets + backend

$ node scripts/route-b/search/benchmark-search.mjs --iterations 500
assets=2000 cues=2000 iterations=500
total=5569.5µs  avg=11.14µs/query  hits=20000   (single debug-build run; timings vary)

$ node scripts/route-b/search/model-assets.mjs --models-dir /tmp/.../models
{
  "capability": {
    "model": "siglip2-base-patch16-256",
    "version": 2,
    "expectedBytes": 1535824768,
    "installed": false,
    "backend": "none",
    "visualAvailable": false,
    "reason": "visual_unavailable",
    "detail": "model_not_installed"
  },
  "probe": { "state": "missing", "receiptPresent": false, "files": [ ... ] }
}
```

Rust coverage highlights:

- `sha256`: FIPS vectors + 1M-byte vector + streaming file digest.
- `model`: pinned constants/total bytes; missing/incomplete/wrong-size/hash-mismatch
  states; complete assets with `backend:none` still gated (`backend_not_linked`);
  custom small pins keep tests fast (no 1.5 GB reads).
- `lexical`: case-insensitive, input-order deterministic Files/Spoken; kinds;
  limits; empty query; byte-identical repeats.
- `service`: no-backend fallback (text/image), capability-without-backend gating,
  mock backend text + image ranking, backend error reporting, best-per-shot /
  floor / limit / cutoff, JSON determinism and camelCase.
- Integration tests: public-API fallback contract + complete-assets-no-backend
  gating (synthetic pins, no asset download).

Node coverage: crate tests pass; text fallback assertions (files `a1,a3`,
spoken `sunset over water`); image query `visual_unavailable`; deterministic
repeat; pinned manifest facts vs desktop; missing/empty/wrong-size asset probes;
no fake installs.

Not verified here (requires assets/approval): real `OrtEmbedder` text/image
inference, true embedding similarity, ORT/tract runtime on each platform, real
model download/verify.

---

## 10. Promotion & integration checklist (for the Lead)

Root workspace/addon/Host edits were out of scope for this workstream; these are
the exact follow-ups:

1. **Workspace membership:** add `"crates/opentake-search"` to root
   `Cargo.toml` members and `opentake-search = { path = "crates/opentake-search" }`
   under `[workspace.dependencies]`; remove the crate's local `[workspace]` table
   and switch its version/license/repository to `*.workspace = true` if desired.
2. **Search artifact:** decide between a separate optional N-API search addon
   (recommended; keeps the primary addon ORT-free) and a feature-gated build of
   the existing addon. Whichever is chosen must link `ort-backend` only in that
   artifact and expose the methods in §8.4.
3. **Host fallback patch:** apply §8.5 immediately in
   `plugins/opentake-studio-route-b/index.js` (honesty fix, no Rust needed).
4. **Real assets:** choose a persistent models dir (e.g.
   `<Host app-data>/OpenTake/models`), implement/prepare an approved downloader
   (~1.54 GB; budget ~3 GiB free; SHA-256 verified), and gate it behind explicit
   user consent. Until then `visualAvailable` stays false.
5. **Host delegation:** when the search artifact reports
   `visualAvailable:true`, route `search_query` / new image query to it; keep the
   JS fallback for Files/Spoken and for `visualAvailable:false`.
6. **UI:** the existing Moments/Spoken/Files panel already consumes
   `visualError`; consume the new `visualAvailable`/`detail` to disable Moments
   and show an honest “visual search requires 1.5 GB model” prompt only when a
   downloader is actually available. `indexed` must switch to visual-embedding
   semantics (transcript cache no longer counts).
7. **Acceptance:** `cargo test --offline` (crate), `node --test
   scripts/route-b/search/search.test.mjs`, the probe suite, then a real-asset run
   on macOS (ORT/CoreML) and Windows (tract) with a user-approved download; record
   exact model hashes and per-platform timings before claiming full parity.

---

## 11. Risks & open questions

| Risk | Impact | Mitigation |
|---|---|---|
| Host still reports fake model/index status until §8.5 lands | UI promises visual search that cannot work | ship the one-file honest fallback patch first |
| Manifest constants duplicated in Rust and `scripts/.../model-assets.mjs` | drift | Node test cross-checks `expectedBytes`; add a `cargo`-generated JSON manifest or a shared fixture later |
| No real ORT inference verified here | real embeddings/timings unknown | requires user-approved download + platform run |
| Model download is ~1.54 GB / ~3 GiB staging | network/disk/user consent | explicit approval flow; never auto-download |
| Windows tract fixed-shape binding is version-sensitive | Windows search may fail to load encoders | keep pinned `ort-tract 0.2.0` / `tract-onnx 0.22.3`; verify on Windows |
| `indexed` semantic change | UI may show “0 indexed” after update | migrate UI to visual index semantics and label transcript search separately |
| Standalone crate not in CI workspace | regressions unseen by root CI | add workspace member (step 1) so `cargo test --workspace` covers it |
| Image-query payload size | base64 images can be large | cap (e.g. 16 MB) and validate in the addon wrapper before decoding |
| Model v2 vs old v1 indexes | stale embeddings silently skipped | `Embeddings` header `modelVersion` check already exists; document reindex |

Open questions for the Lead: (a) separate search addon artifact vs feature-gated
build; (b) persistent models dir location and whether DSH should ever download
the 1.5 GB; (c) whether Host should expose image-to-search at all in the first
milestone (no current UI); (d) whether to promote the crate into root workspace
now (CI coverage) or after the addon integration stabilizes.

---

## 12. Appendix — provenance & inventory

- Pinned facts copied from `crates/opentake-media/src/search/config.rs` and
  `model_download.rs` (revision, names, sizes, SHA-256, install layout).
- Desktop thresholds and ranking semantics from `.../search/ranker.rs`,
  `.../search/config.rs`.
- Codec/index math from `.../search/embed_store.rs` (row = 24 + dim×2) and
  `.../search/frame_sampler.rs` (2 s/4 s interval, 8 s coverage floor, sampler v1).
- ORT/Tract pinning and feature flags from `crates/opentake-media/Cargo.toml`
  (`ort-backend` target-specific dependencies).
- Host fallback inventory from `plugins/opentake-studio-route-b/index.js`
  (`search_*` cases; `CACHE_ROOT = path.join(os.tmpdir(), "opentake-route-b")`).
- Route B context from [route-b.md](route-b.md), [route-b-media-map.md](route-b-media-map.md),
  [route-b-verification.md](route-b-verification.md).
- New files in this workstream: `crates/opentake-search/**`,
  `scripts/route-b/search/**`, this document. Nothing else was modified or
  committed.

---

## 13. Real ORT integration (task-66)

The user approved the ~1.43 GiB SigLIP2 download, so the slice was wired to real
inference in the Route B addon.

### 13.1 Enabled feature / build profile

- `crates/opentake-node/Cargo.toml`: `opentake-media = { workspace = true, features = ["ort-backend"] }`.
  This turns on the existing pinned ORT backend (`ort = 2.0.0-rc.11`,
  `download-binaries`/`copy-dylibs`; Windows uses `ort-tract` + `tract-onnx`),
  and no new crate is added to the workspace.
- The crate-level `opentake-search` contract/fallback stays independent; the
  addon uses `opentake-media::search` directly for real inference.
- Measured on macOS arm64, debug build: addon `libopentake_node.dylib` grew from
  a ~45 MB shipped `v38` artifact baseline to **116.8 MB** including the
  **71 MB static `libonnxruntime.a`** downloaded to
  `~/Library/Caches/ort.pyke.io/...`. Release builds are expected to be smaller;
  measure the shipped package before release. Windows links tract instead of the
  native ORT dylib.
- No weights are committed; the model directory is user/persistent data only.

### 13.2 Addon search methods (additive)

Added to `crates/opentake-node/src/lib.rs` (search-only edits). JS names are the
camelCase forms:

| Method | Arguments | Returns |
|---|---|---|
| `searchConfigure` | `modelsDir`, `cacheDir` | capability JSON; verifies pinned sizes + SHA-256 and loads both encoders (`OrtEmbedder`); `modelsDir` may be the models root or the version dir |
| `searchModelStatus` | — | capability JSON without loading (`models_dir_not_configured` before configure) |
| `searchIndexStatus` | `assetsJson` | `{modelInstalled,visualAvailable,indexable,indexed,reason,detail,errors}`; `indexed` means current visual `.embed` indexes |
| `searchIndexStart` | `assetsJson` | same shape after indexing images directly and videos via sampled frames (`index_video`), idempotent, per-asset errors |
| `searchQuery` | `query`, `assetsJson`, `fps?` | `{moments,visualAvailable,visualError,visualErrorDetail,queryKind:"text"}` |
| `searchQueryImage` | `imageBase64`, `assetsJson`, `fps?` | same with `queryKind:"image"` |

`assetsJson` is an array of `{id, path, kind: "image"|"video", durationSecs?, width?, height?}`
(`type` is accepted as an alias for `kind`). The addon never invents project
assets: the Host passes its current media list. Files/Spoken text search remains
the Host fallback; the addon returns only real visual Moments (or an explicit
`visual_unavailable`/`visual_error`).

Real index storage uses the existing `PALMEMB1` format under
`<cacheDir>/Embeddings/<file-identity-key>.embed`; model verification uses the
desktop `installed()` + `verify_installed()` (sizes and SHA-256), and loading uses
`ort_embedder::OrtEmbedder` with the desktop `EmbedderSpec`.

### 13.3 Installer / staging (no committed weights)

`scripts/route-b/search/install-model.mjs`:

- `--check-only`: report raw/canonical file bytes without reading hashes.
- default: wait for exact pinned sizes, stream SHA-256 over all assets, verify,
  then **rename** raw HF files (`onnx/vision_model.onnx`, `onnx/text_model.onnx`)
  into the canonical layout (`image_encoder.onnx`, `text_encoder.onnx`,
  `tokenizer/tokenizer.json`) and write `manifest.json` + `spec.json` receipts.
  Idempotent; a checksum mismatch is reported, never staged.
- `--download` (user-approved): resume/fetch missing pinned assets from the
  pinned Hugging Face URLs, then verify/stage. During task-66 the Lead took over
  the single-file resume after parallel-range fetching conflicted; no downloader
  remains part of the automated test path.

### 13.4 Real-inference proof

```console
# prereqs: staged canonical assets + cargo build -p opentake-node
$ node --test --test-timeout=600000 scripts/route-b/search/real-inference.test.mjs
```

The test loads the N-API addon, generates deterministic red/blue/green PNG
fixtures, configures real ORT, indexes them, then:
1. text query `"a solid red square"` must return non-empty Moments from the real
   SigLIP2 text encoder;
2. base64 image query of the red fixture must return the red asset first with
   self-similarity > 0.9;
3. an unconfigured addon and an empty model dir must report
   `visual_unavailable` (`models_dir_not_configured` / `model_not_installed`)
   rather than fake success.

Observed after the approved download was staged (2026-11-08, macOS arm64, debug
addon, `OrtEmbedder` via `ort 2.0.0-rc.11` / CoreML with CPU fallback):

```console
$ node scripts/route-b/search/install-model.mjs --models-dir ~/.dsh/opentake/models/siglip2-base-patch16-256-v2
verified=true installed=true staged=true
  image_encoder.onnx: 371992072/371992072 sha256=ok
  text_encoder.onnx: 1129469657/1129469657 sha256=ok
  tokenizer/tokenizer.json: 34363039/34363039 sha256=ok

$ node --test --test-timeout=900000 scripts/route-b/search/real-inference.test.mjs
✔ addon loads and reports an honest unconfigured capability
✔ missing/corrupt model dir is capability-gated (no fake success)
✔ corrupt (wrong-byte, right-size) assets report checksum_mismatch
real text query moments: [{"mediaId":"red","frame":0,"startSec":0,"endSec":0,"score":0.15864377,"isImage":true}]
real image query top moment: {"mediaId":"red","frame":0,"startSec":0,"endSec":0,"score":1.0000215,"isImage":true}
real video index/query moments: [{"mediaId":"red",...,"score":1.0000215,"isImage":true},{"mediaId":"red-video","frame":0,"startSec":0,"endSec":2,"score":0.9938898,"isImage":false},...]
✔ real SigLIP2 inference: text + image query into Moments (74532ms)
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

Interpretation: the real text encoder matched `"a solid red square"` to the red
fixture (only red cleared the 0.05 floor / 0.85 relative cutoff among the three
solid colours); the real image encoder returned the same red fixture as the top
self-match at ≈1.0 cosine. Model load + 3-image indexing + both queries took
~74 s in this debug build; the loaded model is the dominant RAM cost (§5).

(Earlier deterministic fallback coverage: 26 Rust unit + 2 integration tests and
8 Node contract tests; see §9.)
