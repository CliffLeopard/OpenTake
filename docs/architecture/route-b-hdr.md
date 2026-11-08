# Route B HDR10 linear compositor + export contract

Status: isolated true-HDR10 path implemented, macOS arm64 verified, 2026-11-08,
branch `feat/dsh-rust-engine`. This phase introduces an RGBA16F scene-linear
frame contract and a reference linear compositor in `crates/opentake-render`,
plus a real PQ/BT.2020 HDR10 writer in `crates/opentake-export-pro` with ffprobe
evidence. It does **not** claim the shipped wgpu compositor or shared encoder is
HDR yet — see the claim matrix below.

## 1. Claim matrix (read this first)

| Stage | Implemented status | True HDR? |
|---|---|---|
| `opentake_render::hdr::LinearFrame` RGBA16F scene-linear contract | Implemented + tested | **Yes** (linear BT.2020, `1.0 == 10_000 cd/m²`) |
| `opentake_render::hdr::LinearCompositor` (reference CPU compositor) | Implemented + tested | **Yes for the isolated slice** (preserves >1.0 highlights; full-frame source-over only) |
| `LinearFrame::to_sdr_rgba8` fallback | Implemented + tested | No — explicit BT.709/203-nit clip fallback, `tone_mapped = false` |
| Production wgpu `Compositor` / `RenderLoop` | Unchanged | **No** — still `Rgba8Unorm` SDR; HDR sources are still tone-mapped at decode in `opentake-media::color` |
| `opentake-export-pro` HDR10 writer (linear → PQ/BT.2020 → libx265 Main10 + metadata) | Implemented + real ffprobe/pixel evidence | **Yes** for the frames handed to it |
| `opentake-export-pro` SDR 10-bit encoder (RGBA8 input, HDR tags) | Pre-existing policy path | No — 10-bit precision and metadata only; SDR pixels |
| `opentake_media::ExportPreset` / shared encoder / addon | Not modified (coordination required) | No claim |
| HDR10+ / Dolby Vision / HLG output | Not implemented | No |
| HDR hardware display / OS EDR verification | Not performed | Unknown |

The honest boundary: **the isolated linear compositor + HDR10 writer produce a
true HDR10 bitstream; the app's production compositor still produces RGBA8 SDR
frames, so Route B's normal preview/export path is not HDR yet.**

## 2. What was added

### 2.1 `crates/opentake-render/src/hdr.rs`

- `LinearFrame`: RGBA16F (`half` bits) scene-linear BT.2020 frame, straight
  alpha, RGB `1.0 == 10_000 cd/m²`. Constructors from f32/half bits; pixel/read
  helpers; optional `LinearSourceMetadata` (mastering display, MaxCLL/MaxFALL)
  can be attached so adapters preserve source signalling instead of inventing it.
- `LinearCompositor`: deterministic full-frame source-over compositor in
  scene-linear BT.2020. It does not clamp to [0,1], so highlights above SDR white
  survive. Layers carry straight alpha and an opacity multiplier.
- `LinearFrame::to_sdr_rgba8`: explicit fallback:
  - BT.2020 linear → BT.709 linear (BT.2087 coefficients),
  - 203 cd/m² reference-white scale,
  - hard clip,
  - BT.709 OETF to RGBA8,
  - returns `SdrFallback { tone_mapped: false, mode: Clip }`.
- PQ helpers: `pq_eotf`, `pq_inverse_eotf`, BT.709 OETF, BT.2020→BT.709 matrix.
- `Hdr10Metadata` / `MasteringDisplay`: BT.2020/PQ policy with canonical
  mastering-display token, `max_cll`/`max_fall`, pixel format
  `yuv420p10le`, profile `main10`, and the x265 params payload.
- 6 unit tests: PQ round-trip/non-gamma shape, linear highlight preservation,
  compositor alpha/background behavior, synthetic PQ-frame linear compositing,
  SDR fallback clipping, metadata validation and frame validation.

### 2.2 `crates/opentake-export-pro/src/hdr10.rs`

- `LinearFrame` input contract byte-compatible with the render crate
  (RGBA16F bits, scene-linear BT.2020, `1.0 == 10_000 cd/m²`).
- PQ inverse EOTF per channel, BT.2020 RGB → BT.2020 YCbCr non-constant
  luminance, 4:2:0 chroma averaging, 10-bit limited-range quantisation:
  - Y: `64 + 876 * PQ` (64..940),
  - Cb/Cr: `512 + 896 * chroma` (64..960).
- Raw `yuv420p10le` frames streamed to ffmpeg/libx265:
  - `-c:v libx265 -profile:v main10 -pix_fmt yuv420p10le`,
  - `setparams` frame tags + stream tags for BT.2020/PQ/BT.2020nc,
  - `-x265-params` with `master-display` and `max-cll`,
  - `-movflags +faststart`.
- `Hdr10Spec` validation (even dimensions, fps, CRF, MaxCLL/MaxFALL) and
  `encode_hdr10_frames`.
