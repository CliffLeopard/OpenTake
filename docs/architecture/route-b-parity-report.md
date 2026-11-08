# Route B — final integration verification

| | |
|---|---|
| Status | **Final integration verification of the v40 working tree; per-item status below** |
| Branch / commit | `feat/dsh-rust-engine` @ `92c8780` (`feat(route-b-ui): HDR10 export checkbox and native editor bundle`); worktree clean except `?? .codegraph/` |
| Snapshot | 2026-11-08 23:40 local |
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
| 2 | Final universal package + DSH profile install | **Verified** | `verify-tarball` on the dist universal: **12 passed, 1 warning, 0 failed** (24 files, both v40 slices byte-equal to repo, packaged addon smoke, packaged plugin loads **32 tools**); temp-`DSH_HOME` `dsh plugin add` + `--dump-config` + both slices installed; installed arm64 addon hash matches v40 and loads. Fresh `npm pack` from the tree also passes (same 13 checks). The old `dist/*arm64.tgz` is stale (v38, no native-editor bundle) — see §3. |
| 3 | Real SigLIP2 search (index/query/text/image) | **Verified** | model complete with all pinned SHA-256; addon real search **PASS** (text `red` → red-video 0.1321; image red frame → red-video 0.9999 > blue-video 0.9559); Host API (extracted final package) real Host search **PASS**: `installed:true`, `visualAvailable:true`, `backend:ort-native`, indexed 4, text moments, image self-match; Host API **31 passed, 0 failed (32 checks)** including search, HDR, native-editor bundle route. |
| 4 | HDR10 production path (`hdr10=true`) | **Verified (supported subset) / Partial (scope)** | `verify-hdr-production.mjs` against the installed v40 addon: `hdr10=true`, ffprobe **HEVC Main 10 / yuv420p10le / BT.2020 / SMPTE2084 / bt2020nc**, mastering + content-light metadata; SDR source request rejected (`HDR10 export requires HDR sources`); H.264 request rejected (`requires codec h265`). Host API production HDR export also PASS (same tags) and SDR request rejected. A 10-bit SDR re-tagged as PQ without mastering metadata is rejected by `verify-hdr10.mjs`. Scope limits: HDR PQ video-only, untransformed/ungraded layers, no audio in HDR mode; shared wgpu compositor remains SDR. |
| 5 | Native editor live mount | **Partial / Unknown** | Optional native preview is wired: `ui/client.js` lazily imports `NATIVE_BUNDLE_URL` (`/app/native-editor/native-editor.js`), package ships `web/native-editor/**` (230,535 B bundle), Host API serves the bundle (`31 passed` check), native-editor tests **10/10**, shell tests **11/11**, Chrome harness renders (56,727 B screenshot). **Live DSH renderer mount is Unknown:** DSH's inspector at `127.0.0.1:9230` exposes only a `dsh://host` runtime target (domains Runtime/Debugger/Profiler, no DOM/Page/Target); client slot/theme inspect times out; `http://127.0.0.1:56474` returns 401 and no tokenized URL is recoverable. |
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
Static/served integration is verified; **live DSH renderer mount remains
unverified** because this agent context has no authenticated browser/CDP access
to the DSH renderer.

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

1. **Live DSH native-editor mount** — cannot be observed from this context:
   the only inspector target is the host runtime (`dsh://host`, no DOM), client
   slot inspection times out, and the web UI requires an auth URL this session
   does not have. The optional toggle/bundle/served route are verified statically;
   the actual renderer state remains **Unknown**.
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
