# Route B native playback slice

Status: isolated slice implemented + macOS arm64 verified, 2026-11-08, branch
`feat/dsh-rust-engine`. This document covers the new standalone crate
`crates/opentake-playback`, its probes/demos, and the exact addon/Host
integration points that remain. It intentionally does **not** modify
`crates/opentake-node/**`, `plugins/opentake-studio-route-b/index.js`, the root
`Cargo.toml`, or `docs/architecture/route-b.md`.

## 1. Why a separate crate

The desktop playback engine currently lives inside `src-tauri/src/playback*`:
`engine.rs` owns the GPU render loop and a `PlaybackClock`/`FrameSink` pair,
`audio.rs` owns the cpal master clock, `resolver.rs` keeps forward `VideoStream`
decoders per clip, `session.rs` guards identity/phase, and `transport.rs` owns
the MJPEG publication gate and loopback server. It pulls Tauri, wgpu, cpal, axum
and JPEG into one binary and cannot be reused by the N-API addon without moving
all of that.

`crates/opentake-playback` extracts the reusable **policy** — bounded decode
queue, clock abstraction, identity/generation guards, publication selection,
pause/seek/stop/cancel — behind `FrameSource`/`FrameSink` traits. It builds with
std only by default, has no GPU/ffmpeg dependency, and is a standalone Cargo
workspace (`[workspace]` in its manifest) so it does **not** require editing the
shared root `Cargo.toml`. The addon/Host adapters supply the real decoder,
compositor and transport.

There is no `crates/opentake-media/src/playback*` module today. The reusable
decode pieces are `opentake-media/src/decode/*` (`spawn_video_stream`,
`decode_frame_at`, `VideoStream`); the desktop playback loop is in
`src-tauri/src/playback/`. The slice's `FrameSource` is the seam where those two
meet.

## 2. Architecture

```text
             ┌─────────────────────────────┐
             │ PlaybackEngine              │
             │  identity + generation      │
             │  PlaybackState machine      │
             │  BoundedFrameQueue (cap N)  │
             │  PlaybackStats              │
             └───────┬─────────────┬───────┘
                     │ decode      │ tick(clock target)
                     ▼             ▼
              FrameSource       Clock (Audio / Wall / Manual)
                     │             │
                     ▼             ▼
              RgbaFrame       PublishedFrame ──► FrameSink
                                                    │
                                     Host addon: JPEG/PNG + events
```

Files:

| Path | Purpose |
|---|---|
| `crates/opentake-playback/src/identity.rs` | `PlaybackIdentity` (`projectEpoch`, `timelineVersion`, `sessionId`) and validation |
| `src/error.rs` | `PlaybackError` / `PlaybackErrorKind` (`Superseded`, `Cancelled`, `InvalidInput`, `Engine`) |
| `src/queue.rs` | `BoundedFrameQueue`, `QueuedFrame`, `PushOutcome` |
| `src/frame.rs` | `RgbaFrame`, `PublishedFrame`, `FrameSource`, `FrameSink` |
| `src/clock.rs` | `Clock` trait, `AudioClock`, `WallClock`, `ManualClock`, sample↔frame conversion |
| `src/engine.rs` | `PlaybackConfig`, `PlaybackState`, `PlaybackStats`, `PlaybackEngine` |
| `src/cancel.rs` | shared `CancelToken` |
| `src/synthetic.rs` | deterministic `SyntheticSource` / `RecordingSink` for tests/demos |
| `src/cpal_output.rs` | optional `cpal-output` feature: silent cpal output that advances `AudioClock` |
| `tests/engine.rs` | 17 deterministic lifecycle/queue/clock tests |
| `tests/cpal_output.rs` | cpal visibility test + ignored hardware-clock probe |
| `examples/cadence_demo.rs` | runnable 300-frame cadence proof (manual clock) |
| `examples/streaming_demo.rs` | wall-clock streaming proof |
| `scripts/route-b/playback/{probe,benchmark}.sh` | probe and smoke benchmark |

## 3. Lifecycle and commands

`PlaybackEngine::new(identity, config, source, clock, sink)` validates the range
against `source.frame_count()`, rebases the clock to `start_frame`, and starts in
`Playing`.