- `linear_frame_to_sdr_rgba8` + helpers for the controlled SDR-fallback
  comparison (BT.709 tags, clipped at 203 cd/m²; not a tone map).
- `synthetic_hdr10_frames`: four gray bars at scene-linear
  `0.0001/0.0203/0.1/0.4` (≈1/203/1000/4000 cd/m²) plus a moving >HDR highlight
  square; deterministic.
- 6 unit tests: PQ round-trip, limited-range black/white quantisation, HDR10
  argument/tag/metadata assertions, frame validation, synthetic determinism,
  SDR-fallback clipping.

### 2.3 CLI and scripts

- `export-pro hdr10-encode`: synthetic linear frames → true HDR10 MP4; prints a
  JSON report with metadata and x265 params.
- `export-pro sdr-fallback-encode`: the same linear bars clipped at 203 cd/m² and
  encoded BT.709 10-bit; prints `trueHdr: false`.
- `scripts/route-b/export/hdr10-evidence.sh`: builds/tests, encodes both files,
  records policy decisions, ffprobe, raw Y-plane measurement and SHA-256.
- `scripts/route-b/export/hdr10-measure.py`: decodes a raw `yuv420p10le` first
  frame, samples the four bar Y codes and validates either the PQ expectation
  (`--kind hdr`) or the clipped SDR fallback shape (`--kind sdr`).
- `scripts/route-b/export/ffprobe-verify.sh`: now also inspects **frame**
  side-data for Mastering display / Content light metadata (MP4/HEVC exposes
  these on frames, not stream side-data in this ffprobe build).

## 3. HDR10 output policy

Contract defaults (see `Hdr10Metadata::reference_1000nit`):

| Field | Value |
|---|---|
| Codec/profile | HEVC Main 10 (`libx265`, `-profile:v main10`) |
| Pixel format | `yuv420p10le` (4:2:0, 10-bit, limited range) |
| Primaries | `bt2020` |
| Transfer | `smpte2084` (PQ) |
| Matrix | `bt2020nc` |
| Mastering display | BT.2020 primaries, D65, 1000 cd/m² peak, 0.0001 cd/m² black, canonical x265 token `G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)` |
| MaxCLL / MaxFALL | 1000 / 400 cd/m² (validated: >0 and MaxFALL ≤ MaxCLL) |

The metadata is **signalled**, not inferred from SDR pixels: the writer only
accepts scene-linear RGBA16F input and applies PQ itself. Mastering values are a
policy choice today; automatic MaxCLL/MaxFALL computation from frame content is
future work.

The existing `hdr.rs` policy remains the decision layer:
- SDR compositor + PQ source → `Sdr10`, decode-stage VideoToolbox/zscale
  tone-map when available, **not HDR**;
- HDR compositor + passthrough → `Hdr10` with metadata, `toneMapped: false`
  (no tone-map is applied; PQ is authored by the writer);
- no backend → explicitly "not tone-mapped", never silently tagged HDR.

## 4. Real evidence (macOS arm64)

Commands (reproducible):

```bash
scripts/route-b/export/hdr10-evidence.sh /tmp/route-b-hdr10
```

Observed:

```text
== true HDR10: /tmp/route-b-hdr10/hdr10_true.mp4 (11,330 bytes)
codec_name=hevc
profile=Main 10
pix_fmt=yuv420p10le
color_range=tv
color_space=bt2020nc
color_transfer=smpte2084
color_primaries=bt2020
duration=2.000000
frame HDR side-data:
  Mastering display metadata
    red_x=34000/50000 red_y=16000/50000
    green_x=13250/50000 green_y=34500/50000
    blue_x=7500/50000 blue_y=3000/50000
    white_point=15635/50000,16450/50000
    min_luminance=1/10000 max_luminance=10000000/10000
  Content light level metadata
    max_content=1000 max_average=400

== SDR fallback: /tmp/route-b-hdr10/hdr10_sdr_fallback.mp4 (7,471 bytes)
codec_name=hevc profile=Main 10 pix_fmt=yuv420p10le
color_space=bt709 color_transfer=bt709 color_primaries=bt709
frame HDR side-data: none
```

Raw first-frame Y codes (10-bit limited range):

```json
HDR:          measured [195, 573, 723, 855]
expected PQ:  [195, 573, 723, 855]  deltas [0,0,0,0]  distinctAboveSdrWhite=true
SDR fallback: measured [85, 940, 940, 940]  clippedAboveReferenceWhite=true
```

This is the exact distinction requested: the HDR path carries four distinct
PQ levels including 1000/4000 cd/m² highlights; the SDR fallback clips the
203/1000/4000 cd/m² bars to the same SDR white (`940` limited-range) and has no
HDR metadata.

Policy decisions from the same evidence run:

```text
SDR compositor: deliverable=sdr10 toneMapped=true  (decode VideoToolbox tone-map; NOT HDR)
HDR compositor: deliverable=hdr10 toneMapped=false
  x265 params: colorprim=bt2020 transfer=smpte2084 colormatrix=bt2020nc
               master-display=G(13250,34500)B(...)WP(...)L(10000000,1)
               max-cll=1000,400
```

