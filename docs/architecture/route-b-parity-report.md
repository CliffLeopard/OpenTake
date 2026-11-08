# Route B — final integration verification

| | |
|---|---|
| Status | **Final integration + task-77 expansion verification; per-item status below** |
| Branch / commit | `feat/dsh-rust-engine` @ `a3c86b3` + an **uncommitted task-77 worktree** (HDR audio/layer expansion, native Inspector/Export/Settings panels, rebuilt native bundle). Worktree is dirty by design; source-built addon sha256 `81cbf44c…`, checked-in v40 artifact `77b9de3d…` (pre-expansion). |
| Snapshot | 2026-11-08 23:54 local |
| Addon | `opentake_engine_v40.node` — arm64 sha256 `77b9de3dd282ba33d12a4c792cd375212fc1d8249bd573702758c3be938a8372` (46.2 MiB, ORT); x64 `7fe8eab97442e938e3e8557d8d617b7a1e1b317599c62c650b64298bbb2fb5d3` (44.3 MiB, **tract** search backend, no ORT linkage) |
| Final package | `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256 `815b8920d18a98de270beb773d4ef3815fa0129c3f71a7052d5815b9ade14dc5`, 27,717,235 B, 24 files, both v40 slices, `lib/search/*`, `web/native-editor/native-editor.js` |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — canonical layout + receipts; all three files match pinned SHA-256 |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg/ffprobe 9.0.2 · Chrome · no Rosetta, 0 codesigning identities, no `pwsh` |

Method: every item was re-run after the `92c8780` build; implementation was not
edited and nothing was committed by the verifier. Existing docs are not accepted
as proof; stale statements are listed in §5.

## 1. Final matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Addon build / ABI / load | **Verified** | clean rebuild 11 s → **byte-identical to checked-in arm64 v40** (`77b9de3d…`); smoke OK; `verify-addon --workers` **22 passed, 2 warnings, 0 failed** in Node 26 and DSH Node 24; N-API 8 chain, no libnode. Consolidated run: **20 passed, 0 failed, 0 skipped, 0 warnings**. |
| 2 | Final universal package + DSH profile install | **Verified for the v40 package / stale for task-77** | `verify-tarball` on the dist universal: **12 passed, 1 warning, 0 failed** (24 files, both v40 slices byte-equal to repo, packaged addon smoke, packaged plugin loads **32 tools**); temp-`DSH_HOME` `dsh plugin add` + `--dump-config` + both slices installed; installed arm64 addon hash matches v40 and loads. Fresh `npm pack` from the tree also passes (same 13 checks). The stale `dist/*arm64.tgz` was deleted. **However the current dist package predates the task-77 expansion/panel work**: its bundled native editor lacks `open-export` and its addon is the pre-expansion v40 (`77b9de3d…`), not source build `81cbf44c…`; see §7. |
| 3 | Real SigLIP2 search (index/query/text/image) | **Verified** | model complete with all pinned SHA-256; addon real search **PASS** (text `red` → red-video 0.1321; image red frame → red-video 0.9999 > blue-video 0.9559); Host API (extracted final package) real Host search **PASS**: `installed:true`, `visualAvailable:true`, `backend:ort-native`, indexed 4, text moments, image self-match; Host API **31 passed, 0 failed (32 checks)** including search, HDR, native-editor bundle route. |
| 4 | HDR10 production path (`hdr10=true`) | **Verified on source-built addon / shipping artifacts stale** | `verify-hdr-production.mjs` against the installed v40 addon: `hdr10=true`, ffprobe **HEVC Main 10 / yuv420p10le / BT.2020 / SMPTE2084 / bt2020nc**, mastering + content-light metadata; SDR source request rejected (`HDR10 export requires HDR sources`); H.264 request rejected (`requires codec h265`). Host API production HDR export also PASS (same tags) and SDR request rejected. A 10-bit SDR re-tagged as PQ without mastering metadata is rejected by `verify-hdr10.mjs`. Task-77 expansion on source-built `81cbf44c…`: audio muxing + affine transform/multi-layer now verified (see §7); the checked-in 77b9de artifact and current dist package still have the pre-expansion subset. |
| 5 | Native editor live mount + Inspector/Export/Settings panels | **Verified live (task-77)** | Optional native preview is wired: `ui/client.js` lazily imports `NATIVE_BUNDLE_URL` (`/app/native-editor/native-editor.js`), package ships `web/native-editor/**` (230,535 B bundle), Host API serves the bundle, native-editor tests **10/10**, shell tests **11/11**. Independent CDP run on the authenticated Chrome at `127.0.0.1:9333` → DSH `127.0.0.1:56474`: opened `OpenTake（原生）`, switched to `原生预览`, and verified the new **Inspector, Export and Settings** panels live (selection/opacity edit, move+undo, export form + completed export, settings storage/model/index, iframe fallback). Details and screenshots in §7.2. |
| 6 | x64 search parity | **Static Verified / runtime Unknown** | x64 v40 is a tract build: `arch-capability.mjs` reports `hasTract:true, hasOrtNative:false, hasOrtLinkage:false, staticOk:true, ok:true`; `otool -L` has no ONNX Runtime/CoreML; package contains the x64 v40 slice. Cannot execute x64 on this arm64 host (no Rosetta), so runtime/quality is **Unknown**; static source/package parity is verified. |
| 7 | HDR10 ffprobe vs SDR false-HDR | **Verified** | true HDR file passes `verify-hdr10.mjs` (main10/pq/bt2020 + mastering); SDR fallback is `sdr` (bt709, no HDR metadata); 10-bit SDR re-tagged PQ **without** mastering metadata is `false-hdr` and rejected; Host/Addon SDR-requested-HDR10 exports fail with an explicit error rather than being tagged. |
| 8 | Playback / export / motion / providers (regression) | **Verified on macOS arm64** | Host API: native cpal playback + multipart PNG stream, JPEG preview, denoise/loudness/stabilization, 10-bit SDR H.265 (not HDR-tagged), ducking RMS drop, ASR/captions, Motion doc+template publish, static app + native bundle; provider module mocks only (real providers remain Unknown). |
| 9 | CI / signing | **Partial / pending external** | workflow with 5 platform jobs validates (YAML, pinned action SHAs, script syntax); wgpu macOS/Windows/Linux READY; `sign-macos.sh` dry-run SKIP (0 identities); local Linux/Windows preflights exit 78; no `pwsh`; no CI run, signing/notarization, or Windows/Linux binary executed. |

## 2. Final evidence (commands/results)

### 2.1 Package / DSH / addon
```bash
bash scripts/route-b/verify/revalidate-v28.sh --clean --fresh-pack
# 20 passed, 0 failed, 0 skipped, 0 warnings
# built addon matches checked-in arm64 — 77b9de3dd282ba33…
# fresh npm pack 24 entries; tarball 12/13 checks; temp-DSH install; installed v40 addon loads
node scripts/route-b/verify/verify-tarball.mjs \
  --tarball dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz
# 12 passed, 1 warning, 0 failed — 24 files, addon v40, packaged plugin loads 32 tools
DSH_HOME=/tmp/routeb-final dsh plugin --profile final add dist/…universal.tgz
# both native slices installed; darwin-arm64/opentake_engine_v40.node sha256 77b9de3d…
```
The stale `dist/opentake-studio-route-b-0.1.0-darwin-arm64.tgz` (22:24, v38)
fails 5/13 checks (no native-editor bundle, stale v38 addon, old index); do not
ship it. The universal artifact rebuilt at 23:37 is current.

### 2.2 SigLIP2 model + real search
Pins match between `crates/opentake-media/src/search/config.rs` and
`scripts/route-b/search/model-assets.mjs`; recomputed SHA-256:

| file | bytes | SHA-256 |
|---|---|---|
| `image_encoder.onnx` | 371,992,072 | `f5cb1672…aa7a` |
| `text_encoder.onnx` | 1,129,469,657 | `d3de4a6b…aaef` |
| `tokenizer/tokenizer.json` | 34,363,039 | `cb9140fa…8322` |

`verify-search-model.mjs` exit 0 (complete; receipts parse). Independent real
search on the installed package addon:
`text "red" → red-video:0.1321`; `image red-frame → red-video:0.9999,
blue-video:0.9559` (`ort-native`). Host API extracted final package:
`search_model_status installed/visual true`, indexed 4, text Moments returned,
image self-match `id-1`.

### 2.3 HDR10 production
```bash
node scripts/route-b/verify/verify-hdr-production.mjs \
  --addon <installed>/native/darwin-arm64/opentake_engine_v40.node --json
# pass true; exported.hdr10 true; hevc Main 10 / yuv420p10le / bt2020 / smpte2084
# SDR source → "HDR10 export requires HDR sources; hdr10_sdr_fallback is SDR"
# h264 + hdr10 → "HDR10 export requires codec h265 (Main10)"
node scripts/route-b/verify/verify-hdr10.mjs production_hdr10.mp4   # hdr10 PASS
node scripts/route-b/verify/verify-hdr10.mjs --expect not-hdr retag_false_hdr.mp4  # rejected false-hdr
```
Host API additionally exercised the `/engine/invoke export_video {hdr10:true}`
pass-through on a fresh HDR project and got the same HDR tags; the same request
on an SDR source failed with an error and did not produce a mislabelled file.
The Host export dialog now exposes the HDR10 checkbox (`web/src/components/shell/ExportDialog.tsx:138,312,567`)
and the built asset contains `hdr10`; HDR mode remains HDR-PQ-video-only, no
audio, untransformed layers, and the shared wgpu compositor is still SDR.

### 2.4 Native editor / CDP
```bash
node --test plugins/opentake-studio-route-b/native-editor/test/native-editor.test.mjs   # 10/10
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs                       # 11/11
node scripts/route-b/verify/verify-native-ui.mjs --chrome
# PASS ... optional native preview wired; bundle 230535 bytes; iframe remains default
# PASS ... browser harness mounts in Chrome — 56727 byte screenshot
curl 127.0.0.1:9230/json/list
# one page target dsh://host ("Experimental cross-realm Inspector")
# Schema.getDomains -> Runtime, Debugger, Profiler only; Runtime.evaluate has no document
# cordis_inspect_query client Slots/Theme -> timed out after 10000ms
# curl 127.0.0.1:56474 -> 401 "dsh web authentication required"; no tokenized URL found
```
Live DSH renderer mount is verified from the authenticated CDP session:
`OpenTake（原生）` → `原生预览` produced one ShadowRoot with two children and
the native home UI; iframe fallback toggles back. Screenshot:
`/tmp/live-native-v40.png`.

### 2.5 x64
```bash
node scripts/route-b/search/arch-capability.mjs \
  --addon plugins/opentake-studio-route-b/native/darwin-x64/opentake_engine_v40.node --json
# expectedBackend tract; hasTract true; hasOrtNative false; hasOrtLinkage false; ok true
otool -L …/darwin-x64/opentake_engine_v40.node   # no ONNX Runtime / CoreML dylib
```
No Rosetta on this host → x64 runtime and inference quality **Unknown**; only
static parity and the tract-backend build are verified.

### 2.6 CI / signing
```bash
bash scripts/route-b/platform/validate-workflows.sh      # YAML + scripts OK
node scripts/route-b/platform/check-wgpu-features.mjs    # macOS/Windows/Linux READY
bash scripts/route-b/platform/sign-macos.sh              # SKIP (no Apple secrets; 0 identities)
bash scripts/route-b/platform/build-linux.sh             # BLOCKED exit 78
bash scripts/route-b/platform/build-windows.sh           # BLOCKED exit 78
node scripts/route-b/verify/verify-ci-signing.mjs        # 8 PASS, 1 WARN (no pwsh)
```
No CI run, no Windows/Linux build, no signing/notarization was performed.

## 3. Remaining blockers / unknowns

2. **x64 runtime** — v40 x64 is a verified tract build but cannot execute on this
   arm64 host (no Rosetta); search quality/perf on x64 is **Unknown**.
3. **HDR scope** — production path is real for HDR PQ video-only, untransformed
   layers, no audio; the shared wgpu compositor/preview remains SDR. HDR10+/
   Dolby Vision/HLG, HDR hardware display and OS EDR are not covered.
4. **Stale arm64-only dist tarball** — `dist/*-darwin-arm64.tgz` is the old v38
   package; only the rebuilt universal artifact is current. Do not ship the
   stale arm64 tarball.
5. **CI/signing** — workflow/scripts are prepared but no runner/credentials
   exist here; Windows/*nix runtime and Authenticode/Apple signing remain
   unknown.
6. **Real providers** — Host tests still use loopback mocks; no real key/network
   call was made.
7. **Freshness window** — HEAD moved from `ec625c3` to `92c8780` during this
   verification; the final universal package was rebuilt at 23:37 and all
   commands above ran against `92c8780` and that package.

## 4. Docs status
- `docs/architecture/route-b-hdr.md` now documents both the isolated and the
  production addon/Host HDR path and its scope limits; the verification matches.
- `docs/architecture/route-b-search.md` documents the per-target backend
  (ort-native arm64, tract elsewhere) and real-inference evidence; matches.
- `docs/architecture/route-b-verification.md` still contains the old v27 addon
  names and “HDR/ducking not verified” wording — stale, should be updated or
  retired.
- `route-b-native-ui.md`/native-editor README correctly describe the optional
  preview; live-renderer acceptance is still pending.

## 5. Verifier scripts used (owned under `scripts/route-b/verify/`)
- `revalidate-v28.sh` — version-autodetecting end-to-end run (clean rebuild,
  hash equality, smoke/verify-addon in both runtimes, fresh pack, tarball,
  temp-DSH install, Host API on temp copy + extracted package).
- `verify-tarball.mjs` — package file set/addon versions/slices/plugin load.
- `verify-host-api.mjs` — 32-check Host API probe incl. real Host search,
  production HDR10 pass-through + SDR rejection, native-editor bundle route.
- `verify-search-model.mjs`, `verify-real-search.mjs` — pinned checksums and
  real text/image inference.
- `verify-hdr10.mjs`, `verify-hdr-production.mjs` — HDR10 metadata classifier and
  production addon export (true PQ / SDR rejection).
- `verify-native-ui.mjs`, `verify-ci-signing.mjs` — static/browser UI and CI/
  signing evidence with explicit limits.


## 7. Task-77 addendum — HDR audio/layer expansion + native panels (2026-11-08 23:54)

### 7.1 HDR audio and layer expansion — **Verified on a source-built addon; package/artifacts stale**

Worktree contains the follow-up expansion (`crates/opentake-node/src/lib.rs`,
`crates/opentake-node/src/edit_request.rs`, `crates/opentake-render/src/hdr.rs`):
audio clips are skipped by the HDR visual preflight and mixed into the HDR10
container, and static affine transform/opacity layers are composited via
`LinearCompositor::composite_transformed`. Independent verification with a clean
build of the current source (`target/release/libopentake_node.dylib` sha256
`81cbf44c…`, **not** the checked-in `77b9de3d…` v40):

```bash
node scripts/route-b/verify/verify-hdr-expansion.mjs   --addon /tmp/opentake_expanded_latest.node --json
# pass true
# audio: summary {hdr10:true, hasAudio:true}; ffprobe streams:
#   hevc / Main 10 / yuv420p10le / bt2020 / smpte2084 / bt2020nc
#   aac  / LC / 48000 Hz / 1 channel
# layers: 2 overlapping HDR layers (one affine-transformed with rotation,
#         one opacity 0.5) -> hevc Main 10 / yuv420p10le / bt2020 / smpte2084
# sdrRejected: "HDR10 export requires HDR sources; hdr10_sdr_fallback is SDR"
node scripts/route-b/verify/verify-hdr10.mjs <hdr10_with_audio.mp4>
# hdr10 PASS (mastering + content-light side data)
node scripts/route-b/verify/verify-hdr10.mjs --expect not-hdr retag_false_hdr.mp4
# false-hdr rejected
```

Scope after expansion (matches the updated `route-b-hdr.md`): HDR PQ video,
static affine transform/opacity, mixed AAC audio are supported; crop/masks/
effects/grades/LUTs/chroma key/stabilization/transitions/reverse/nested
sequences, text/image layers, visual keyframe tracks and HLG are still rejected;
range exports mux the full timeline audio mix; the production wgpu compositor and
ordinary SDR preview/export remain SDR.

**Blocker:** the checked-in v40 addon (`77b9de3d…`) and the current `dist`
package were built before this expansion. Live Host still loads v40; expansion is
verified only against the source build. A rebuilt addon/package is required
before claiming it shipped.

### 7.2 Native Inspector/Export/Settings panels — **Verified live via CDP**

The authenticated DSH Web GUI was reached independently through headless Chrome
CDP at `127.0.0.1:9333` (page `http://127.0.0.1:56474/`). This is the renderer;
the DSH "experimental inspector" at `127.0.0.1:9230` exposes only the runtime
host target (`dsh://host`, Runtime/Debugger/Profiler, no DOM) and the web URL
returns 401 without the authenticated browser session, so CDP on 9333 is the
usable path. Evidence:

- Opened `OpenTake（原生）`, switched to `原生预览`: native ShadowRoot mounted;
  header contains `检查器`, `导出`, `设置` (`data-otn-action` =
  `open-inspector`, `open-export`, `open-settings`).
- **Inspector**: selected a clip (`id-13` in a temp project); fields
  opacity/volume/position/scale/rotation rendered. Changed opacity 1 → 0.5;
  live engine timeline went `version 2 → 3`, clip opacity `0.5`; `撤销` restored
  opacity 1/version 4.
- **Edits**: native `右移` moved the selected clip `startFrame 0 → 1`
  (version 2 → 3); `撤销` restored it (version 4).
- **Export**: native panel form has outPath, codec (h264/h265/prores/
  prores4444), quality, bitDepth, range start/end, `duckMusic`, `hdr10`; submitting
  an h264/1080p export completed and returned
  `{fps:30,frameCount:1,hasAudio:false,hdr10:false,width:1920,height:1080}`
  at `/tmp/native-panel-export.mp4`. **Export shape/engine mutation verified.**
- **Settings**: native sheet showed storage categories (thumbnails 210 KB etc.),
  search model `ready · siglip2-base-patch16-256`, transcription
  `not configured`, and search-index JSON.
- **Fallback**: switching back to `Iframe 编辑器` restored the iframe
  `/opentake-studio-route-b/app/`; the native host is hidden and the iframe is
  the working default. Native preview can be toggled again.
- Screenshots: `/tmp/live-native-v40-verifier.png` (native home),
  `/tmp/live-native-editor-mode.png`, `/tmp/live-native-panels.png` (export
  sheet). Temp project used: `/tmp/routeb-native-edits2.opentake`; only the
  temp project was mutated.

### 7.3 Bundle serving / package — **Live bundle current, shipped package stale**

- The Host serves the rebuilt bundle at `/app/native-editor/native-editor.js`
  (255,980 B; contains `open-inspector/open-export/open-settings`), and native
  unit tests are **14/14** (shell **11/11**); live CDP confirms the panels render.
- The current `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` (23:37)
  is **stale for task-77**: its bundled native-editor has 0 `open-export`
  markers and its arm64 addon is `77b9de3d…` (pre-expansion). The checked-in
  `native/darwin-arm64/opentake_engine_v40.node` is likewise `77b9de3d…`.
- A staged rebuilt package (current tree, source-built addon
  `81cbf44c…`, current bundle, arm64-only) passes `verify-tarball` **12/13**,
  Host API **31/32** (incl. HDR + bundle route), and the installed addon passes
  the HDR audio/layer expansion test — proving the rebuild path works; the
  shipped dist must be rebuilt and the live Host plugin reloaded.

### 7.4 Task-77 blockers
1. Rebuild the v40 addon/wrapper + `dist` package from the current worktree
   (addon `81cbf44c…`, bundle 255,980 B); the checked-in addon/dist are stale.
2. Reload/restart the live Host plugin after the rebuild; expansion is not active
   in the currently loaded v40.
3. HDR expansion remains supported-subset only (see §7.1) and uses a CPU linear
   compositor; wgpu preview stays SDR.
4. Live panel verification requires the authenticated Chrome profile at CDP 9333;
   the host inspector 9230 cannot see the DOM. No implementation edits/commits
   were made by the verifier.
