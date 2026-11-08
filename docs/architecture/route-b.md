# Route B — OpenTake engine inside DeepSeek Harness

Status: Milestone 2 prototype, 2026-11-08, branch `feat/dsh-rust-engine`.

## Architecture

```
DSH Host process
└── @opentake/studio-route-b
    ├── Node-API addon (opentake-node) → opentake-core::AppCore
    ├── /engine/* routes + opentake_route_b_* tools
    └── /app/* static React UI + Tauri IPC shim
            └── original OpenTake React editor (iframe)
```

No Tauri window, no sidecar, no MCP bridge. The Rust engine is loaded in-process
by the DSH Host through N-API.

## Implemented

- `opentake-node` addon: `newProject`, `newProjectAt`, `openProject`,
  `saveProject`, `getTimeline`, `mediaList`, `importMedia`, `apply(EditRequest)`,
  `undo`, `redo`, `canUndo`, `canRedo`.
- `EditRequest` serde mirror extracted from `src-tauri/src/commands.rs`; the
  existing React UI command payloads are accepted unchanged.
- DSH plugin serves the built React app and injects a Tauri shim
  (`invoke`, events, `convertFileSrc`, file-dialog prototype).
- Lottie import supports both bodymovin `.json` and `.lottie` ZIP containers
  (`animations/*.json` extraction); a simple zipped shape renders in the
  composite.
- Nested/compound sequences are supported through the extracted `EditRequest`
  (`createNestedSequence`): verified a 60-frame nested clip composites and
  exports to 1280x720 H.264; nested audio is included in the mixdown
  (verified H.264+AAC).
- Global library list/favorite/categorize/rename/delete and import-to-project are
  bridged through `opentake-media::library::LibraryStore`; favorite/list/import
  were verified.
- Media relink keeps the asset id and updates the source path (verified via
  Host tool). Project-local low-resolution proxies are generated with
  `opentake-media::proxy::create_proxy` and persisted in the manifest; create
  and remove were verified through the Host IPC.
- Verified in DSH: full home/editor render, new project writes a real
  `.opentake` bundle, media import returns ffprobe metadata, double-click adds
  video+linked-audio clips, inspector loads, and the direct video preview plays.
- Poster thumbnails generated through `opentake-media` decode; the media card
  displays the real frame. Waveform buckets are bridged via `get_waveform`.
- `composite_frame` using `opentake-render` wgpu compositor: builds the render
  plan, decodes video/image layers, rasterizes text and Lottie through a Route B
  resolver, returns a PNG data URL. Verified with a text overlay over video and
  a simple shape Lottie animation.
- `export_video`: renders every timeline frame, encodes H.264/H.265/ProRes via
  `opentake-media` VideoEncoder, and muxes a linear mono audio mixdown. Verified
  320x180 2 s source → 1280x720 H.264 + AAC, 2.0 s. ProRes 4444 uses a
  transparent clear and preserves alpha (verified with a text-only timeline).
  Audio uses linear clip volume plus fade-in/fade-out envelopes. Chunked export exposes
  `/engine/export/status` progress and cancel; the UI shim polls it and emits
  `export://progress`; cancel removes the partial output. The migrated React
  export dialog was exercised end-to-end: it showed `导出中… 62%` and wrote a
  1280x720 H.264+AAC file. Ducking envelopes remain unimplemented.
- Node smoke test: `node crates/opentake-node/test/smoke.mjs`.

## Known gaps

- `composite_frame`, GPU playback, thumbnails/sprites, proxies and waveform
  caches are not bridged yet; preview falls back to direct source playback.
- File dialogs are stubbed to `/tmp/opentake-route-b/`.
- Export, transcription/search/generation, Motion documents, settings,
  account/updater and packaging remain.
- Only `darwin-arm64` was built/tested; native addon needs per-platform builds.
- `EditRequest` is duplicated until a shared `opentake-ipc` crate is extracted.

## Milestones

1. Engine addon + project/timeline + UI shell (done).
2. Media import/probe/list + timeline insert + direct preview (done).
3. Poster thumbnails, waveform buckets, GPU composite (video/image/text/Lottie)
   and basic export with linear audio (done); streaming playback, export
   progress/cancel (basic), proxies and sprite filmstrips remain.
4. Export pipeline.
5. AI/transcription/search/generation and Motion.
6. Packaging, signing, Windows/Linux, full parity verification.
