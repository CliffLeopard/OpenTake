# Route B — final verification (v44)

| | |
|---|---|
| Status | **Final v44 integration verification** — HDR nested/effects/chroma + native LUT/upload/library/motion |
| Branch / commit | `feat/dsh-rust-engine` @ `56a6d87` (`feat(route-b): HDR nested/effects/chroma and native LUT/upload/library/motion`) |
| Addon | `opentake_engine_v44.node` — arm64 sha256 `7e42d2457093e89d0389ed4136f45f0a5ad6e4163695628bf48fba8f8ecfe89e` (45.4 MiB, ORT); x64 `da13c7fc033af39e21eefd4d2ab85dcf23ad977124e55d9b5f72fc5e0a96adcd` (43.3 MiB, tract) |
| Final package | `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256 `224f8ceba2167cc22cb03dd641fc60a26b8b5f133b564a569f048a63808c4aea`, 28,300,592 B, 24 files, both v44 slices, current index, native-editor bundle (311,705 B) |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — complete; pinned SHA-256 verified |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg 9.0.2 · Chrome 157 · no Rosetta, 0 signing identities, no `pwsh` |

Method: all checks below were re-run against v44; no implementation file was
edited and nothing was committed by the verifier. Live UI checks used the
authenticated Chrome CDP session at `127.0.0.1:9333` → DSH
`http://127.0.0.1:56474/`; the 9230 host inspector has no DOM.

## 1. Final matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v44 build / package | **Verified** | Clean rebuild **byte-identical** to checked-in arm64 v44 (`7e42d245…`); smoke + `verify-addon --workers` 22 passed/2 warnings/0 failed in both runtimes; revalidate **20 passed, 0 failed, 0 skipped, 0 warnings**; dist universal **12/13**, 24 files, packaged plugin loads 32 tools; temp-`DSH_HOME` install; installed arm64 v44 hash matches; Host API 31/32 repo + extracted package. |
| 2 | HDR nested sequences | **Verified (one compound level)** | Independently produced `production_hdr10_nested.mp4` with sha256 **36b676a0…** (matches task-84 evidence), hdr10=true, hasAudio=true; first-frame bars **[195,571,720,852] identical to flat base (deltas 0)**. Full decoded first frame is *not* bit-identical to the separately encoded flat file: 59,028/2,073,600 Y samples differ, max |Δ|=9 codes (2.85%; docs only claims measured-bar identity). Recursive depth guard 8 + cycle check; audio uses existing SDR nested-aware mix. |
| 3 | HDR basic effects | **Verified** | `production_hdr10_effects.mp4` sha256 **24804104…** (matches task-84 evidence); invert effect bars [572,261,64,64] vs base [195,571,720,852], deltas **377/−310/−656/−788**; unknown effect names rejected (`unknown effect …`). Grayscale/sepia/invert run in linear space. |
| 4 | HDR chroma key | **Verified** | `production_hdr10_chroma.mp4` sha256 **0e4fcd7c…** (matches task-84 evidence); grey key with similarity 0.8 keys all measured bars to Y=64; HDR10 tags/metadata + AAC audio preserved. |
| 5 | Prior HDR regressions | **Verified unchanged** | base `fefc97e6…`, SDR `5097ce9e…`, transformed `2e9eee11…`, overlays `f4f010ef…`, keyframes `cae8390a…`, mask `82fb43dd…`, HLG `04fabd20…`, crop `1e60f560…`, grade+LUT `735778a4…`; independent pixels crop 195→571 / 852→720, mask 669/64, overlay 232, keyframe 668→521, HLG 222/439/554/695; all HDR outputs Main10/yuv420p10le/bt2020/smpte2084 with mastering metadata + AAC. |
| 6 | SDR / false-HDR regression | **Verified** | SDR output is bt709/no HDR metadata (`sdr`); retagged SDR classified `false-hdr`; SDR-source HDR request rejected (`requires HDR sources`); H.264+HDR rejected. |
| 7 | HDR transitions / preview | **Explicit rejection, no fake HDR preview** | Crossfade transitions remain rejected (`HDR10 export does not support stabilization, transitions or reverse yet`); docs explain the plan-draw scheduling gap. Preview stays SDR (RGBA8 wgpu); no HLG output/HDR10+/DV claim. |
| 8 | Native LUT upload/picker | **Verified live (v44)** | LUT upload via `[data-otn-lut-upload]`: browser `.cube` File → `POST /engine/upload?kind=lut` → project `luts` list `{id:8b9c91ff…,name:verify-lut,bytes:81}`; clip auto-applied `lut:{id:8b9c91ff…,name:verify-lut,intensity:1}`; picker `[data-otn-lut-select]` rendered the asset. Manual 64-hex fallback remains for legacy ids. |
| 9 | Native media upload/drop + library/motion | **Verified live (v44)** | File input upload: media 0→1 (`native-upload`, image); dropzone drop: 1→2 (`drop-upload`, image). Library panel opens via `open-library`, lists a read-only global entry and its `import to project` action imported it into the project (media 2→3, `src` video). Motion panel opens via `open-motion`, calls `motion_document_*`, creates `Native Motion Verify` (revision `c5585df1b996`). Native tests **20/20**, shell tests **11/11**; bundle 311,705 B. Fallback restores iframe `/opentake-studio-route-b/app/`. |
| 10 | SigLIP2 model/search | **Verified** | model complete/pinned; Host real search PASS (`ort-native`, indexed 4, text Moments + image self-match); addon real text/image search PASS. |
| 11 | x64 / CI / signing | **x64 static verified; CI/signing pending external** | v44 x64 tract `ok:true`, no ORT linkage, package-shipped; no Rosetta to execute x64. CI workflow/scripts statically valid; signing SKIP (0 identities); Linux/Windows preflights 78; no CI/signing executed. |

