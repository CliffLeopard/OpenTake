# Route B media / render / export boundary map

Status: source inventory + milestone recommendation, 2026-11-08, branch
`feat/dsh-rust-engine` (HEAD `5caeb7d`). Read-only investigation: no source was
modified for this document.

Route B runs the OpenTake Rust engine **inside the DeepSeek Harness Host** through
the Node-API addon `crates/opentake-node`; the existing React editor is served by
`plugins/opentake-studio-route-b`. This document maps the Tauri command surface
that the addon has to reproduce, identifies the real external runtimes behind
each command, explains preview/playback/export orchestration, and recommends the
milestone order for the media bridge.

Existing reports (not replaced by this document):

- [`route-b.md`](route-b.md) — prototype status and verified feature list.
- [`route-b-packaging.md`](route-b-packaging.md) — tarball/ABI/signing notes.
- [`ARCHITECTURE.md`](ARCHITECTURE.md), [`PLAYBACK-ENGINE.md`](PLAYBACK-ENGINE.md)
  — desktop architecture and the playback contract.

## 1. Current branch state

The desktop application is the reference implementation; Route B is a second
front end over the same crates.

| Layer | Location | What it owns |
|---|---|---|
| Tauri commands + managed state | `src-tauri/src/lib.rs`, `src-tauri/src/*.rs` | The full command surface, window/dialog/keychain/updater, event emission |
| Engine crates | `crates/opentake-{domain,ops,project,render,media,motion,gen,agent,core}` | Authoritative timeline, rendering, media IO, AI adapters |
| N-API addon | `crates/opentake-node/src/lib.rs` | In-process subset used by the DSH Host |
| Host bridge | `plugins/opentake-studio-route-b/index.js` | HTTP routes, Tauri IPC shim, Host-side fallbacks (ASR/generation/Motion/playback/UI) |

The addon currently exposes these methods (all synchronous N-API calls; most
return JSON strings, a few return booleans or arrays):

```text
new, newProject, newProjectAt, openProject, saveProject, getTimeline,
apply, undo, redo, canUndo, canRedo,
mediaList, importMedia, relinkMedia, createMediaProxy, removeMediaProxy,
thumbnail, waveform, captureFrameToMedia,
compositeFrame,
exportBegin, exportStep, exportFinish, exportCancel, exportVideo,
exportAudio, audioMixWav,
exportTimeline, exportSubtitles,
toggleFavorite, libraryList, libraryFavorite, libraryUnfavorite,
libraryCategorize, libraryRename, libraryDelete, libraryImportToProject
```

The Host bridge additionally implements, in JavaScript rather than in the addon:
provider ASR + caption generation, image/speech/video generation HTTP calls,
Motion Studio document CRUD + Chrome preview/publish, wall-clock playback with a
mixed WAV, text-only search fallback, and the storage pane. This split is
important: the JSDoc in `crates/opentake-node/src/lib.rs` still describes only the
"project lifecycle + timeline snapshots" milestone, while the checked-in addon
has grown a media/render/export subset. The command tables below use the actual
method list, not that stale module comment.

## 2. Layer map

```text
DSH Host process (Electron main / Node)
├── plugins/opentake-studio-route-b/index.js
│   ├── HTTP /engine/* routes + opentake_route_b_* tools
│   ├── Host-side AI: ASR (ffmpeg+fetch), provider image/TTS/video, text search
│   ├── Host-side Motion: Chrome/Chromium CDP + ffmpeg
│   └── wall-clock playback + /engine/playback/*
└── crates/opentake-node (N-API cdylib, N-API 8)
    ├── opentake-core::AppCore           (session, undo, EditRequest apply)
    ├── opentake-project                 (.opentake bundle, interchange)
    ├── opentake-media                   (ffmpeg CLI, thumbnails, waveform, proxy, encoder)
    └── opentake-render                  (RenderPlan, wgpu compositor, text)
        external child processes: ffmpeg / ffprobe
        GPU: wgpu backend (currently Metal only in Cargo features)
```

Not linked into the addon today: `opentake-motion`, `opentake-gen`,
`opentake-agent`, `opentake-media` features `whisper-backend`, `ort-backend`,
`model-download`; no `cpal`/`axum` playback dependencies.

The desktop build enables those features explicitly in `src-tauri/Cargo.toml`
(`opentake-media` with `whisper-backend`, `ort-backend`, `model-download`;
`opentake-motion` with `chromium`; `playback-engine` default feature adding
`cpal`/`axum`/`bytes`/`futures`/`image/jpeg`).

## 3. Command inventory

Legend for **Route B**:

- **A** — implemented by an N-API addon method.
- **H** — implemented Host-side in JavaScript (not the Rust command).
- **N** — not bridged yet.
- **D** — desktop-only / out of the media bridge scope.

### 3.1 Project, timeline, and editing (reference layer)

