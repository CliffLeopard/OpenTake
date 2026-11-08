# Route B — final verification (v42)

| | |
|---|---|
| Status | **Final v42 integration verification** — HDR overlays/masks/keyframes/HLG and native full panels |
| Branch / commit | `feat/dsh-rust-engine` @ `63616cd` (`feat(route-b): HDR masks/HLG/overlays/keyframes and native full panels`); worktree clean except `?? .codegraph/` |
| Addon | `opentake_engine_v42.node` — arm64 sha256 `37d8b567be5a95790d94faf92d64e0557a9efd3e138c760b2cc1d9cf870d88a4` (45.4 MiB, ORT); x64 `4044bcec376a4e5082e33f5298fbed8b91eb056a8cfbe90b7cc1a514e00eb5a4` (43.3 MiB, tract) |
| Final package | `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256 `545175ba9fc6971e602bc6869eff78afccae0b15518377893e42fbcc794fdfb1`, 28,278,576 B, 24 files, both v42 slices, current index, search libs, native-editor bundle (279,451 B) |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — complete; all pinned SHA-256 verified |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg 9.0.2 · Chrome 157 · no Rosetta, 0 signing identities, no `pwsh` |

Method: all checks below were re-run against v42; no implementation file was
edited and nothing was committed by the verifier. Live UI checks used the
authenticated Chrome CDP session at `127.0.0.1:9333` → DSH
`http://127.0.0.1:56474/`; the 9230 host inspector has no DOM.

## 1. Final matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v42 build / ABI / package | **Verified** | Clean rebuild is **byte-identical** to checked-in arm64 v42 (`37d8b567…`); smoke + `verify-addon --workers` 22 passed/2 warnings/0 failed in Node 26 and DSH Node 24; consolidated revalidate **20 passed, 0 failed, 0 skipped, 0 warnings**; dist universal **12/13**, 24 files, packaged plugin loads 32 tools; temp-`DSH_HOME` install; installed arm64 v42 hash matches; Host API 31/32 on repo + extracted package. |
| 2 | HDR10 SDR text/image overlays | **Verified** | `production_hdr10_overlays.mp4` sha256 **f4f010ef…**; independently recomputed pixels: image sample delta 232, text-changed pixels 1952; ffprobe still HEVC Main10/yuv420p10le/bt2020/smpte2084/bt2020nc with mastering metadata; SDR overlays map via 203-nit linear white (documented), not HDR-native graphics. |
| 3 | HDR10 masks (rect/ellipse/poly, feather/invert) | **Verified** | `production_hdr10_masked.mp4` **82fb43dd…**; ellipse mask centre Y=669 vs corner Y=64; invert/feather applied; output HDR10 tags preserved; mask path is the CPU linear compositor. |
| 4 | HDR10 keyframed transform/opacity | **Verified** | `production_hdr10_keyframed.mp4` **cae8390a…**; opacity keyframe sampled per frame: centre Y 668 at frame 0 → 521 at frame 9; output Main10/PQ; unsupported effect keyframes refuse. |
| 5 | HDR10 HLG input → PQ | **Verified input conversion / output policy absent** | `production_hdr10_from_hlg.mp4` **04fabd20…**; HLG source (`arib-std-b67`) exported to Main10/yuv420p10le/bt2020/smpte2084/PQ with four distinct bar levels (222/439/554/695); HLG **output** and HDR10+/DV are not implemented. |
| 6 | HDR10 nested sequences | **Not supported (explicit rejection)** | Preflight errors with `HDR10 export does not support nested sequences yet` (`crates/opentake-node/src/lib.rs:1024-1025`); effect/crop projects fail with the explicit “crops/effects/grades/LUTs/keying/transitions/reverse/nested sequences are not supported yet” message. |
| 7 | HDR10 SDR/false-HDR regression | **Verified** | `production_sdr10.mp4` **5097ce9e…** is Main10 but bt709 with no HDR metadata (classified `sdr`); a 10-bit SDR retagged PQ without mastering metadata is classified `false-hdr`; SDR-source HDR request rejected (`requires HDR sources`); H.264+HDR rejected. |
| 8 | Native Effects/Captions/Keyframes/Masks/Playback/import | **Verified live (v42)** | Engine v42 loaded in the live page; native preview ShadowRoot: Effect add `grayscale` → engine `effects:[{name:"grayscale",…}]`; ellipse mask + invert → engine `masks:[{kind:circle,invert:true}]`; opacity keyframe at frame 5 → `opacityTrack`; caption create → timeline clip `id-11 "V42 caption" 0+45`; playback attr `playing` + stop; media import path → media count 1→3; fallback restores iframe `/opentake-studio-route-b/app/`. Native tests 18/18, shell tests 11/11; bundle 279,451 B with all panel markers. |
| 9 | SigLIP2 search + model | **Verified** | model complete/pinned; Host API real Host search PASS (`ort-native`, indexed 4, text Moments + image self-match); addon real text/image search PASS. |
| 10 | x64 / CI / signing | **x64 static verified; CI/signing pending external** | v42 x64 tract: `hasTract:true`, no ORT linkage, `ok:true`; package ships it; no Rosetta to execute x64. CI workflow/scripts statically valid; mac signing SKIP (0 identities); Linux/Windows preflights exit 78; no `pwsh`; no CI run/signing. |

## 2. Exact evidence

