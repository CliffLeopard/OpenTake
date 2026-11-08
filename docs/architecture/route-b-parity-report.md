# Route B — final verification (v41)

| | |
|---|---|
| Status | **Final v41 integration verification** — verified on the tagged-worktree build, package and live DSH client |
| Branch / commit | `feat/dsh-rust-engine` @ `5167c60` (`feat(route-b): HDR audio + affine layers, native inspector/export/settings`); worktree has only the Lead-owned `scripts/build-route-b-addon.sh` version bump (v41) and this verifier's report/script changes |
| Addon | `opentake_engine_v41.node` — arm64 sha256 `81cbf44ca07e3a6fdd7a62e743eb03ab58f434ba6f5c61e385c4a881f9456b44` (45.4 MiB, ORT); x64 `0344f9be9d6b3742f4fe2979178e953f139942401fe99bc6c2079275639d22cd` (43.3 MiB, tract) |
| Final package | `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256 `c9e2eeb0309eaecb81ee4c5e816d8d09a12c6cb48a46b3873da0e1ecc334addc`, 28,252,419 B, 24 files, both v41 slices, current index, `lib/search/*`, native-editor bundle |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — all three files match pinned SHA-256; complete |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg/ffprobe 9.0.2 · Chrome 157 · no Rosetta, 0 signing identities, no `pwsh` |

Method: every item below was re-run against v41; no implementation file was
edited and nothing was committed by the verifier. The DSH live checks used the
authenticated Chrome CDP session at `127.0.0.1:9333` (page
`http://127.0.0.1:56474/`); the 9230 host inspector exposes no DOM.

## 1. Final matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v41 addon build / ABI / load | **Verified (functional)** | smoke OK; `verify-addon --workers` **22 passed, 2 warnings, 0 failed** in Node 26 and DSH Node 24; revalidate **19 passed, 0 failed, 1 skipped, 0 warnings**. A clean build yields sha256 `589b0b11…` vs checked-in `81cbf44c…`, but both carry the **same LC_UUID `FF175789-F215-3E45-B0B7-442F56E4DA99`** and the same code-section total (103,440 bytes); the byte difference is only `__LINKEDIT` (13,647,872 vs 12,845,056 — stripped/signed packaging), so it is not a source drift; revalidate reports SKIP, not failure. |
| 2 | Final package + DSH profile install | **Verified** | dist universal **12 passed, 1 warning, 0 failed (13 checks)**: 24 files, both v41 slices byte-equal to repo, correct index (`01c10432…`), packaged addon smoke, packaged plugin loads **32 tools**; fresh `npm pack` also 24 entries/12-13; temp-`DSH_HOME` `dsh plugin add` + `--dump-config` + installed arm64 v41 loads. |
| 3 | HDR audio + affine/multi-layer expansion | **Verified (v41, shipped)** | Workstream evidence hashes reproduced exactly: `production_hdr10.mp4` **fefc97e6…**, `production_hdr10_transformed.mp4` **2e9eee11…**, `production_sdr10.mp4` **5097ce9e…**. `verify-hdr-expansion` on v41: audio export summary `hdr10:true, hasAudio:true`, ffprobe **HEVC Main10 / yuv420p10le / bt2020 / smpte2084 / bt2020nc + AAC LC 48 kHz mono**; two overlapping HDR layers (affine transform/rotation + opacity 0.5) produce Main10/PQ; transformed pixel evidence inside=182 / outside=64; SDR source rejected. |
| 4 | Native Inspector/Export/Settings panels + live HDR export | **Verified live (v41)** | CDP: native `OpenTake（原生）` → `原生预览` ShadowRoot; header actions `检查器/导出/设置`; Inspector fields for opacity/volume/position/scale/rotation (opacity 1→0.5 incremented timeline v2→v3, undo restored); move right 0→1/v3 + undo; Settings shows storage/model/search-index; fallback restores iframe `/opentake-studio-route-b/app/`. Native Export panel: all fields including hdr10/duckMusic; live HDR export on a temp project returned `{hdr10:true,hasAudio:true,frameCount:10}` and `/tmp/native-hdr-v41.mp4` is **Main10/PQ with AAC** (host addon v41 loaded). |
| 5 | HDR10 ffprobe vs SDR/false-HDR | **Verified** | HDR output: Main10/yuv420p10le/bt2020/smpte2084/bt2020nc + mastering/content-light metadata; SDR output (same project, hdr10=false) is Main10 but bt709 with no HDR metadata; `verify-hdr10.mjs` classifies true HDR as `hdr10`, SDR as `sdr`, a 10-bit SDR file re-tagged PQ without mastering metadata as `false-hdr`; SDR-source HDR requests fail with `HDR10 export requires HDR sources`; H.264+HDR fails `requires codec h265`; native panel live HDR request **hasAudio true**. |
| 6 | Native bundle serving / package | **Verified** | repo bundle `/app/native-editor/native-editor.js` sha/size current (255,980 B, contains open-inspector/export/settings); Host API serves it; dist package contains the same bundle; native-editor tests **14/14**, shell tests **11/11**. |
| 7 | SigLIP2 model + real search (regression) | **Verified** | model complete, pinned SHA-256 (image `f5cb1672…`, text `d3de4a6b…`, tokenizer `cb9140fa…`, receipts); Host API extracted v41: real Host search PASS (installed/visual true, indexed 4, text Moments, image self-match); addon real search PASS (text `red`→red-video 0.1321, image red→red-video 0.9999 > blue 0.9559, `ort-native`). |
| 8 | Playback / export / motion / providers | **Verified on macOS arm64** | Host API 31/32: cpal playback + multipart stream, JPEG preview, denoise/loudness/stabilization, SDR 10-bit H.265, ducking, ASR/captions, Motion doc+template, native bundle route; providers only loopback mocks. |
| 9 | x64 search parity | **Static Verified / runtime Unknown** | v41 x64 is a tract build (`hasTract:true, hasOrtNative:false, hasOrtLinkage:false, ok:true`), no ONNX/CoreML linkage; package ships it. No Rosetta on this arm64 host, so x64 runtime/inference quality remains Unknown. |
| 10 | CI / signing | **Partial / external resources pending** | workflow 5 jobs validates (YAML, pinned SHAs, scripts); wgpu readiness READY all; mac signing dry-run SKIP (0 identities); local Linux/Windows preflights exit 78; no `pwsh`; no CI run or signing. |

## 2. Evidence and commands

### 2.1 Addon/package
```bash
bash scripts/route-b/verify/revalidate-v28.sh --fresh-pack
# 19 passed, 0 failed, 1 skipped (build byte-hash packaging variant), 0 warnings
# dist tarball index matches working tree — 01c10432…
# tarball verification 12/13; extraction 24 files; temp-DSH install; installed v41 loads
# Host API probe (repo plugin, temp copy) 31 passed, 0 failed (32 checks)
# Host API probe (extracted package) 31 passed, 0 failed (32 checks)

node scripts/route-b/verify/verify-tarball.mjs \
  --tarball dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz
# 12 passed, 1 warning, 0 failed — 24 files, addon v41, packaged plugin loads 32 tools

DSH_HOME=/tmp/v41-dsh dsh plugin --profile v41 add dist/…universal.tgz
# installed darwin-arm64/opentake_engine_v41.node sha256 81cbf44c…
```
Clean-build/reproducibility note: `cargo build -p opentake-node --release --locked` from `5167c60` gives `589b0b11…`; the checked-in `81cbf44c…` has the same LC_UUID and same code-section total, smaller `__LINKEDIT` (stripped/signed packaging). Functional ABI/behaviour is verified in both runtimes; byte-for-byte rebuild equality is not claimed because the packaging/strip step is not reproduced by the plain build.

### 2.2 HDR audio/affine/multi-layer (media-dev evidence reproduced)
```bash
bash scripts/route-b/export/hdr10-production-evidence.sh /tmp/route-b-hdr10-v41-evidence
# PASS; hashes exactly:
# fefc97e67cb73189… production_hdr10.mp4
# 2e9eee11c881227d… production_hdr10_transformed.mp4
# 5097ce9eb35087c5… production_sdr10.mp4
# transform pixel evidence: insideY 182 / outsideY 64; PQ HDR pass; SDR tone-mapped pass

node scripts/route-b/verify/verify-hdr-expansion.mjs \
  --addon plugins/opentake-studio-route-b/native/darwin-arm64/opentake_engine_v41.node
# PASS: audio= aac 48000 Hz mono + Main10/PQ; 2 layers transformed/opacity;
#       SDR refused
node scripts/route-b/verify/verify-hdr10.mjs /tmp/.../production_hdr10.mp4
# hdr10 PASS (mastering + content-light)
```
Live native-panel HDR export on a temp project (`/tmp/routeb-native-hdr-v41.opentake`,
one affine HDR video layer + audio, v41 Host addon):
summary `{hdr10:true,hasAudio:true,frameCount:10,metadata:{primaries:bt2020,transfer:smpte2084,...}}`;
ffprobe `/tmp/native-hdr-v41.mp4`: HEVC Main 10/yuv420p10le/bt2020/smpte2084 + AAC.

### 2.3 Native Inspector/Export/Settings (live CDP)
Authenticated Chrome CDP 9333 → `http://127.0.0.1:56474/`; live engine info reported
`native/darwin-arm64/opentake_engine_v41.node`, loaded.

- **Inspector**: selected clip; fields opacity/volume/centerX/centerY/width/height/
  rotation; opacity 1→0.5 → engine `version 2→3`, clip opacity 0.5; undo →
  opacity 1/version 4.
- **Timeline edit**: `右移` moved startFrame 0→1 (version 3); `撤销` restored
  (version 4).
- **Export**: native sheet fields outPath, codec (h264/h265/prores/prores4444),
  quality, bitDepth 8/10, range start/end, duckMusic, hdr10; HDR export above
  completed successfully through the live Host engine.
- **Settings**: storage categories, search model `ready · siglip2-base-patch16-256`,
  transcription `not configured`, search-index JSON.
- **Fallback**: `Iframe 编辑器` restored `/opentake-studio-route-b/app/`; iframe
  is the default/fallback and native preview can be toggled again.
- Screenshots: `/tmp/live-native-panels.png`, `/tmp/live-native-editor-mode.png`,
  `/tmp/live-native-v40-verifier.png`; native tests 14/14, shell 11/11.

### 2.4 Search/model
`verify-search-model.mjs` exit 0 (complete); Host API real search PASS
(`installed:true, visualAvailable:true, backend:ort-native`, indexed 4, text
Moments, image self-match); addon `verify-real-search` PASS with text/image
scores above.

### 2.5 x64 / CI
`arch-capability.mjs` v41 x64: expectedBackend tract, `hasTract:true`,
`hasOrtLinkage:false`, `ok:true`; cannot execute x64 (no Rosetta).
`validate-workflows.sh` OK; wgpu READY macOS/Windows/Linux; `sign-macos.sh`
SKIP (0 identities); local Linux/Windows preflight exit 78; `verify-ci-signing`
8 PASS + 1 WARN (no `pwsh`); no CI run/signing/notarization.

## 3. Remaining limits / blockers

1. **HDR supported subset** — HDR PQ video, static affine transform/opacity, mixed
   AAC audio, multiple HDR video layers; no crop/masks/effects/grades/LUT/chroma
   key/stabilization/transitions/reverse/nested sequences, text/image layers,
   visual keyframe tracks or HLG; range exports mux the full timeline mix. The
   production wgpu compositor/preview remains RGBA8 SDR; CPU linear compositor is
   not a performance path.
2. **x64 runtime** — v41 x64 tract build is static-verified and packaged; no x64
   execution/quality evidence on this arm64 host (no Rosetta).
3. **CI/signing** — workflow/scripts prepared and statically validated; no GitHub
   run, no Windows/Linux binary, no Apple/Windows signing or notarization.
4. **Reproducible packaging** — clean `cargo build` bytes differ from the
   checked-in v41 artifact only in `__LINKEDIT` (same LC_UUID/code sections);
   reproduce the strip/sign/package step for byte-for-byte release equality.
5. **Live-Host verification requires the authenticated Chrome CDP session** on
   9333; the 9230 host inspector has no DOM and the unauthenticated web URL is 401.
6. **Real providers** — still loopback mocks; no real key/network call was made.

## 4. Docs status
- `route-b-hdr.md` matches v41 (audio mux + affine layers + explicit remaining
  subset limits); `route-b-search.md` matches the pinned-model/tract architecture;
  `native-editor/README.md` documents the verified live panels and remaining
  full-editor gaps.
- `route-b-verification.md` still contains old v27 names and “HDR/ducking not
  verified” wording — stale; update or retire.
- This report supersedes the earlier v40 snapshot and the interim task-77
  “source-built/stale artifacts” addendum.

## 5. Verifier scripts (owned under `scripts/route-b/verify/`)
`revalidate-v28.sh`, `verify-tarball.mjs`, `verify-host-api.mjs`,
`verify-search-model.mjs`, `verify-real-search.mjs`, `verify-hdr10.mjs`,
`verify-hdr-production.mjs`, `verify-hdr-expansion.mjs`, `verify-native-ui.mjs`,
`verify-ci-signing.mjs`.
