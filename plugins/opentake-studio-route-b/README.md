# OpenTake Studio — Route B

This is the Route B prototype: the existing OpenTake Rust engine is loaded
**in-process** by the DeepSeek Harness Host as a Node-API addon, and the existing
OpenTake React editor is served inside a same-origin iframe in a DSH panel.

No Tauri window, no sidecar process, no MCP bridge.

## What works (Milestone 1)

- `crates/opentake-node` builds a Node-API 8 addon exposing the OpenTake
  `AppCore` (project new/open/save, timeline snapshot, `apply(EditRequest)`,
  undo/redo) plus media probe/import/list through `opentake-media`.
- The DSH Host loads `native/<platform>-<arch>/opentake_engine_v2.node` and
  exposes `/opentake-studio-route-b/engine/*` + `opentake_route_b_*` tools.
- The existing Vite-built React editor (`web/`) is served at
  `.../app/`, with a Tauri shim that forwards `invoke` to the Rust engine.
- Verified in DSH: plugin panel opens the full OpenTake home + editor, creating
  a new project through the UI drives the Rust engine; `edit_apply`/undo/redo
  work from Host tools. Media can be imported (ffprobe metadata), shown in the
  media panel, double-clicked onto the timeline, and the direct video preview
  plays inside DSH. Media cards get generated poster thumbnails; waveform
  buckets are available through the Host IPC/tool. A basic wgpu
  `composite_frame` path renders video, image, text and Lottie layers to a PNG
  data URL.

## Build

```bash
# Rust toolchain (first time only)
curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal

./scripts/build-route-b-addon.sh
cd web && pnpm install --frozen-lockfile && pnpm exec vite build --base=/opentake-studio-route-b/app/
cd .. && rm -rf plugins/opentake-studio-route-b/web && cp -R web/dist plugins/opentake-studio-route-b/web
```

Then install `plugins/opentake-studio-route-b` as a DSH bundle and restart the
plugin. The native binary is intentionally gitignored; run the build script on
each platform.

## Cross-build

`ROUTE_B_TARGET=x86_64-apple-darwin ./scripts/build-route-b-addon.sh` places a
macOS x64 addon; the plugin selects the file by platform/arch. x64 is built but
not runtime-tested on this machine.

## Current limits

- Media import/probe/list/relink/proxy, direct video preview, thumbnails, video/image/text/
  Lottie (.json/.lottie) GPU composite, and H.264/H.265/ProRes export with a linear audio
  mixdown (including clip volume/fade envelopes; transparent ProRes 4444) work.
  The global asset library lists/favorites/imports entries; project media can be
  favorited/unfavorited and mirrored into it. The Settings storage pane reads
  and clears Route B's derived caches. Caption cues export
  to SRT/VTT; XMEML/EDL/OTIO/FCPXML interchange export is bridged. Provider
  ASR (OpenAI-compatible verbose JSON) can transcribe and generate captions;
  configure `OPENTAKE_ASR_URL`/`OPENAI_API_KEY`. Basic streaming playback is
  emulated by a wall-clock Host loop and `/engine/preview/frame`. Streaming playback,
  proxies/sprites, export progress/cancel, transcription/search/generation,
  motion documents and account/update surfaces still need their Rust command
  bridges.
- The Tauri file dialogs are stubbed to `/tmp/opentake-route-b/demo.opentake`;
  native DSH dialogs are a later milestone.
- The iframe is a stepping stone; a native DSH React mount is the target.
- `EditRequest` is extracted from `src-tauri/src/commands.rs` and must be kept
  in sync until it is moved into a shared `opentake-ipc` crate.