### 2.1 HDR evidence pipeline (v42)
```bash
bash scripts/route-b/export/hdr10-production-evidence.sh /tmp/task78-hdr-evidence
# evidence addon sha256 37d8b567… == checked-in arm64 v42
# PASS; media hashes:
# production_hdr10.mp4                    fefc97e6…
# production_sdr10.mp4                    5097ce9e…
# production_hdr10_transformed.mp4        2e9eee11…
# production_hdr10_overlays.mp4           f4f010ef…
# production_hdr10_keyframed.mp4          cae8390a…
# production_hdr10_masked.mp4             82fb43dd…
# production_hdr10_from_hlg.mp4           04fabd20…
```
Independently decoded the raw `yuv420p10le` frames and recomputed:
mask centre 669 / corner 64, overlay image delta 232, keyframe 668→521,
HLG levels 222/439/554/695. `verify-hdr10.mjs` reports `hdr10` for all HDR
outputs with mastering + content-light metadata; SDR output is `sdr`; a
retagged-SDR file is `false-hdr`. False-HDR project rejection:
`HDR10 export requires HDR sources; sdr_source is SDR`.

Unsupported boundaries (v42):
```text
effect: HDR10 export supports static/keyframed affine + opacity, SDR text/image
        overlays and basic masks; crops/effects/grades/LUTs/keying/transitions/
        reverse/nested sequences are not supported yet
crop:   same explicit rejection
nested: HDR10 export does not support nested sequences yet
HLG output / HDR10+ / Dolby Vision: not implemented
```
The shipped wgpu compositor/preview and ordinary SDR export remain RGBA8/SDR;
HDR is the addon/export path only (CPU linear compositor).

### 2.2 Native panels (live v42)
Authenticated Chrome CDP 9333 → DSH 56474; `OpenTake（原生）` → `原生预览`:
- **Effects**: added `grayscale`; engine timeline returned that effect.
- **Masks**: added ellipse and inverted it; engine returned `kind:"circle"` with `invert:true`.
- **Keyframes**: seeked to frame 5, added opacity keyframe; engine `opacityTrack` updated.
- **Captions**: created “V42 caption” 0+45; engine timeline returned caption clip `id-11`.
- **Playback**: play → transport `data-otn-playback="playing"`, stop worked.
- **Import**: path entry imported `/tmp/ostudio-media/motion.mp4`; media count 3.
- **Fallback**: `Iframe 编辑器` restored the iframe app; native preview can be re-entered.
- Bundle markers: `open-captions`, `data-otn-mask-add`, `data-otn-effect-add`,
  `data-otn-keyframe-add`, `data-otn-playback`, `data-otn-import-path`; tests 18/18 + 11/11.

### 2.3 Package / install
```bash
bash scripts/route-b/verify/revalidate-v28.sh --fresh-pack
# 20 passed, 0 failed, 0 skipped, 0 warnings
# built addon matches checked-in v42 exactly
node scripts/route-b/verify/verify-tarball.mjs --tarball dist/…universal.tgz
# 12 passed, 1 warning, 0 failed — 24 files, addon v42, packaged plugin loads 32 tools
DSH_HOME=/tmp/v42-dsh dsh plugin --profile v42 add dist/…universal.tgz
# installed darwin-arm64/opentake_engine_v42.node sha256 37d8b567…
# installed addon expansion PASS; Host API extracted package 31/32
```

### 2.4 Search/model
Model complete with pinned SHA-256; Host real search PASS (`installed:true,
visualAvailable:true, backend:ort-native`, indexed 4, text Moments + image
self-match); addon `verify-real-search` PASS.

### 2.5 x64 / CI
x64 v42 tract: `arch-capability` `expectedBackend:tract`, `hasTract:true`,
`hasOrtLinkage:false`, `ok:true`; no execution on this arm64 host.
CI workflow valid, wgpu platforms READY, signing dry-run SKIP, local
Linux/Windows preflight 78, no `pwsh`; no CI/signing executed.

## 3. Remaining gaps (exact true-vs-fallback boundaries)

1. **HDR unsupported**: crops (non-mask), effects/grades/LUTs, chroma key,
   stabilization, transitions, reverse, nested sequences; range exports mux the
   whole timeline audio; HLG is input→PQ only (no HLG output); HDR10+/Dolby
   Vision not implemented; overlays are SDR (203-nit mapped), not HDR-native
   graphics; preview/shared encoder remain SDR; CPU linear compositor only.
2. **Native editor**: bounded panels only — home/media/timeline/preview,
   Inspector with Effects/Keyframes/Masks sections, Captions, Export, Settings,
   playback transport and a media-path import. No full effects/grades/LUT UI,
   no drag-and-drop/file-picker import, no motion/library/agent panels; the full
   editor remains in the iframe fallback.
3. **x64 runtime** unknown (no Rosetta); tract build/package static only.
4. **CI/signing** prepared only; Windows/Linux binaries and Apple/Windows
   signing/notarization not executed.
5. **Real providers** still loopback mocks.
6. **Live UI checks** require the authenticated Chrome CDP session; the DSH host
   inspector at 9230 has no DOM.

## 4. Docs status
`route-b-hdr.md` matches v42 (HLG→PQ input, overlays at 203 nits, masks,
keyframes, audio; nested/crops/effects/LUTs/HLG-output unsupported);
`native-editor/README.md` matches the live panel evidence; `route-b-search.md`
matches the pinned model/backends. `route-b-verification.md` still names v27 and
“HDR/ducking not verified” — stale, update or retire.

## 5. Verifier scripts (owned under `scripts/route-b/verify/`)
`revalidate-v28.sh`, `verify-tarball.mjs`, `verify-host-api.mjs`,
`verify-search-model.mjs`, `verify-real-search.mjs`, `verify-hdr10.mjs`,
`verify-hdr-production.mjs`, `verify-hdr-expansion.mjs`, `verify-native-ui.mjs`,
`verify-ci-signing.mjs`.