| Tauri command(s) | Rust path / core call | External runtime | Route B |
|---|---|---|---|
| `project_new`, `project_open`, `project_save`, `get_timeline`, `get_default_project_dir`, `check_path_exists` | `commands.rs`; `opentake-core::dto::{handle_project_new,handle_project_open,handle_project_save,handle_get_timeline}` | filesystem only | **A** except `get_default_project_dir`/`check_path_exists` (**N**) |
| `edit_apply`, `undo`, `redo`, `can_undo`, `can_redo` | `commands.rs`; `AppCore::apply`, `opentake-ops::EditCommand`, undo stack | none | **A** (`apply`, `undo`, `redo`, `canUndo`, `canRedo`) |
| `export_xmeml`, `export_fcpxml`, `export_fcpxml_modern`, `export_edl`, `export_otio`, `export_subtitles` | `commands.rs`; `opentake-project` exporters; `opentake-domain` SRT/VTT | none | **A** via `exportTimeline` (xmeml/edl/otio/fcpxml); `fcpxml_modern` has no distinct addon format (**partial**) |

`edit_apply` crosses the process boundary with a serde `EditRequest` mirror in
`crates/opentake-node/src/edit_request.rs`. Keeping that mirror in sync with
`src-tauri/src/commands.rs` is a standing risk (see §8).

### 3.2 Media import, probe, and caches

| Tauri command(s) | Implementation and crate calls | External runtime | Route B |
|---|---|---|---|
| `import_media` | `media.rs::import_media` → `AppCore::import_media_batch_for_project_persisted_checked`; probe via `opentake_media::probe` | ffprobe CLI (best-effort; import survives probe failure) | **A** (`importMedia`) |
| `import_folder` | `media.rs::import_folder` (recursive folder import + prewarm scheduling) | ffprobe CLI | **N** (addon `importMedia` accepts files only) |
| `get_media` | `media.rs::get_media` → `MediaListDto::from_core_with_import_results` | cached posters only | **A** (`mediaList`; poster paths may be absent) |
| `preload_media` | `media.rs::preload_media` (frame/waveform prewarm) | ffmpeg/ffprobe | **N** |
| `relink_media` | `media.rs::relink_media` → core relink + cache key validation | none/ffprobe | **A** (`relinkMedia`) |
| `sync_project_favorites` | `media.rs::sync_project_favorites` → `LibraryStore` | none | **N** |
| `save_clip_as_media` | `media.rs::save_clip_as_media`; range trim + `opentake_media::trim_video_range` | ffmpeg | **N** |
| `extract_audio` | `media.rs::extract_audio`; `MediaEngine::extract_audio` | ffmpeg | **N** |
| `generate_thumbnail` | `media.rs::generate_thumbnail`; `opentake-media` poster/sprite decode | ffmpeg decode, image encoder | **A** (`thumbnail`; no sprite grid) |
| `request_timeline_sprite`, `set_timeline_sprite_interactive` | `media.rs` sprite cache + `prewarm` single low-priority worker | ffmpeg multi-seek decode, image encoder | **N** |
| `preview_poster` | `media.rs::preview_poster`; `decode_frame_at` (hi-res poster cache) | ffmpeg | **N** |
| `get_waveform` | `media.rs::get_waveform`; `opentake_media::waveform` (PCM decode → RMS buckets) | ffmpeg PCM extraction | **A** (`waveform`) |
| `create_media_proxy`, `cancel_media_proxy`, `remove_media_proxy` | `media.rs` → `opentake_media::proxy::create_proxy` / remove | ffmpeg encode | **A** for create/remove; **N** for `cancel` |
| `set_proxy_playback_enabled`, `get_proxy_playback_enabled` | `MediaProxyState` in memory | none | **N** |
| `analyze_stabilization`, `cancel_stabilization_analysis` | `media.rs` → `opentake_media::analysis::track_translation_motion` etc. | ffmpeg decode (bounded 48 frames); CPU only | **N** |
| `analyze_loudness`, `cancel_loudness_analysis` | `media.rs` → `opentake_media::analysis::analyze_loudness` | ffmpeg PCM decode; CPU DSP | **N** |
| `prepare_denoise`, `cancel_denoise_analysis` | `media.rs` → `opentake_media::analysis::denoise_interleaved` | ffmpeg decode; CPU DSP | **N** |
| `separate_audio_stems`, `cancel_stem_separation`, `import_stems_to_tracks` | `media.rs` → `opentake_media::analysis::separate_stems` | local mid-side model (no network) or hosted provider via `opentake-gen`; ffmpeg PCM | **N** |
| `toggle_favorite` | registered from `media.rs`; mirrors into `LibraryStore` | none | **A** (`toggleFavorite`) |

### 3.3 Render and preview

| Tauri command | Implementation | External runtime | Route B |
|---|---|---|---|
| `composite_frame` | `render.rs::composite_frame` → `composite_rgba` / `composite_timeline_frame`; `RenderPlan` + `Compositor.render_to_rgba` + `MediaResolver`; PNG data URL | wgpu GPU, ffmpeg decode, system fonts, Velato/Vello Lottie, LUT via GPU | **A** (`compositeFrame`) |
| `cancel_composite_frame` | `render.rs` cancellation token + generation guard | none | **N** (addon calls are synchronous; Host uses newest-request-wins) |
| `capture_frame_to_media` | `render.rs::capture_frame_to_media` → composite/source decode → PNG → media import | wgpu, ffmpeg, image encoder | **A** (`captureFrameToMedia`) |

`composite_frame` is *paused/scrub* rendering, not playback: every call can seek
and decode from scratch. It is correct for a still frame and far too slow for
real-time playback (the desktop playback engine exists precisely for that).