| Method | Valid states | Effect |
|---|---|---|
| `fill(max_steps)` | Playing/Paused | Decode forward into the bounded queue until capacity/end; returns frames decoded. Never blocks on publication; stops at capacity (backpressure). |
| `fill_to_capacity()` | Playing/Paused | `fill(usize::MAX)`. |
| `tick()` | Playing only | Reads the clock target, clamps to `[start, end)`, drains queued frames up to that target, publishes the newest, and returns it. Returns `None` when paused/stopped/starving/duplicate. |
| `step(decode_budget)` | Playing/Paused | `fill` + `tick` convenience for Host loops. |
| `pause(identity)` | Playing/Paused | Rebase the clock at the last published frame (or current target), close publication. Idempotent while paused. |
| `resume(identity)` | Playing/Paused | Reopen publication; clock continues from its rebased position. Idempotent while playing. |
| `seek(identity, frame)` | Playing/Paused | Validate frame in range; flush queue; increment `generation`; reset `sequence` to 0; set decode cursor and clock to the frame. Play/pause state is preserved. |
| `stop(identity)` | any non-stopped | Cancel outstanding work, flush queue, increment generation, transition to `Stopped`. Idempotent for the same identity. |
| `cancel()` | teardown | Stop without an identity (route/engine drop). |

A terminal publication (`frame == end_frame - 1`) transitions the engine to
`Stopped` and clears the queue. Subsequent `tick` calls return `None`; all
control calls on a stopped session return `Superseded`.

State machine:

```text
new() ──► Playing ──pause()──► Paused
             │  ◄──resume()──   │
             │                  │
             ├── seek() ────────┤
             │                  │
             └──── stop()/terminal frame ───► Stopped
```

## 4. Bounded queue and backpressure

- Capacity is fixed at construction and must be > 0.
- `fill` decodes sequentially from `decode_cursor` and stops at capacity or
  `end_frame`; it never grows without bound and never blocks publication.
- `tick` drains every queued frame at/before the clock target, publishes only the
  newest, and counts the rest as `stats.dropped`. Frames after the target remain
  queued for subsequent ticks.
- Frames carry the session `generation`; queued frames from an older generation
  are discarded before they can publish. This makes a seek/replace safe even if
  a slow decode finishes late.
- A capacity smaller than the clock jump produces a transient one-frame lag
  rather than unbounded memory or out-of-order frames; callers should size the
  queue for jitter (the desktop resolver uses a similar bounded forward queue).
- `PlaybackStats` exposes `decoded`, `published`, `dropped`, `queue_peak`,
  `seeks` for Host status/diagnostics.

## 5. Clocks

All clocks implement `Clock { frame(), reset(frame), kind() }`.

- **AudioClock (master):** wraps `Arc<AtomicU64>` output-sample frames plus the
  device sample rate and project fps.
  - `frame_for_sample(pos, rate, fps) = floor(pos / rate * fps)`
  - `samples_for_frame(frame, rate, fps) = round(frame / fps * rate)`
  - `reset(frame)` stores the rounded sample position; this makes a seek round
    trip back to the same frame even at 44.1 kHz / 24 fps.
  - The cpal callback increments the atomic by the number of output frames it
    rendered; the render/publication side only reads it. `AudioClock` is
    `Send + Sync`; the `!Send` cpal `Stream` lives on the audio thread owner.
- **WallClock:** elapsed time from a reset origin; the fallback when the surface
  has no audio output (silent timeline, headless CI, muted device).
- **ManualClock:** explicit `set_frame`; used by every deterministic test and
  the cadence demo.

The production cpal output must also mix the timeline audio in the callback
(existing desktop `playback/audio.rs`). This slice's `CpalOutput` renders silence
but proves the callback/clock contract; **timeline audio mixing over cpal is not
verified by this slice**.

## 6. Publication model

`PublishedFrame` carries:

- `identity` — exact `PlaybackIdentity` of the session;
- `generation` — increments on every seek (and stop); queued old-generation
  frames can never publish;
- `sequence` — monotonic publication counter, resets to 1 on seek;
- `frame` — timeline frame;
- `terminal` — true for the final frame;
- `image` — RGBA pixels.

Rules enforced by the engine and exercised by tests:

