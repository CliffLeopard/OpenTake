# Route B — verification record

Status: **partial parity verified, not full parity**  
Branch: `feat/dsh-rust-engine`  
Artifact under test: addon v28, commit `5caeb7d` plus verification/folder-import changes  
Date: 2026-11-08

This record separates what was actually exercised from what remains
unimplemented. It is not a parity claim.

## 1. Build and automated tests

| Check | Result |
|---|---|
| `scripts/build-route-b-addon.sh` | PASS, arm64 `opentake_engine_v28.node` |
| `ROUTE_B_TARGET=x86_64-apple-darwin` build | PASS, x64 Mach-O addon (not run) |
| `node crates/opentake-node/test/smoke.mjs` | PASS (`route-b addon smoke: ok`) |
| `node --test plugins/opentake-studio/test/` | PASS 422 tests / 40 suites (the separate pure-JS plugin) |
| `scripts/package-route-b.sh` | PASS, universal tarball with both v28 addons |

The Route B addon itself has only the smoke test; the 422 tests are for the
separate JS plugin and are not evidence for Route B behavior.

## 2. Independent addon contract

`node scripts/route-b/verify-addon.mjs --addon .../opentake_engine_v28.node --workers`
passed **22/22** checks (0 failed, 2 warnings): method surface, snapshot/result
shapes, apply validation/atomicity, undo/redo, persistence/reopen, compatibility
read-only, multiple instances and 4 concurrent worker_threads.

Warnings: `newProjectAt(existing path)` overwrites without a guard, and the
Host `project_new {path}` reaches that path. This is a known data-loss hazard,
not silently accepted.

## 3. Host API end-to-end

An earlier live-Host scripted run passed **44/44** checks (kept as historical evidence; the independent verifier later reran 25/27, with one thumbnail warning since fixed):

- project new/path/file, settings, import video+Lottie, ffprobe metadata, poster
  thumbnail, waveform (4000 buckets)
- video + linked audio insert, Lottie insert, text overlay, composite PNG,
  capture-frame import, preview endpoint
- playback start/status/audio WAV, range export, audio-only M4A, ProRes 4444
  (`yuva444p12le`), ASR mock -> captions -> SRT, XMEML/EDL/OTIO/FCPXML
- library favorite/list, project favorite mirror, proxy create/remove, relink,
  nested sequence create/composite/export, Motion create/preview/publish,
  storage usage
- range export verified 0.500s H.264+AAC; nested export verified.

A second edit script passed **7/7**: split, undo, redo, move, project save/open,
set effects, set mask. The composite of a grayscale+circular-mask clip rendered
the expected masked grayscale frame.

Evidence files: `/tmp/verify-routeb.log`, `/tmp/verify-composite.png`,
`/tmp/comp-video.png`, `/tmp/routeb-verify-*`.

## 4. UI verification

CDP-driven run against `http://127.0.0.1:56474` with the OpenTake (Rust) panel:

- editor rendered, media imported, double-click created video+linked-audio clips
- export dialog opened with codec/resolution/transparent controls
- direct WebKit playback advanced `video.currentTime` to 1.46s and the playhead
  to `00:01:14`; no runtime exceptions
- native `playback_start` was not invoked for this simple stack because the
  route resolves to WebKit; the Host native endpoint was exercised separately
- screenshots: `/tmp/verify-ui2-editor.png`, `/tmp/verify-ui-export.png`

Timeline sprite requests now return a cached ffmpeg tile grid; the editor no
longer falls back to the warning path.

## 5. Package and installation without a local OpenTake app

- `ps` shows no `OpenTake`/Tauri process; the plugin code has no `/Applications`
  app path and only a comment mentioning `__TAURI_INTERNALS__`.
- The plugin loads its own `.node` from `native/darwin-<arch>/`; no sidecar RPC,
  no Tauri window, no installed OpenTake executable.
- Universal package: 17 files, arm64 + x64 addons; `npm install` into a clean
  temp project loaded the packaged arm64 addon and returned a timeline.
- `dsh plugin --profile routeb-pkg-check add .../opentake-studio-route-b-0.1.0-darwin-universal.tgz`
  installed the tarball as a normal profile dependency; `dsh --profile
  routeb-pkg-check --dump-config` mounted `@opentake/studio-route-b`.
- **Remaining runtime dependencies:** system `ffmpeg`/`ffprobe` (media), local
  Chrome/Chromium (only Motion preview/publish), system fonts, macOS arm64.
  These are not OpenTake installations, but they are not bundled.

## 6. Feature matrix

| Area | Route B status | Evidence / gap |
|---|---|---|
| Project new/open/save | verified | API + UI |
| Timeline edit, split/trim/move, undo/redo | verified | API |
| Effects, masks, keyframes, transitions | effects/mask API verified; keyframes/transitions not matrix-tested | EditRequest supports them |
| Stabilization analysis | verified | 48-keyframe track from motion test clip; `applyStabilization` applied to clip |
| Media import/probe/thumbnail/waveform | verified | API |
| Folder import | verified | recursive scan + import (video/Lottie) |
| Lottie JSON/.lottie import and composite | verified | import + simple shape |
| Proxies, relink, library, favorites | verified | API |
| Timeline sprites | verified | 24-frame 800x450 JPEG tile grid |
| Composite video/image/text | verified (video/effects/mask/text) | Lottie simple |
| Playback | WebKit direct path verified; native cpal clock integrated | Host playback uses native audio clock (frame 29 in 1s); preview frames still on-demand |
| Export H.264/AAC, range, alpha, audio-only | verified | current run |
| Export H.265/10-bit | verified integrated | Host `export_video bitDepth=10` produced Main10 `yuv420p10le` BT.709; HDR tone-map/ducking remain isolated |
| Interchange and subtitles | verified | XMEML/EDL/OTIO/FCPXML/SRT |
| ASR/captions | verified against mock | real provider not called |
| Search | text fallback only; Host status now honest | SigLIP assets/backend missing; `opentake-search` capability crate exists |
| Generation image/speech/video | verified against mocks | real providers not called |
| Motion CRUD/preview/publish | verified incl. template path | Host template preview/publish integrated; raw code path still not exposed |
| Settings storage | verified | other settings/account/updater missing |
| Agent/MCP | DSH tools exist | no MCP bridge by Route B design |
| macOS arm64 | verified | x64 built, not run |
| Windows/Linux | not built/tested | — |

## 7. Remaining gaps

1. SigLIP2 visual search (about 1.54 GB ONNX assets + ONNX Runtime backend).
2. Real streaming/cpal playback and exact A/V master clock.
3. Ducking, 10-bit/HDR export contracts.
4. Motion template/code publish path and per-frame Chrome performance.
5. Broader UI module verification (folder import is verified).
6. Windows/Linux builds, signing, notarization, updater/account surfaces.
7. Real ASR/generation provider credentials (only mocks used).

## 8. Verdict

Route B is a working, self-contained prototype that executes the core editor,
media, composite, export, caption, library, Motion and generation paths through
an in-process Rust addon. It is **not full OpenTake parity**: the gaps in §6
remain, and the package still expects system FFmpeg and Chrome.