### 3.4 Export

| Tauri command | Implementation | External runtime | Route B |
|---|---|---|---|
| `export_video` | `export.rs::export_video` → `run_export_with_control`: full-timeline `RenderPlan`, wgpu compositor per frame, `VideoEncoder`, linear audio mixdown | wgpu GPU, ffmpeg encode/mux, ffmpeg audio decode | **A** (`exportBegin`/`exportStep`/`exportFinish`/`exportVideo`, plus `exportCancel`) |
| `cancel_export` | `ExportControl` cooperative cancel + partial-output cleanup | ffmpeg child abort/wait | **A** (`exportCancel`) |
| `save_range_as_media` | `export.rs::save_range_as_media` (range render into project media) | wgpu + ffmpeg | **N** (addon has range export, not media import) |
| `export_audio` (Route B extension) | addon `exportAudio` (mix → WAV → ffmpeg AAC/MP3) | ffmpeg | **A** (no corresponding Tauri command) |
| `audio_mix_wav` (Route B extension) | addon `audioMixWav` | ffmpeg PCM decode | **A** (no corresponding Tauri command) |

Desktop export quality: `resolve_preset` selects H.264/H.265/ProRes 422/ProRes
4444 and 720p/1080p/4K. The addon supports the same codec set but hard-codes
`ExportPreset::new(codec, P1080)` while sizing the encoder from the requested
render resolution; this works for the tested paths but is a parity smell to fix
when export is hardened.

### 3.5 Playback

| Tauri command / endpoint | Implementation | External runtime | Route B |
|---|---|---|---|
| `playback_start`, `playback_pause`, `playback_stop`, `playback_seek`, `get_preview_endpoint` | `playback/commands.rs`; `PlaybackEngine` thread + `PlaybackResolver` forward streams + `Compositor` + `AudioClock`/`InstantClock`; `MjpegSink` + `PublicationGate`; loopback `/stream`, `/ws`, `/frame` | wgpu GPU, ffmpeg decode (one `VideoStream` per clip), cpal audio, axum loopback server, JPEG encoder | **H** (wall-clock playhead + `/engine/preview/frame` + mixed WAV); the Rust playback engine itself is **N** |

Desktop playback identity is `{projectEpoch, timelineVersion, sessionId}` with
sequence/terminal publication and fail-closed Origin handling. The current Host
emulation keeps a wall-clock playhead, polls `compositeFrame` for frames and
plays the WAV through an `<audio>` element; it does not achieve the desktop's
continuous-decode/cpal-master-clock behavior.

### 3.6 Transcription and search

| Tauri command | Implementation | External runtime | Route B |
|---|---|---|---|
| `transcribe_model_status`, `download_transcribe_model`, `transcribe_media`, `transcript_get` | `transcribe.rs` → `opentake_media::transcribe` (`WhisperTranscriber`), `TranscriptionCache`, bounded inference worker | whisper-rs/whisper.cpp (native build), ggml model download + SHA-1 verification | **N** in addon; **H** provider ASR (ffmpeg mono 16 kHz WAV + OpenAI-compatible HTTP) and captions |
| `generate_captions` | `captions.rs` → transcript → `opentake_media::caption_specs` packing + `EditCommand::AddCaptions` | same transcription backend | **H** (Host ASR + `addCaptions` edit) |
| `search_model_status`, `download_search_model`, `search_index_status`, `search_index_start`, `search_query` | `search.rs` → SigLIP2 `OrtEmbedder`, `PALMEMB1` embed store, frame sampler, transcript/file matching | ONNX Runtime (feature `ort-backend`), model download + SHA-256, ffmpeg frame decode | **H** text-only fallback (names + cached transcripts); visual index/model is **N** |

### 3.7 Generation, motion, and advanced AI

| Tauri command | Implementation | External runtime | Route B |
|---|---|---|---|
| `generation_cancel`, `generation_retry` | `generation.rs::TauriGenerationBridge`; `opentake-gen` adapters + `opentake-agent` generation bridge; durable placeholder + download/publication | HTTPS providers (fal/Replicate/OpenAI/ElevenLabs), OS keychain, ffmpeg probe/trim | **N** in addon; **H** direct provider image/TTS/video tools |
| `motion_capability`, `motion_preview`, `motion_preview_cancel`, `motion_add`, `motion_edit`, `motion_cancel` | `motion.rs::TauriMotionBridge`; `opentake-motion::HeadlessChromiumRenderer` (CDP virtual time), ffmpeg frame encode, `AppCore` commit | Chromium/Chrome/Edge, ffmpeg | **H** (Chrome + ffmpeg + JS document store); addon **N** |
| `motion_document_list`, `motion_document_create`, `motion_document_read`, `motion_document_hash`, `motion_document_patch` | `motion_documents.rs` project-local store | filesystem | **H** (JS store under `motion-documents/`) |
| `matting_model_status`, `download_matting_model`, `cancel_matting_model_download` | `advanced.rs` → `opentake-media::analysis` RVM ONNX model download/verify | ONNX Runtime (`ort-backend`), model download | **N** |
| `advanced_track_motion`, `advanced_generate_matte`, `advanced_remove_object`, `advanced_match_color`, `advanced_translate_captions`, `advanced_apply_caption_translation_review`, `advanced_script_to_video`, `advanced_generate_avatar`, `advanced_clone_voice`, `cancel_advanced_workflow` | `advanced.rs::AdvancedWorkflowBridge` → `opentake-agent::mcp::advanced`; RVM matting, local/hosted stems, provider workflows; ffmpeg materialization | ONNX Runtime, provider HTTPS, ffmpeg, keychain | **N** |

