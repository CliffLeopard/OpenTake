# Route B — final verification (v43)

| | |
|---|---|
| Status | **Final v43 integration verification** — HDR crop/grade/LUT + native advanced inspector/shortcuts/import |
| Branch / commit | `feat/dsh-rust-engine` @ `3731719` (`feat(route-b): HDR crop/grade/LUT and native advanced inspector`) |
| Addon | `opentake_engine_v43.node` — arm64 sha256 `b35d58787b6bff8f0b30120c764d702daa6bc94f53e8b49a1ab254fb57995ba2` (45.4 MiB, ORT); x64 `3e6591fa364a4ccf0700488ef435c0785d6152104992f389c4186f42fd8f5ac4` (43.3 MiB, tract) |
| Final package | `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256 `811ec5b6f4cedbb2552de459b542c648992989a641fc3f6470db0cdbe021d5e4`, 28,297,082 B, 24 files, both v43 slices, current index, search libs, native-editor bundle (301,286 B) |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — complete; pinned SHA-256 verified |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg 9.0.2 · Chrome 157 · no Rosetta, 0 signing identities, no `pwsh` |

Method: all checks below were re-run against v43; no implementation file was
edited and nothing was committed by the verifier. Live UI checks used the
authenticated Chrome CDP session at `127.0.0.1:9333` → DSH
`http://127.0.0.1:56474/`; the 9230 host inspector has no DOM.

## 1. Final matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v43 build / package | **Verified** | Clean rebuild **byte-identical** to checked-in arm64 v43 (`b35d5878…`); smoke + `verify-addon --workers` 22 passed/2 warnings/0 failed in Node 26 and DSH Node 24; revalidate **20 passed, 0 failed, 0 skipped, 0 warnings**; dist universal **12/13**, 24 files, packaged plugin loads 32 tools; temp-`DSH_HOME` install; installed arm64 v43 hash matches; Host API 31/32 on repo + extracted package. |
| 2 | HDR10 crop | **Verified** | `production_hdr10_cropped.mp4` sha256 **1e60f560…**; left/right crop 0.25; independent YUV comparison at x=20%/80%: Y 195→571 and 852→720 (measure delta 376/132); output still HEVC Main10/yuv420p10le/bt2020/smpte2084 with mastering metadata + audio. |
| 3 | HDR10 basic color grade + 3D LUT | **Verified** | `production_hdr10_grade_lut.mp4` **735778a4…**; exposure +0.5, contrast 0.1, saturation 1.2, temperature 0.1 + 17³ inverting `.cube` LUT; independent YUV: centre Y 668→64, bar levels [573,531,64,64,64]; output HDR10 tags/metadata/audio preserved; grade/LUT run in linear space (SDR-white-relative 203-nit mapping, LUT intensity blended/clamped). |
| 4 | HDR10 nested sequences | **Not supported — explicit design blocker, not silently dropped** | v43 keeps nested sequences rejected (`HDR10 export does not support nested sequences yet`). Docs give the concrete blocker: `try_build_render_plan` already flattens nested sequences into `ClipPlan`/`LayerDraw` (compound affine/crop/masks/grade/LUT), but the HDR addon walks raw timeline clips; true HDR nested export needs either (a) exposing the flattened plan/layer metadata to the addon, or (b) pre-flattening into a synthetic HDR timeline. This is documented rather than falsely claimed. |
| 5 | HDR regressions: masks/overlays/keyframes/HLG/audio | **Verified unchanged** | Prior exact hashes still match: masks `82fb43dd…`, overlays `f4f010ef…`, keyframes `cae8390a…`, HLG→PQ `04fabd20…`, base `fefc97e6…`, transformed `2e9eee11…`, SDR `5097ce9e…`; independent pixels: mask 669/64, overlay delta 232, keyframe 668→521, HLG levels 222/439/554/695; all HDR outputs Main10/PQ with mastering metadata; AAC retained. |
| 6 | SDR / false-HDR regression | **Verified** | SDR output is Main10 but bt709/no HDR metadata (classified `sdr`); retagged SDR without mastering metadata classified `false-hdr`; SDR-source HDR request rejected (`HDR10 export requires HDR sources`); H.264+HDR rejected. |
| 7 | Native advanced inspector: colors/LUT/chroma/text style/masks | **Verified live (v43)** | Advanced tab sections present: colorGrade/textStyle/chromaKey/lut. Live engine mutations: `colorGrade:{exposure:0.5,contrast:0.2,saturation:1.3,…}`; `chromaKey:{keyColor:{0,1,0},similarity:0.2,smoothness:0.35,spill:0.5}`; `lut:{id:"aaaa…(64)",name:"Native LUT",intensity:0.8}`; text clip `textStyle:{fontName:"Helvetica-Bold",fontSize:60,alignment:"left",…}`; mask advanced transform `scale:{x:1.5,y:1}`. LUT picker/asset management remains absent; synthetic 64-hex reference is accepted by the timeline, but export needs a real project LUT asset. |
| 8 | Native keyboard shortcuts | **Verified live (v43)** | Space → `playing`, second Space → `paused`; ArrowRight seeked frame 17→18; Shift+ArrowRight nudged selected clip 0→1 and Ctrl+Z restored 0; Delete removed video clip and Ctrl+Z restored it; `?` opened shortcuts-help overlay; Escape closed it. File input `[data-otn-file-picker]` renders but browser File objects expose no path (documented `filePathUnavailable`); path entry is the working import route. Fallback restores iframe `/opentake-studio-route-b/app/`. |
| 9 | SigLIP2 search + model | **Verified** | model complete and pinned; Host real search PASS (`ort-native`, indexed 4, text Moments + image self-match); addon real text/image search PASS. |
| 10 | x64 / CI / signing | **x64 static verified; CI/signing pending external** | v43 x64 tract build static (`hasTract:true`, no ORT linkage, `ok:true`), package-shipped; no Rosetta to execute x64. CI workflow/scripts statically valid; signing SKIP (0 identities); Linux/Windows preflights 78; no `pwsh`; no CI/signing executed. |