SHA-256 from the run:

```text
f17f82377aa8539905c87d24cc5dfc5123cc7dcf420c8218c2e3e7666c2fdc28  hdr10_true.mp4
bbe2ef2be6a364ceff7d58a07def7c28671d7236663b60d5fff07745dbfc7331  hdr10_sdr_fallback.mp4
83a66831c394aad49849f0a3ca266eb0a1afd95821bc2c13b014dd53548e539c  hdr10-measure.json
ff4d5a87a3d076f8fe096d9c7add329363e9708d6c233befd8cb6227b0f2e5b1  sdr-fallback-measure.json
```

Tests:

```text
cargo test -p opentake-render --lib --offline
  test result: ok. 70 passed; 0 failed  (6 HDR tests included)

cargo test --offline --manifest-path crates/opentake-export-pro/Cargo.toml --lib
  test result: ok. 32 passed; 0 failed

cargo check -p opentake-render --offline
  Finished (macOS arm64; only pre-existing `block` future-incompat warning)
```

## 5. wgpu backend feature change (coordination with docs-writer)

`crates/opentake-render/Cargo.toml` now pins the native wgpu backend per target
so Windows/Linux CI can run:

```toml
wgpu = { version = "23", default-features = false, features = ["wgsl"] }

[target.'cfg(target_os = "macos")'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "metal"] }

[target.'cfg(target_os = "windows")'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "dx12"] }

[target.'cfg(any(target_os = "linux", target_os = "android"))'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "vulkan-portability", "angle"] }
```

wgpu 23's facade names for the Linux request are `vulkan-portability`
(wgpu-core `vulkan`) and `angle` (wgpu-core `gles`); there are no `vulkan`/`gles`
features at the `wgpu` facade. macOS was re-verified after the change.

## 6. Integration points / remaining work

Not touched (explicitly out of this phase/coordination required):

- `crates/opentake-media/src/encode/**` (`ExportPreset`/`VideoEncoder`) and
  `crates/opentake-node/**`: the shared encoder still accepts RGBA8 and writes
  `yuv420p`/`yuv420p10le` without PQ. The HDR10 writer lives in the isolated
  `opentake-export-pro` crate; moving it into the shared encoder needs the Lead's
  coordination.
- `src-tauri/src/render.rs` / `src-tauri/src/export.rs` and the wgpu
  `Compositor`: still RGBA8 SDR. HDR source decode still tone-maps in
  `opentake-media::color`.
- `plugins/opentake-studio-route-b/**`: Route B addon/Host unchanged; no HDR
  export option or preview path is exposed yet.

Required follow-up to make the app path truly HDR:

1. Migrate the wgpu compositor output to `Rgba16Float` (or an HDR-capable second
   compositor) and composite layer textures in scene-linear space; keep the
   existing RGBA8 path as the SDR fallback. Add GPU readback for RGBA16F.
2. Stop tone-mapping HDR sources at decode for the HDR path; preserve source
   primaries/transfer/mastering metadata (`MediaColorMetadata`) through the
   render plan. SDR sources can be linearised or kept on the RGBA8 path.
3. Wire linear frames to a shared HDR10 writer (port `export-pro::hdr10` into
   `opentake-media`/export orchestration once approved), select Main10 +
   metadata from the export settings, and keep the existing SDR/10-bit path as
   the fallback.
4. Auto-compute MaxCLL/MaxFALL (or accept them from settings) instead of the
   fixed reference values; add HDR10+ dynamic metadata and HLG policy if
   required.
5. Verify on Windows/Linux (DX12/Vulkan/GLES), on an actual HDR display/EDR
   pipeline, and with third-party HDR players; current evidence is
   macOS arm64 software/file-level only.
6. Add integration tests comparing linear compositor output against a reference
   (e.g., known PQ patches) and add GPU/HDR decode fixtures.

## 7. Limits of this phase

- HDR claims are limited to the isolated linear frame/compositor/writer path and
  the synthetic proofs above; the production compositor is still RGBA8 SDR.
- The linear compositor supports full-frame source-over only (no transforms,
  masks, effects, LUTs, or partial-frame layers yet). It is a contract/reference
  implementation, not a replacement for the wgpu compositor.
- SDR fallback is a hard clip at 203 cd/m² (by design, `tone_mapped = false`);
  the existing decode-stage VideoToolbox/zscale policy is the perceptual
  HDR→SDR route and is separate.
- Mastering/MaxCLL/MaxFALL are fixed policy defaults; no content analysis.
- ffprobe exposes mastering display/content-light metadata on the first frame,
  not stream side-data, for this MP4/HEVC/x265 build; some players may ignore it.
- HLG, HDR10+, Dolby Vision, and OS/display-level HDR are out of scope.
- The `hdr-policy` decision for an SDR compositor still means "decode tone-map +
  SDR10"; it must never be reported as HDR10 by the UI/export summary.
- No source files outside `crates/opentake-render/**`,
  `crates/opentake-export-pro/**`, `scripts/route-b/export/**`, and this document
  were edited.