### 3.8 Runtime dependency summary

| Runtime | Used by | Shape |
|---|---|---|
| ffmpeg / ffprobe | probe/decode/encode, thumbnails, posters, sprites, waveform PCM, proxies, trim, export muxing, audio transcode, Motion frame encode, matte materialization | External CLI child processes driven by `opentake-media::ff` (`ffmpeg-sidecar`); no libav linkage. Packaged binaries are expected beside the desktop executable (PATH/env in development). |
| wgpu GPU | `composite_frame`, export frame loop, playback compositor | In-process GPU device; `opentake-render` currently enables only the Metal backend, so macOS works and Windows/Linux need Cargo feature and adapter work. |
| system fonts | text/caption clips in preview, export, playback | cosmic-text + swash scans system font directories; no fontconfig link (minimal Linux needs fonts installed). |
| Chromium / Chrome / Edge | Motion Studio preview and publish | External browser process over CDP, discovered by `OPENTAKE_CHROMIUM_PATH` then platform install paths; virtual-time frame screenshots. Desktop `opentake-motion` feature `chromium`; Route B Host currently spawns it directly. |
| whisper.cpp (`whisper-rs`) | transcription and caption generation | In-process native library compiled by cmake when `whisper-backend` is enabled (desktop build); ggml model downloaded and SHA-1 verified. Not enabled in the addon. |
| ONNX Runtime | SigLIP2 visual search, RVM matting, ORT worker jobs | In-process native library on macOS/Linux (`ort` `download-binaries`/copy-dylibs); Windows uses the pure-Rust tract backend. Models downloaded and SHA-256 verified. Not enabled in the addon. |
| Provider HTTPS + keychain | generation and hosted advanced workflows | `opentake-gen` reqwest/rustls clients and `keyring`; desktop path uses `opentake-agent` bridges, Route B Host currently calls providers directly from JavaScript. |
| cpal + axum | desktop streaming playback | Audio output and loopback MJPEG transport behind the `playback-engine` feature; not linked by the addon. |
| Node-API | all addon calls | Addon is a `.node` cdylib loaded in the Host process; ffmpeg/Chromium are the only external executables it needs. No sidecar RPC service or MCP bridge is involved. |

### 3.9 Library, LUT, samples, and out-of-scope

| Command(s) | Route B |
|---|---|
| `library_list`, `library_favorite`, `library_unfavorite`, `library_categorize`, `library_rename`, `library_delete`, `library_import_to_project` | **A** (direct `LibraryStore`) |
| `import_lut`, `sample_project_materialize` | **N** |
| `storage_usage`, `storage_clear` | **H** (Route B cache root; the desktop commands exist but are not bridged) |
| `account_*`, `codex_*`, `chat_*`, `feedback`, `home_*`, `updater`, `secret_*`, `telemetry`, `haptic`, external MCP | **D** — product shell/agent surfaces outside this media bridge |

## 4. Preview, playback, and export orchestration

### 4.1 Paused/scrub preview (`composite_frame`)

`render.rs::composite_frame` is the authoritative single-frame path used by both
the timeline canvas and the source-media tab.

1. Validate the caller's `{projectEpoch, timelineVersion}` and the preview
   session/seek generations (`render.preview.begin/is_current`); a superseded
   request returns a "superseded" error instead of painting an old frame.
2. `authoritative_render_plan` / `try_build_render_plan` turns the timeline plus a
   `ManifestMetrics` projection (per-asset intrinsic sizes, straight-alpha flags,
   text boxes) into a `RenderPlan`; `RenderPlan::frame(timeline, frame)` yields
   the per-layer composition instructions for that frame.
3. `composite_rgba` uses the cached `RenderState` wgpu device/queue (Metal today)
   and a `Compositor` to draw the plan. The `MediaResolver` supplies each layer:
   - video: `opentake_media::decode::decode_frame_at` (ffmpeg CLI, seek/decode,
     rotation applied) through a bounded texture cache;
   - image: image thumbnail / decoded RGBA upload;
   - text: `CosmicTextRasterizer` (cosmic-text + swash) → premultiplied RGBA
     texture;
   - Lottie: `LottieMaterializer` → Velato composition rendered with Vello/wgpu,
     with a materialization error that fails the frame explicitly;
   - LUTs: `GpuLutTexture` uploaded and applied in the compositor;
   - nested sequences: projected recursively.
4. `encode_png_data_url` produces the PNG data URL returned to the WebView.
   Source-tab previews take the `source_media_id` branch (`decode_source_frame`)
   instead of compositing the timeline.

The addon's `compositeFrame` repeats this flow with its own `RenderDevice`,
`Compositor`, `CosmicTextRasterizer`, Velato state, and a `MediaEngine` rooted in
`<tmp>/opentake-route-b/cache`; it returns a PNG data URL. It has no revision
guard, no source-media branch, and no cancellation (the Host applies
newest-request-wins at the HTTP layer).