1. Publication only while `Playing`; paused frames stay queued but invisible.
2. Publications are monotonic per generation: a target at/below the last
   published frame does not republish or rewind. A backward move requires `seek`.
3. Duplicate ticks at the same target return `None`.
4. Terminal publication stops the session and is emitted exactly once.
5. A stale identity cannot control the session (`Superseded`), so a replaced
   project/timeline can never be moved by a late `pause`/`seek`/`stop`.

## 7. Threading model

The crate core is single-threaded (`&mut self`), which makes lifecycle rules
deterministic and testable. The production split is:

```text
audio thread (cpal Stream, !Send)
  callback: render/mix audio; position.fetch_add(frames)
  clock = AudioClock(position, rate, fps)  ──shared──┐
                                                    │
decoder/render thread                               │
  loop: fill(queue) ──► tick(clock) ──► publish     │
        │                    │                      │
        └── FrameSource ─────┘                      │
                               FrameSink ──► Host transport / N-API callback
```

- Keep one GPU/decoder owner thread: the desktop `RenderLoop` documents that
  wgpu textures are `Rc` and the device/queue are thread-affine.
- Do not call `PlaybackEngine` from the cpal callback if decode/composite can
  block; the callback should only read the clock (and later mix PCM). The
  decoder thread owns the engine and publishes via a sink/channel.
- For the N-API addon, expose bounded blocking calls (`playbackBegin`,
  `playbackStep`) and/or a worker thread that emits frames through a
  `ThreadsafeFunction`. Never run the whole loop on the Electron main thread.
- Pause must close publication before stopping/resetting audio; resume must
  restore the exact retained session. This slice's pause rebase and generation
  checks are the policy the addon should keep when it adds the real audio path.
- Queue capacity should match the decode/render budget (desktop uses bounded
  queues and drops stale frames to keep A/V sync).

## 8. Error model

| Kind | When | Host/addon response |
|---|---|---|
| `Superseded` | stale identity, stopped session, terminal control | Drop the late command/event; re-read timeline identity; never retry against the new session |
| `Cancelled` | cancellation observed during decode/fill | Treat as normal teardown; discard partial work |
| `InvalidInput` | bad config, frame range, seek target, identity string, RGBA buffer | Reject the command with a 400-style error; do not start a session |
| `Engine` | frame source decode failure or cpal/output failure | Surface a typed engine error; do not silently publish black frames |

`PlaybackError` implements `Display`/`Error` and keeps `kind`/`message` fields
for JSON mapping.

## 9. Verification (macOS arm64)

Environment: macOS arm64 (`uname -srm`), Rust 1.99.1. The default build has no
native deps. The cpal feature required a one-time crates.io fetch of cpal's
native build dependencies (bindgen); after that the feature tests run offline.

Commands and observed output:

```text
$ cargo test --offline --manifest-path crates/opentake-playback/Cargo.toml
running 17 tests ... 17 passed; 0 failed; 0 ignored

$ cargo test --features cpal-output --manifest-path crates/opentake-playback/Cargo.toml
tests/engine.rs: 17 passed
tests/cpal_output.rs: 1 passed; 1 ignored
  # reports_default_output_visibility_without_failing_headless ... ok

$ cargo test --features cpal-output --test cpal_output -- --ignored --nocapture
cpal clock advanced 0 -> 8704 samples at 48000 Hz (a second probe observed 9216)
test cpal_output_advances_the_audio_clock ... ok

$ cargo run --offline --example cadence_demo -- 300 8 30
summary: frames=300 published=300 decoded=300 dropped=0 queue_peak=8 seeks=0 decode_calls=300 state=Stopped
cadence: OK

$ cargo run --offline --example streaming_demo -- 60
elapsed=1.971s frames=60 published=60 decoded=60 dropped=0 terminal_frame=59
streaming: OK

$ scripts/route-b/playback/benchmark.sh 1000 8
elapsed=0.253s frames=1000 per_frame=252.6us (includes cargo startup)
benchmark: OK
```

Hardware status:

- **cpal output device callback verified** on this macOS arm64 machine: the
  ignored probe observed the master clock advance `0 -> 9216` samples at 48 kHz.
  This verifies device open/start and callback liveness.
