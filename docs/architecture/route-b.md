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
- Verified in DSH: full home/editor render, new project writes a real
  `.opentake` bundle, media import returns ffprobe metadata, double-click adds
  video+linked-audio clips, inspector loads, and the direct video preview plays.
- Poster thumbnails generated through `opentake-media` decode; the media card
  displays the real frame. Waveform buckets are bridged via `get_waveform`.
- Basic `composite_frame` using `opentake-render` wgpu compositor: builds the
  render plan, decodes video/image layers and rasterizes text through a Route B
  resolver, returns a PNG data URL. Verified with a text overlay over video and
  a simple shape Lottie animation. Streaming playback remains.
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
3. Poster thumbnails, waveform buckets and basic video/image GPU composite
   (done); text/Lottie layers, streaming playback, proxies and sprite
   filmstrips remain.
4. Export pipeline.
5. AI/transcription/search/generation and Motion.
6. Packaging, signing, Windows/Linux, full parity verification.