## 2. Exact evidence

### 2.1 Nested/effects/chroma hashes reproduced
```bash
# v44 addon (7e42d245…) + real HDR source, 10-frame 1080p export path
36b676a0…  production_hdr10_nested.mp4
24804104…  production_hdr10_effects.mp4
0e4fcd7c…  production_hdr10_chroma.mp4
```
All three: `hdr10:true`, `hasAudio:true`; ffprobe HEVC Main10/yuv420p10le/
bt2020/smpte2084/bt2020nc + mastering/content-light metadata + AAC LC 48 kHz
mono; `verify-hdr10` OK. Nested bars equal the flat base; effects/chroma bars as
above. (The committed `hdr10-production-evidence.mjs` still lacks the
nested/effects/chroma cases used for the docs hashes; the verifier reproduced
them independently from the v44 addon.)

### 2.2 Prior HDR regression run
`hdr10-production-evidence.sh` on v44 (addon hash `7e42d245…`) reproduces all
prior outputs unchanged: base, SDR, transformed, overlays, keyframed, masked,
HLG→PQ, cropped, grade+LUT. Independent YUV checks confirm crop, mask, overlay,
keyframe, HLG and grade/LUT values quoted in the matrix. SDR output is
`bt709/no-HDR`; false-HDR retag is rejected; SDR-source HDR is rejected.
Crossfade transitions are still rejected with the documented reason.

### 2.3 Native v44 live CDP
Authenticated Chrome CDP 9333 → DSH 56474; live engine
`native/darwin-arm64/opentake_engine_v44.node` loaded.
- LUT: `.cube` upload → `/engine/upload?kind=lut`; `/engine/luts` returned the
  sha256 asset; clip `lut` set automatically; select list rendered.
- Media: file input and dropzone each imported an image (media 0→1→2).
- Library: read-only global library list (`library_list`), entry + import button; import added the library video to the project (media 2→3).
- Motion: read-only `motion_document_*` list, create form produced a document.
- Fallback: `Iframe 编辑器` restored `/opentake-studio-route-b/app/`.
- Bundle 311,705 B with LUT upload/picker, upload/dropzone, library/motion
  markers; native tests 20/20, shell 11/11.

### 2.4 Package / install
```bash
bash scripts/route-b/verify/revalidate-v28.sh --fresh-pack
# 20 passed, 0 failed, 0 skipped, 0 warnings
node scripts/route-b/verify/verify-tarball.mjs --tarball dist/…universal.tgz
# 12 passed, 1 warning, 0 failed — 24 files, addon v44, packaged plugin loads 32 tools
DSH_HOME=/tmp/v44-dsh dsh plugin --profile v44 add dist/…universal.tgz
# installed darwin-arm64/opentake_engine_v44.node sha256 7e42d245…
# installed addon expansion PASS; Host API extracted package 31/32
```

### 2.5 Search / x64 / CI
Model complete/pinned; Host real search PASS; addon real search PASS.
x64 v44 tract static `ok:true`; no x64 execution on this host.
CI valid, wgpu platforms READY, signing dry-run SKIP, local Linux/Windows
preflight 78, no `pwsh`; no CI/signing run.

## 3. Remaining gaps (true-vs-fallback boundaries)

1. **HDR**: nested recursion implemented for supported layers but the decoded
   nested frame is only measured-bar-identical to the flat export (small
   first-frame differences from separate encoding); crossfade transitions,
   stabilization, reverse and arbitrary effect chains remain rejected; HLG is
   input→PQ only, no HLG output/HDR10+/DV; SDR text/image overlays are 203-nit
   mapped; range exports mux the full timeline mix; HDR preview stays SDR and
   the compositor is CPU/bilinear (correct, not a performance path).
2. **Native**: LUT upload/picker, media file/drop upload, read-only Library and
   Motion panels are present; Library/Motion have no full edit/write UI beyond
   the existing import/create routes (library import works; motion creation works); no full effects/grades UI, no
   drag-and-drop of library items to timeline, no motion editing surface; full
   editor remains in the iframe fallback.
3. **x64 runtime** unknown (no Rosetta); tract build/package static only.
4. **CI/signing** prepared only; Windows/Linux binaries and Apple/Windows
   signing/notarization not executed.
5. **Real providers** still loopback mocks.
6. **Evidence generator**: the committed HDR evidence script does not generate
   the docs’ nested/effects/chroma cases; the verifier reproduced the exact
   hashes with an independent script, but the committed generator should be
   extended so the claimed evidence is reproducible from the repo alone.

## 4. Docs status
`route-b-hdr.md` matches v44 (nested recursive, effects/chroma in linear space,
explicit transition/preview/HLG-output limits); `native-editor/README.md`
matches the live LUT/upload/library/motion evidence; `route-b-search.md`
matches model/backends. `route-b-verification.md` remains stale (v27-era wording)
and should be updated or retired.

## 5. Verifier scripts (owned under `scripts/route-b/verify/`)
`revalidate-v28.sh`, `verify-tarball.mjs`, `verify-host-api.mjs`,
`verify-search-model.mjs`, `verify-real-search.mjs`, `verify-hdr10.mjs`,
`verify-hdr-production.mjs`, `verify-hdr-expansion.mjs`, `verify-native-ui.mjs`,
`verify-ci-signing.mjs`.