- **Timeline audio mixing through cpal is not implemented in this slice** (the
  callback writes silence). Treat audible playback and real A/V sync as
  unverified until the addon adapter decodes/mixes PCM into that callback.
- Windows/Linux cpal, GPU-backed frame sources, and MJPEG transport are
  unverified; only the deterministic policy and macOS cpal clock are proven here.

Probe/benchmark scripts:

```bash
scripts/route-b/playback/probe.sh
scripts/route-b/playback/benchmark.sh 1000 8
```

`probe.sh` runs the default tests, the cpal-feature tests, the optional hardware
probe (non-fatal), and both demos. Headless CI can report the hardware probe as
unavailable without failing the rest.

## 10. Exact addon integration points (future edit; not done here)

The addon is constrained by this task and was **not** edited. The following is
the intended N-API surface; it mirrors the existing chunked `exportBegin/
exportStep/exportFinish` pattern in `crates/opentake-node/src/lib.rs`.

Add to `Engine` (names illustrative N-API camelCase):

| Addon method | Suggested engine call | Returns |
|---|---|---|
| `playbackBegin(requestJson)` | Parse `{fromFrame?, endFrame?, queueCapacity?}`; snapshot `getTimeline()` for `projectEpoch`/`version`; `PlaybackIdentity::new(epoch, version, sessionId)`; `PlaybackConfig::new(fps, start, end, cap)`; construct `PlaybackEngine` with a `FrameSource` adapter and recording/JPEG sink; retain in a new `RefCell<Option<PlaybackSession>>` next to the existing `ExportSession`. | `{identity:{projectEpoch,timelineVersion,sessionId}, fps, startFrame, endFrame, queueCapacity, state}` |
| `playbackStep(maxFrames)` | `engine.fill_to_capacity()` then `engine.tick()`; store latest `PublishedFrame` image; return metadata and, if the Host polls frames, a PNG/data URL or JPEG bytes. | `{published: bool, frame, generation, sequence, terminal, state, stats:{decoded,published,dropped,queuePeak,seeks}}` |
| `playbackPause(identityJson)` | `engine.pause(&identity)` | `{state:"paused"}` |
| `playbackResume(identityJson)` | `engine.resume(&identity)` | `{state:"playing"}` |
| `playbackSeek(identityJson, frame)` | `engine.seek(&identity, frame)` | `{state, generation}` |
| `playbackStop(identityJson)` | `engine.stop(&identity)`; drop the session; cancel audio | `{state:"stopped"}` |
| `playbackStatus(identityJson)` | Read state/stats/last published metadata | status JSON |
| `playbackAudioWav()` | Reuse existing `audioMixWav` (mixed mono WAV) until cpal audio rendering lands | WAV path |

Integration details:

- **Identity source:** `get_timeline()` (`TimelineSnapshotDto`) provides
  `projectEpoch`, `version`, and the timeline; validate the identity exactly like
  `src-tauri/src/playback/session.rs::PlaybackIdentity`.
- **FrameSource adapter:** implement `FrameSource` by wrapping
  `composite_frame_decoded(core, frame, render_size, transparent=false)` (already
  used by `composite_frame`/`export_step`), or for a faster slice reuse
  `opentake_media::decode::spawn_video_stream` for a one-track project. Do not
  re-composite the whole timeline per frame once the forward decoder path is
  ready.
- **FrameSink adapter:** either (a) record the latest frame and let the Host
  poll `playbackStep` + an addon `playbackFrame` PNG/JPEG method, or (b) emit
  via `ThreadsafeFunction` from a worker thread. The addon's synchronous calls
  must stay bounded; never block the Electron main loop for a whole session.
- **Clock:** if the addon owns the audio device, add `cpal` behind a feature and
  own the `CpalOutput`/`AudioClock` on an audio thread; the engine reads the
  clock. If cpal remains Host/helper-owned, the Host must call
  `playbackSync(samplePosition)` or provide a `Clock` implementation to the
  engine; the current Host wall clock alone is not a master clock.
- **Audio output:** until PCM mixing lands, reuse `audioMixWav` and the Host
  `<audio>` element for sound; mark it as a fallback, not the native path.