### 4.2 Playback (desktop Rust route)

`playback_start` snapshots the session and starts a dedicated render thread that
owns a wgpu device (textures are `Rc`, so single-thread affinity is required):

1. Choose a clock: cpal `AudioClock` when the timeline has audio (master clock),
   otherwise `InstantClock` (wall clock).
2. Per frame, read the clock, build the frame plan, and have
   `PlaybackResolver` advance one forward `VideoStream` per active clip to the
   target source frame (sequential ffmpeg decode rather than per-frame seeks).
3. Composite through the same `Compositor` and pixel path as preview.
4. JPEG-encode into `MjpegSink`; `PublicationGate` commits the exact
   `{projectEpoch, timelineVersion, sessionId, frame, sequence, terminal}`
   identity; the loopback axum server serves `/frame` (exact identity) and
   `/stream` (multipart JPEG); `/ws` is diagnostic. Pause closes the gate before
   audio control and discards in-flight frames.
5. `playback_frame` events drive the front-end playhead; transport control is
   identity-scoped. cpal callback liveness has a 150 ms wall-clock fallback, and
   seeks/cancellations are generation-checked through `PlaybackSlot`.

This is the hardest part to move behind N-API: it needs a long-lived thread,
audio-device access, a loopback HTTP server (or an equivalent event/callback
transport), and exact cancellation/identity semantics.

### 4.3 Export

`export.rs::export_video` snapshots the session and runs
`run_export_with_control` on the Tauri blocking pool:

1. Resolve the export preset/codec and full output resolution with
   `export_render_size` (preview cap is irrelevant); project text and media
   metadata; collect straight-alpha assets.
2. Build the whole-timeline `RenderPlan` and create a local `RenderDevice` +
   `Compositor` + `CosmicTextRasterizer`. Text-bearing exports fail closed when
   no font is available (unlike the lenient preview).
3. Open `opentake_media::VideoEncoder` (a long-lived ffmpeg child receiving raw
   RGBA on stdin and a private PCM spool), then for every frame:
   `plan.frame` → `compositor.render_to_rgba_with_interpolation` (video decode,
   image/Lottie/text/LUT materialization) → `encoder.push_frame`.
4. After the video loop, `stream_flattened_audio` decodes every audio-bearing
   `Audio`/`Video` clip in bounded windows, applies `volume_at` envelopes,
   optional denoise and nested-sequence offsets, sums/limits, and pushes PCM to
   the encoder; `finish` muxes video + AAC. ProRes 4444 uses a transparent clear
   so alpha survives.
5. Progress is a throttled `export://progress` event; cooperative cancel checks
   a shared `ExportControl`, aborts/kills the ffmpeg child, and removes the
   partial output. `save_range_as_media` reuses the pipeline for project media.

The addon implements a chunked equivalent: `exportBegin` creates the encoder and
audio buffer, `exportStep(n)` composites and encodes n frames per JS call,
`exportFinish` pushes audio and closes the encoder, `exportCancel` aborts. This
is the right shape for N-API (bounded blocking instead of one long call), but it
currently differs from desktop in two ways: audio collection only mixes
`ClipType::Audio` (video-clip audio is omitted), and denoise is not applied.
Those are milestone-M2 parity items.

## 5. What the N-API addon can own in-process, and what needs a bridge

### 5.1 Safe in-process (no extra runtime beyond the app)

- **Project/timeline/editing**: `opentake-core/domain/ops/project` are pure Rust
  (serde + filesystem) with no native runtime; `EditRequest` dispatch and
  undo/redo already work in the addon.
- **Media probe/decode/encode/thumbnails/waveforms/proxies**: all of
  `opentake-media` shells out to ffmpeg/ffprobe CLI processes; it does not link
  libav. A native addon can spawn these children exactly like the desktop shell,
  provided the platform package ships/locates ffmpeg and ffprobe.
- **Compositing/export**: `opentake-render` is wgpu + cosmic-text with no
  external service. GPU access from the Electron main process works on macOS
  (prototype verified), but the wgpu backend features are platform-specific
  (see §7) and GPU work should be chunked/threaded to avoid blocking Node.
- **Project bundle, library store, interchange export**: plain filesystem.
- **Synchronous frame composite / chunked export**: acceptable if each call is
  bounded (the existing chunked export pattern), otherwise move to an async
  N-API `AsyncTask`/worker.

### 5.2 Needs a helper/bridge (or feature-gated native embedding later)