## 2. Exact evidence

### 2.1 HDR evidence pipeline (v43)
```bash
bash scripts/route-b/export/hdr10-production-evidence.sh /tmp/task81-hdr-evidence
# evidence addon sha256 b35d5878… == checked-in arm64 v43
# PASS; hashes:
# production_hdr10_cropped.mp4      1e60f560…
# production_hdr10_grade_lut.mp4    735778a4…
# prior outputs unchanged:           fefc97e6… (base), 5097ce9e… (SDR),
#   2e9eee11… (transformed), f4f010ef… (overlays), cae8390a… (keyframed),
#   82fb43dd… (masked), 04fabd20… (HLG→PQ)
```
Independent raw-YUV checks: crop left/right Y 195→571 / 852→720; graded
centre 668→64 with bar levels 573/531/64/64/64; mask 669/64, overlay 232,
keyframe 668→521, HLG 222/439/554/695. `verify-hdr10` reports `hdr10` for all
HDR outputs (mastering + content-light), `sdr` for SDR, `false-hdr` for retagged
SDR. Nested sequences remain explicitly rejected; no HDR10+/DV/HLG-output claim.

### 2.2 Native advanced (live v43)
Authenticated Chrome CDP 9333 → DSH 56474; engine path
`native/darwin-arm64/opentake_engine_v43.node`. Verified:
- Advanced tabs `properties/effects/keyframes/masks/advanced`; four advanced
  sections + grade/chroma/LUT controls.
- Color grade, chroma key, LUT reference, text style, mask transform mutations
  observed in the live `/engine/timeline`.
- Shortcuts: play/pause, seek, nudge, delete, Ctrl+Z, help overlay; file input
  present with the documented path limitation; iframe fallback.
- Native tests 18/18, shell tests 11/11; bundle 301,286 B with all advanced
  markers.

### 2.3 Package / install
```bash
bash scripts/route-b/verify/revalidate-v28.sh --fresh-pack
# 20 passed, 0 failed, 0 skipped, 0 warnings
node scripts/route-b/verify/verify-tarball.mjs --tarball dist/…universal.tgz
# 12 passed, 1 warning, 0 failed — 24 files, addon v43, packaged plugin loads 32 tools
DSH_HOME=/tmp/v43-dsh dsh plugin --profile v43 add dist/…universal.tgz
# installed darwin-arm64/opentake_engine_v43.node sha256 b35d5878…
# installed addon expansion PASS; Host API extracted package 31/32
```

### 2.4 Search/model / x64 / CI
Model complete with pinned SHA-256; Host real search PASS (`ort-native`,
indexed 4, text Moments + image self-match); addon real search PASS.
x64 v43 tract static `ok:true`; no x64 execution on this host.
CI workflows valid, wgpu platforms READY, signing dry-run SKIP, local
Linux/Windows preflight 78, no `pwsh`; no CI/signing run.

## 3. Remaining gaps (true-vs-fallback boundaries)

1. **HDR**: nested sequences still rejected (design blocker above); effects,
   chroma key, stabilization, transitions, reverse unsupported; HLG is input→PQ
   only, no HLG output/HDR10+/DV; crop and linear grade/LUT are supported; SDR
   text/image overlays are 203-nit mapped (not HDR-native graphics); range
   exports mux full timeline audio; preview/shared encoder remain SDR and the
   HDR compositor is CPU-only.
2. **Native**: advanced controls exist for color grade/LUT reference/chroma/text
   style/masks, but there is no LUT asset picker/upload or full effects/grades
   UI, no file picker path/drag-drop upload (path entry only), no
   motion/library/agent panels; full editor remains in the iframe fallback.
3. **x64 runtime** unknown (no Rosetta); tract build/package static only.
4. **CI/signing** prepared only; Windows/Linux binaries and Apple/Windows
   signing/notarization not executed.
5. **Real providers** still loopback mocks.
6. **Live UI checks** require the authenticated Chrome CDP session; the DSH host
   inspector at 9230 has no DOM.

## 4. Docs status
`route-b-hdr.md` matches v43 (crop, linear grade + 3D LUT, HLG→PQ input, nested
design blocker, explicit unsupported effects/chroma/stabilization/transitions/
reverse/HLG-output/HDR10+/DV); `native-editor/README.md` matches the live
advanced-panel/shortcut evidence; `route-b-search.md` matches model/backends.
`route-b-verification.md` is still stale (v27 era, “HDR/ducking not verified”) —
update or retire.

## 5. Verifier scripts (owned under `scripts/route-b/verify/`)
`revalidate-v28.sh`, `verify-tarball.mjs`, `verify-host-api.mjs`,
`verify-search-model.mjs`, `verify-real-search.mjs`, `verify-hdr10.mjs`,
`verify-hdr-production.mjs`, `verify-hdr-expansion.mjs`, `verify-native-ui.mjs`,
`verify-ci-signing.mjs`.