- **Error mapping:** map `PlaybackErrorKind::{Superseded,Cancelled,InvalidInput,
  Engine}` to typed N-API errors/JSON codes. `Superseded` must never be retried
  against a replacement session.
- **Cancellation:** propagate `CancelToken` into decoder/compositor calls;
  `stop` must abort the decode loop and drop queued frames.

## 11. Exact Host integration points (future edit; not done here)

`plugins/opentake-studio-route-b/index.js` currently emulates playback:

- `state.playback` is a wall-clock job created in `playback_start`, mutated by
  `playback_pause/seek/stop`, and polled by `playbackStatus()` (lines ~220-260
  and ~832-865).
- `/engine/playback/status` serves that status; `/engine/playback/sync` accepts
  an audio-element frame; `/engine/playback/audio` serves `audioMixWav`;
  `/engine/preview/frame` calls `compositeFrame(frame, 1280)` per request.
- `/engine/invoke` maps the Tauri `playback_*` commands.

Replacement plan:

1. On `playback_start`, call addon `playbackBegin({fromFrame, endFrame:
   timeline.totalFrames})`; store the returned identity exactly. Do not create a
   wall-clock `startedAt`.
2. Drive `playbackStep(N)` from a Host timer paced at the project fps (or a
   small worker), not from per-request `compositeFrame`. Serve the published
   frame via `/engine/preview/frame` (keep the route for the React UI) and emit
   the `playback_frame` event with identity/generation/sequence/terminal.
3. `pause`/`seek`/`stop` must call the matching addon method with the stored
   identity; ignore `Superseded` responses instead of mutating the old job.
4. Keep `/engine/playback/audio` for the existing WAV fallback; when addon cpal
   mixing is ready, either remove the `<audio>` element clock or use its
   `currentTime` only as a diagnostic. Do not let the audio element override a
   native audio clock.
5. `/engine/playback/status` should report addon engine status/stats, not a
   computed wall-clock frame.

## 12. Desktop reference mapping

| Slice concept | Desktop reference (`src-tauri/src/playback/`) |
|---|---|
| identity/session guards | `session.rs` (`PlaybackIdentity`, `PlaybackCommandError`, `SessionRegistry`) |
| `Clock` / `AudioClock` | `engine.rs::PlaybackClock`, `audio.rs::AudioClock`, `audio.rs::try_build_clock` |
| `FrameSink`/publication gate | `engine.rs::FrameSink`, `transport.rs::MjpegSink`, `EncodedFramePublication`, `PublicationGate` |
| bounded forward decode | `resolver.rs::PlaybackResolverState` / `StreamingResolver`; `opentake_media::decode::spawn_video_stream` |
| render loop / seek/pause/stop | `engine.rs::PlaybackEngine` + `PlaybackCmd`; `commands.rs` |
| frame transport | `transport.rs` `/frame`, `/stream`, `/ws`; `get_preview_endpoint` |

The desktop versions remain authoritative for GPU/MJPEG/audio details; the
slice is the extracted, testable policy that the addon can adopt without
copying `src-tauri`.

## 13. Remaining integration work

1. Add the N-API playback methods/state (chunked `begin/step/pause/resume/seek/stop/status`,
   latest-frame PNG/JPEG access) without regressing existing media/export calls.
2. Bind `FrameSource` to the real compositor/decode path and `FrameSink` to the
   Host transport; keep decode bounded and off the Node main thread.
3. Implement cpal audio rendering/mixing (not just silence) and A/V clock
   handoff; decide whether cpal lives in the addon, a worker thread, or a
   helper process.
4. Wire Host `playback_*` handlers, `/engine/playback/status`, frame events and
   terminal handling; delete the wall-clock fallback once verified.
5. Add identity-transition integration tests (project switch, timeline edit
   during playback, late frame images) and macOS/Windows/Linux cpal/transport
   probes.
6. Package/sign the new native dependencies (cpal per OS; ffmpeg/GPU as before).

## 14. Constraints honored

- No edits to `crates/opentake-node/**`, `plugins/opentake-studio-route-b/index.js`,
  root `Cargo.toml`, or `docs/architecture/route-b.md`.
- No dependencies added to shared crates; the new crate is standalone.
- Only new files under `crates/opentake-playback/**`,
  `scripts/route-b/playback/**`, and this document.