| Capability | Why not the minimal addon | Recommended Route B shape |
|---|---|---|
| Real-time playback | Long-lived render thread, cpal audio device, loopback HTTP/event transport, exact cancellation identity; current addon has no cpal/axum | Host-owned playback service (Node HTTP + addon frame stepping) first; later an addon worker thread with `ThreadsafeFunction` frame events and a explicit audio path |
| Whisper transcription | `whisper-rs` compiles whisper.cpp (cmake/native C++); model download/network; CPU-heavy | Host/helper process or service exposing the `transcribe_*` contract; embed in addon only after per-platform CI proves the native build and model provisioning |
| SigLIP2 visual search + ORT matting | ONNX Runtime native libraries (`ort` feature, `download-binaries`/copy-dylibs) or Windows tract; model downloads | Host/helper service; keep the addon default build free of ORT |
| Motion (headless Chrome) | External Chrome/Chromium/Edge + CDP; per-frame screenshot latency; alpha/ProRes dependencies | Host-side process bridge (current plugin does this) or a dedicated helper process; do not make the core addon depend on Chromium |
| Provider generation | HTTPS + OS keychain + large downloads; desktop uses `opentake-gen`/`opentake-agent` | Host-side Node fetch/keychain (current) or a small helper; addon can expose only project-commit helpers |
| Motion/advanced workflows | Depend on agent tool layer, gen clients, ORT/Chromium | Bridge through the same capability service boundary; avoid duplicating tool semantics in the addon |
| File dialogs/shell, updater, account | Tauri/OS integration | Host/Electron native integration; addon stays headless |

### 5.3 Addon ABI/threading constraints

- N-API calls are synchronous unless declared async; a 30 fps composite or an
  export frame loop must not block Electron's main loop for long. Use chunked
  calls (export) or `AsyncTask`/`ThreadsafeFunction` (preview/playback/AI) and
  emit progress with `ThreadsafeFunction`, not `console.log` polling.
- wgpu device/queue and compositor textures are thread-affine (`Rc`, not
  `Send`); keep one GPU thread per engine or serialize access. Do not share the
  desktop's `RenderState`; the addon must own its device and drop it cleanly.
- ffmpeg children need lifecycle management (kill/wait on cancel, no orphaned
  processes); the media crate already has process-tree helpers, but the addon's
  current synchronous API relies on cooperative chunking.
- The addon currently writes caches under `std::env::temp_dir()/opentake-route-b`
  and holds no project cache identity; a production bridge needs per-project
  cache roots and identity keys (project epoch + media source identity), like
  `PLAYBACK-ENGINE.md` requires.
- `EditRequest` is duplicated from the Tauri command layer; extract a shared
  `opentake-ipc` crate before the command surface grows further.

## 6. Recommended Route B milestones

The requested ordering is correct, with one dependency clarification:
**media import/probe is a prerequisite for a real preview**, so it belongs to the
preview milestone rather than to a separate later phase. The first media
milestone should therefore be "media import + still/scrub preview", not preview
of an empty timeline.

### M0 — Project/timeline editing only (prerequisite; effectively done)

**Scope:** project lifecycle, timeline read/write, edit commands, undo/redo,
interchange export. No media, no GPU, no ffmpeg.

**Exact surface:**

- Commands: `project_new`, `project_open`, `project_save`, `get_timeline`,
  `edit_apply`, `undo`, `redo`, `can_undo`, `can_redo`, `export_xmeml`,
  `export_edl`, `export_otio`, `export_fcpxml`, `export_subtitles`.
- Addon: `newProject`, `newProjectAt`, `openProject`, `saveProject`,
  `getTimeline`, `apply`, `undo`, `redo`, `canUndo`, `canRedo`,
  `exportTimeline`, `exportSubtitles`.
- Crates/functions: `opentake-core::dto::{handle_project_new, handle_project_open,
  handle_project_save, handle_get_timeline}`, `AppCore::apply`,
  `opentake-ops::EditCommand`, `opentake-project` interchange, serde `EditRequest`
  mirror.

**Acceptance:** create/open/save a real `.opentake` bundle, apply an edit, undo/
redo, export XMEML/EDL/OTIO/FCPXML and SRT/VTT, with no native media runtime
loaded.

**Risks:** `EditRequest`/DTO drift; project path/dialog parity; no visual feedback
until M1.

### M1 — Media import/probe + preview composite (first media milestone)

**Scope:** import/probe/list/relink, poster/thumbnail/waveform caches, and the
paused/scrub `composite_frame` path for video/image/text/Lottie; source-media
preview; capture-frame-to-media.

**Exact surface:**

- Commands: `import_media`, `get_media`, `relink_media`, `generate_thumbnail`,
  `preview_poster`, `get_waveform`, `composite_frame`, `capture_frame_to_media`
  (plus `preload_media`/sprite requests where the UI needs them).
- Addon: `importMedia`, `mediaList`, `relinkMedia`, `thumbnail`, `waveform`,
  `compositeFrame`, `captureFrameToMedia` (extend with poster/sprites/preload).
- Crates/functions: `opentake_media::probe`, `MediaEngine::new`, `decode_frame_at`,
  `thumbnail`/poster cache, `waveform`; `opentake_render::try_build_render_plan`,
  `Compositor::render_to_rgba`, `CosmicTextRasterizer`, Velato materializer,
  `MediaResolver`; `opentake-core` import batch APIs.
- External runtime: ffmpeg + ffprobe CLI, wgpu GPU, system fonts, Velato/Vello.

**Acceptance:** import a project's media; render still frames that match the
desktop pixel path for at least: video frame, image, text overlay, and a Lottie
animation; waveform buckets and poster thumbnails match the desktop caches; a
missing ffmpeg degrades with a typed error rather than a crash.

**Risks:** N-API blocking per frame; GPU device creation in Electron; ffmpeg
discovery/packaging; font availability (Linux); Lottie/text parity; cache
identity; file permissions when users import from arbitrary folders.

### M2 — Export and real-time playback

**Scope:** full export (codecs, range, audio mixdown, progress/cancel, alpha) and
the playback route (continuous decode, audio clock, transport). This is where the
desktop architecture diverges most from the prototype.

**Exact surface:**

- Commands: `export_video`, `cancel_export`, `save_range_as_media`; playback
  `playback_start/pause/seek/stop`, `get_preview_endpoint` (or an equivalent
  addon callback contract), plus the transport endpoints.
- Addon: `exportBegin/exportStep/exportFinish/exportCancel/exportVideo`; add
  parity fixes: include video-clip audio in the mix, apply denoise/volume
  envelopes, honor the requested preset resolution, add `save_range_as_media`
  and exportAudio parity.
- Playback: either embed the Rust engine (addon worker thread + cpal + loopback
  `/frame`/`/stream` + `PublicationGate`, matching `PLAYBACK-ENGINE.md`) or use a
  Host-owned playback service driven by addon frame/audio calls. Do not ship the
  current wall-clock composite polling as "playback".
- Crates/functions: `opentake_media::VideoEncoder`, `opentake_render::
  Compositor::render_to_rgba_with_interpolation`, `try_build_render_plan`,
  `stream_flattened_audio`/`apply_export_denoise`; `playback::{PlaybackEngine,
  PlaybackResolver, AudioClock, InstantClock, MjpegSink, PreviewServer,
  PublicationGate, PlaybackIdentity}`.

**Acceptance:** H.264/H.265/ProRes 422/ProRes 4444 exports match desktop output
(duration, alpha, audio); range trim and cancel remove partial files; playback
advances with A/V sync, pause/seek/stop are identity-safe, and audio drives the
clock when present.

**Risks:** blocking/long-running N-API; ffmpeg child abort/cleanup; GPU/CPU
contention with preview; cpal device availability (headless CI); loopback
transport/CSP/Origin; memory bounds; export parity gaps listed above.

### M3 — AI: transcription, search, generation, motion, advanced workflows

**Scope:** bring the AI capability surface across, preferably through helper
services first and in-addon only when the native build story is proven.

**Exact surface:**

- Transcription: `transcribe_model_status`, `download_transcribe_model`,
  `transcribe_media`, `transcript_get`, `generate_captions`.
- Search: `search_model_status`, `download_search_model`, `search_index_status`,
  `search_index_start`, `search_query` (visual + spoken + files).
- Generation: `generation_cancel`, `generation_retry`, plus provider
  image/TTS/video tools and durable generation jobs.
- Motion: `motion_capability`, `motion_preview`, `motion_preview_cancel`,
  `motion_add`, `motion_edit`, `motion_cancel`, `motion_document_*`.
- Advanced: `matting_model_status`, `download_matting_model`,
  `advanced_track_motion`, `advanced_generate_matte`,
  `advanced_remove_object`, `advanced_match_color`,
  `advanced_translate_captions`, `advanced_apply_caption_translation_review`,
  `advanced_script_to_video`, `advanced_generate_avatar`,
  `advanced_clone_voice`, `cancel_advanced_workflow`.
- Crates/functions: `opentake_media::transcribe` + whisper model download,
  `opentake_media::search` + `OrtEmbedder`/embed store, `opentake-media::analysis`
  (RVM/matting/stems), `opentake-motion::HeadlessChromiumRenderer`,
  `opentake-gen` provider clients + keyring, `opentake-agent::mcp::{generation,
  advanced, motion}` bridges.

**Acceptance:** model status/download with checksum verification; one real
transcript and caption flow; text search without the model plus visual search
when installed; one provider image/TTS/video generation with durable job state;
one Motion preview/publish; one matte workflow. Every capability must report
unavailability explicitly (feature/model/provider missing) rather than silently
degrade.

**Risks:** whisper/ORT native builds and per-platform packaging; model download
size/checksum/network; provider keys/keychain; Chromium availability and
latency; GPU/CPU contention; ONNX model licensing/size; sandboxed Host
environment.

## 7. Platform build/runtime implications

| Concern | macOS | Windows | Linux |
|---|---|---|---|
| wgpu | `opentake-render` Cargo features currently `wgsl` + `metal` only — works today | Must add `dx12` (and likely `dxc`) to the wgpu feature set; D3D12 driver required | Must add `vulkan`/`gles`; headless CI needs a software/llvmpipe path or a GPU |
| ffmpeg/ffprobe | Desktop may bundle sidecars beside the executable; dev falls back to PATH/`OPENTAKE_FFMPEG`/`OPENTAKE_FFPROBE` | Package ffmpeg.exe/ffprobe.exe beside the app (the Route B package must carry them); PATH resolution differs | System ffmpeg or bundled; glibc/distro compatibility; AppImage/deb packaging |
| fonts / text | System fonts via cosmic-text; fine | System fonts; fine | `fontconfig` deliberately not linked; cosmic-text scans font dirs, minimal containers need fonts installed |
| Chromium (Motion) | Chrome path list + `OPENTAKE_CHROMIUM_PATH`; CDP works | Chrome/Edge paths (`chrome.exe`); CDP works | `google-chrome*`/`chromium` paths; headless sandbox flags needed |
| whisper.cpp | `whisper-rs` builds C++ via cmake; model ggml download | MSVC cmake build; model download | cmake/g++ build; model download |
| ONNX Runtime | `ort` non-Windows path downloads prebuilt ORT and copies dylibs; codesign/notarize those dylibs | Windows uses `ort-tract` (pure Rust, slower) to avoid Server-only ONNX Runtime dependencies; model still downloaded | Download prebuilt ORT/copy libs; rpath/LD_LIBRARY_PATH; checksum/verify |
| cpal audio | CoreAudio | WASAPI | ALSA; headless CI usually has no device → wall-clock fallback must exist |
| N-API/package | Per-platform `.node` (Mach-O), ad-hoc/linker-signed today; Developer ID + notarization for distribution | Per-platform PE `.node`; Authenticode; DLL dependency layout | Per-platform ELF `.node`; glibc floor; packaging policy TBD |
| GPU in Host process | Works in the prototype (Metal device in Electron main) | D3D12 device in Electron main/utility process untested; GPU sandbox assumed | Vulkan/llvmpipe; X/Wayland headless caveats |
| loopback transport | axum 127.0.0.1 random port works; Origin guard | Firewall prompts for loopback listeners possible | same; container networking |
| keychain / secrets | Keychain via `keyring` | Windows Credential Manager | Secret Service; headless CI unavailable |
| build footprint | Addon currently media/render only (~17 MB x64 observed) | ORT/whisper increases size significantly | same; distribution policies differ |

Route B packages are per-OS/arch tarballs containing the DSH plugin plus the
`.node` binary. The native binary is gitignored and must be built per platform;
signing/notarization of both the DSH distribution and the addon payload remains
an open packaging item.

## 8. Risks and open questions

1. **Addon/Tauri drift.** `EditRequest` and several DTOs are duplicated in
   `crates/opentake-node/src/edit_request.rs`; new Tauri commands must be
   mirrored manually. Extract a shared `opentake-ipc` crate before M2.
2. **N-API blocking and threading.** All addon methods are synchronous; long
   composites/exports block the Host. The chunked export API is the right
   pattern; preview/playback/AI need async tasks or worker threads.
3. **GPU ownership.** `opentake-render` currently has Metal-only wgpu features;
   Windows/Linux need feature work, adapter fallbacks and headless CI coverage.
4. **ffmpeg discovery/packaging.** Desktop pins packaged sidecars at startup
   (`resolve_media_tools` in `src-tauri/src/lib.rs`); the addon relies on the
   ambient ffmpeg path and hard-coded temp caches. Route B packaging must bundle
   or locate ffmpeg/ffprobe per platform and use project-scoped caches.
5. **Preview caches and identity.** The addon's `MediaEngine` cache is
   `<tmp>/opentake-route-b/cache`; it is not project/media-identity scoped like
   the desktop prewarm/cache (see `PLAYBACK-ENGINE.md`). Reusing a cache across
   projects/relinked media can serve stale posters/waveforms.
6. **Export parity.** Addon audio misses video-clip audio; denoise is absent;
   preset resolution handling differs; `save_range_as_media`, sprites, preload,
   extract-audio, save-clip-as-media, analysis/stems and LUT import are missing.
7. **Native AI features.** whisper/ORT/Chromium add substantial native build,
   packaging, signing and model-provisioning work. Keeping them out of the
   addon's default build (Host/helper services first) is the lowest-risk path.
8. **Playback semantics.** Wall-clock composite polling is not equivalent to the
   desktop playback engine; shipping it as playback would silently lose A/V sync,
   continuous decode and exact cancel/publication behavior.
9. **Cache/security.** ffmpeg processes, loopback servers and model downloads
   need the desktop's bounded admission, Origin guards, checksum verification
   and cleanup rules; the prototype has partial coverage.
10. **Platform coverage.** Only macOS arm64 is runtime-tested. macOS x64 is
    cross-built but unexecuted; Windows/Linux builds, GPU, ffmpeg, whisper/ORT,
    Chromium and cpal are unverified.

## 9. Source map

- Addon surface: `crates/opentake-node/src/lib.rs`, `src/edit_request.rs`,
  `test/smoke.mjs`; build script `scripts/build-route-b-addon.sh`.
- Host bridge: `plugins/opentake-studio-route-b/index.js`, `web/tauri-shim.js`,
  `README.md`; packaging `scripts/package-route-b.sh`.
- Commands: `src-tauri/src/lib.rs` (`generate_handler!`), `commands.rs`,
  `media.rs`, `render.rs`, `export.rs`, `playback/commands.rs`,
  `transcribe.rs`, `search.rs`, `generation.rs`, `motion.rs`,
  `motion_documents.rs`, `advanced.rs`, `captions.rs`, `library.rs`, `lut.rs`.
- Crates: `opentake-core/src/{core,session,dto}.rs`,
  `opentake-media/src/{lib,ff,encode,thumbnail,waveform,proxy,transcribe,search,
  analysis}` , `opentake-render/src/{lib,plan,gpu}`, `opentake-motion/src/
  renderer.rs`, `opentake-gen`, `opentake-agent`.
- Design context: `ARCHITECTURE.md` §1/§6, `PLAYBACK-ENGINE.md`,
  `EDITING-ENGINE-PLAN.md`, `MODULE-PORT-MAP.md` (Preview/Export/Generation/
  Search/Transcription).
