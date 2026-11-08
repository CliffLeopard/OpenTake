# Route B — Tauri `EditRequest` → core `EditCommand` map & N-API extraction plan

> Status: investigation (read-only source) · Branch: `feat/dsh-rust-engine` @ `5caeb7d` (2026-11-08)
> Scope: `src-tauri/src/commands.rs`, `crates/opentake-ops/src/command.rs`, `crates/opentake-core/src/{core,dto}.rs`,
> `crates/opentake-node/src/{lib,edit_request}.rs`, `web/src/**`.
> Only this document was written; no Rust/JS source was modified.
> Companion Route B docs: [route-b.md](route-b.md) (decision/migration plan),
> [route-b-media-map.md](route-b-media-map.md) (media/render/export boundary),
> [route-b-ui-integration.md](route-b-ui-integration.md) (React UI in DSH).

---

## 1. Executive summary

1. The edit surface is already split cleanly: **`EditRequest` is a serde mirror of `EditCommand`**, and the
   only production conversions are `EditRequest::into_command()` + 20 small wire-DTO → engine-value helpers.
   `opentake-ops::apply` is in-memory only (no fs/network/Tauri); `opentake-ops` depends solely on
   `opentake-domain`.
2. There are **56 `EditRequest` variants** (matching the 56-member TypeScript union in
   `web/src/lib/types.ts`) and **75 `EditCommand` variants**. 54 map 1:1 by name; one is renamed
   (`createNestedSequence` → `CreateNestedSequenceFromClips`); one is special-cased in the Tauri wrapper
   (`freezeFrame`, which must capture a still before dispatching `RegisterMediaAndFreezeFrame`).
3. The `EditRequest` block already exists **twice**: 1,007 raw lines in `src-tauri/src/commands.rs`
   (lines 1350–2356) and a 1,028-line verbatim copy in `crates/opentake-node/src/edit_request.rs`.
   Normalized comparison of the two bodies is **identical (947/947 lines, 0 diff)**. This is the main
   maintenance risk and the strongest argument for extraction.
4. **Recommendation:** create `crates/opentake-ipc` (request-wire crate) that depends only on
   `opentake-domain`, `opentake-ops` and `serde`. Move the `EditRequest`/DTO/`into_command` block there;
   both `src-tauri` and `opentake-node` import it. No feature flags are needed (pure serde). Response
   DTOs (`EditResultDto`, `TimelineSnapshotDto`, `CmdError`) can stay in `opentake-core::dto`.
5. N-API already exposes `Engine.apply(json)` (38 `#[napi]` annotations: `Engine` class + constructor + 36 methods). The residual gaps for
   Tauri-parity are: revision-bound apply, event subscription (`timeline_changed` …), freeze-frame
   routing, structured error codes, and ID-generator parity. These are host-adaptation gaps, not
   request-conversion gaps.

---

## 2. Current data flow

### 2.1 Tauri desktop path

```
web/src/store/editActions.ts  (builds EditRequest objects)
  → web/src/lib/api.ts editApply(command, expected{projectEpoch,timelineVersion,projectPath})
  → invoke("edit_apply", { command, expectedProjectEpoch, expectedTimelineVersion, expectedProjectPath })
  → src-tauri/src/commands.rs::edit_apply
      - updater admission gate (begin_mutating_activity)
      - EditRequest::FreezeFrame? → validate + render::capture_freeze_frame → RegisterMediaAndFreezeFrame
      - otherwise EditRequest::into_command()
  → opentake_core::dto::handle_edit_apply_at_project_revision
  → AppCore::apply_at_project_revision (lock, epoch/version/path check)
  → opentake_ops::command::apply(state, command, ids)
      snapshot → mutate → commit-if-changed → version++  (EditorState: timeline + manifest + undo stack)
  → EditResult → EditResultDto  (Tauri returns the DTO; UI re-fetches the snapshot)
  → after lock release: CoreEvent::{TimelineChanged,MediaChanged,ProjectSaved} → Tauri bridge
  → Tauri events: timeline_changed / project_opened / project_saved / media_changed
  → web/src/store/sync.ts refreshes get_timeline at the event's version floor
```

### 2.2 N-API (Route B) path today

```
DSH Host (Node) → Engine.apply(commandJson)
  → serde_json::from_str::<EditRequest>          (crates/opentake-node/src/edit_request.rs — local copy)
  → EditRequest::into_command()
  → AppCore::apply(command)                      (no expected epoch/version/path)
  → JSON { result: EditResultDto, timeline: TimelineSnapshotDto }
```

`Engine` (`crates/opentake-node/src/lib.rs`) owns `AppCore`, an `ExportSession`, and a `LibraryStore`;
it already bridges 38 methods (project lifecycle, get_timeline, composite, export, media import/probe,
relink, proxies, library, thumbnails, waveform, audio mix/export). Request conversion is the only
duplicated piece.

### 2.3 Source-of-truth files

| File | Lines | Role |
|---|---|---|
| `web/src/lib/types.ts` | 1,700+ | TS `EditRequest` discriminated union (56 tags) + wire DTO types |
| `web/src/lib/api.ts` | 2,600+ | 148 exported async IPC wrappers; `edit_apply` adds the revision identity |
| `src-tauri/src/commands.rs` | 4,718 | Tauri commands; `EditRequest` + wire DTOs at lines **1350–2356** |
| `crates/opentake-ops/src/command.rs` | 8,917 | `EditCommand` (75 variants) + `apply` transaction model |
| `crates/opentake-core/src/core.rs` | 2,000+ | `AppCore`: lock, undo, revision checks, `CoreEvent` bus |
| `crates/opentake-core/src/dto.rs` | 383 | `EditResultDto`, `TimelineSnapshotDto`, `CmdError`, `handle_*` shims |
| `crates/opentake-node/src/edit_request.rs` | 1,028 | **duplicate** of the Tauri request block |

---

## 3. Complete `EditRequest` → `EditCommand` map

`EditRequest` is `#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]`; every arm also
uses `rename_all = "camelCase"` for fields. `into_command(self) -> Result<EditCommand, String>` is pure.
All 56 request tags appear in `web/src` (the TS union in `lib/types.ts` plus builders in
`store/editActions.ts`, several also in the browser fallback); none is dead.

### 3.1 Nested sequences (4)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `createNestedSequence` | `CreateNestedSequenceFromClips { name, clip_ids }` | only renamed mapping; the request never carries a prebuilt child `Timeline` |
| `editNestedSequence` | `EditNestedSequence { sequence_id, command: Box<EditCommand> }` | recursively `into_command()` the nested request |
| `renameNestedSequence` | `RenameNestedSequence` | 1:1 |
| `dissolveNestedSequence` | `DissolveNestedSequence` | 1:1 |

### 3.2 Timeline placement / clip creation (7)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `placeMedia` | `PlaceMedia { sequence_id, settings, target, entry }` | `ProjectTimelineSettingsDto`→`ProjectTimelineSettings`; `PlaceMediaTargetDto` (`kind:` tag) → `PlaceMediaTarget` (`newTrack.trackType`→`kind`); `UnplacedClipEntryDto`→`UnplacedClipEntry` |
| `addClips` | `AddClips { entries }` | `Vec<ClipEntryDto>`→`Vec<ClipEntry>` |
| `insertClips` | `InsertClips { track_index, at_frame, entries }` | same entry conversion |
| `pasteClips` | `PasteClips { entries }` | `PasteClipEntryDto` embeds a **whole `Clip`** (domain serde) + `targetTrackId`/`startFrame` |
| `addTexts` | `AddTexts { entries }` | `TextEntryDto`→`TextEntry` (`TextStyle`/`Transform` are domain serde types) |
| `addTextsAutoTrack` | `AddTextsAutoTrack { entries }` | `TextAutoTrackEntryDto` (no `trackIndex`) |
| `addCaptions` | `AddCaptions { entries }` | `CaptionEntryDto`→`CaptionEntry` (carries `captionGroupId`) |

### 3.3 Clip edits (10)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `moveClips` | `MoveClips { moves }` | `ClipMoveDto`→`ClipMove` (`toTrack`/`toFrame`) |
| `duplicateClips` | `DuplicateClips` | 1:1 |
| `moveOrDuplicateClipsToNewTrack` | `MoveOrDuplicateClipsToNewTrack` | `NewTrackClipModeDto` (`move`/`duplicate`) → `NewTrackClipMode` |
| `removeClips` | `RemoveClips` | 1:1 |
| `splitClip` | `SplitClip` | 1:1 |
| `splitClips` | `SplitClips` | 1:1 |
| `trimClips` | `TrimClips { edits }` | `TrimEditDto`→`TrimEdit` **tuple** `(clip_id, trim_start, trim_end)` |
| `rippleDeleteRanges` | `RippleDeleteRanges` | `FrameRangeDto`→`FrameRange::new` |
| `rippleDeleteClips` | `RippleDeleteClips` | 1:1 |
| `swapClips` | `SwapClips { a, b }` | request fields `clipA`/`clipB` renamed to `a`/`b` |

### 3.4 Properties, keyframes, effects, grade, masks, audio, transitions (20)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `setClipProperties` | `SetClipProperties { properties: Box<ClipProperties> }` | `ClipPropertiesDto` has 18 optional fields; boxed on both sides (enum-size / undo-clone cost) |
| `setTransformAtFrame` | `SetTransformAtFrame` | `Transform` is a domain serde type |
| `setKeyframes` | `SetKeyframes { property, payload }` | `KeyframePropertyDto`→`KeyframeProperty`; `KeyframePayloadDto` (`kind: scalar/pair/crop`) → `KeyframePayload(Scalar/Pair/Crop(KeyframeTrack))`; each kf maps `interpolationOut?` → `Keyframe::with_interpolation` / `Keyframe::new` |
| `stampKeyframe` | `StampKeyframe` | uses the clip's sampled value |
| `upsertKeyframe` | `UpsertKeyframe { value }` | `KeyframeValueDto` (`kind`) → `KeyframeValue` (one value, not a whole track) |
| `removeKeyframe` | `RemoveKeyframe` | 1:1 |
| `moveKeyframe` | `MoveKeyframe` | 1:1 |
| `setKeyframeInterpolation` | `SetKeyframeInterpolation` | `Interpolation` domain serde |
| `setColorGrade` | `SetColorGrade { grade: Option<ColorGrade> }` | null clears |
| `setLut` | `SetLut { lut: Option<LutReference> }` | null clears |
| `setChromaKey` | `SetChromaKey { chroma_key: Option<ChromaKey> }` | null clears |
| `setMasks` | `SetMasks { masks: Vec<Mask> }` | empty clears |
| `setEffects` | `SetEffects { effects: Vec<Effect> }` | empty clears |
| `setLoudnessNormalization` | `SetLoudnessNormalization` | `Option` |
| `setAudioDenoise` | `SetAudioDenoise` | `Option` |
| `applyStabilization` | `ApplyStabilization { solution }` | `StabilizationTrack` domain serde |
| `adjustStabilization` | `AdjustStabilization` | `strength?` / `cropMargin?` |
| `resetStabilization` | `ResetStabilization` | 1:1 |
| `setTransition` | `SetTransition` | `kind?: TransitionKind|null`, `durationFrames` |
| `resetTransform` | `ResetTransform { clip_ids }` | 1:1 |

### 3.5 Tracks, links, project settings (7)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `link` | `Link` | 1:1 |
| `unlink` | `Unlink` | 1:1 |
| `removeTracks` | `RemoveTracks` | 1:1 |
| `swapTracks` | `SwapTracks` | 1:1 |
| `insertTrack` | `InsertTrack { kind, at }` | `ClipType` domain serde |
| `setTrackProps` | `SetTrackProps` | `syncLocked` → `sync_locked` |
| `setTimelineSettings` | `SetTimelineSettings` | 1:1 |

### 3.6 Media library (7)

| Request tag | `EditCommand` | Conversion notes |
|---|---|---|
| `createFolder` | `CreateFolder` | 1:1 |
| `moveToFolder` | `MoveToFolder` | `folderId` null = root |
| `renameMedia` | `RenameMedia { entries }` | `RenameEntryDto`→`RenameEntry` |
| `renameFolder` | `RenameFolder { entries }` | same DTO |
| `deleteMedia` | `DeleteMedia` | cascades clip removal in ops |
| `deleteFolder` | `DeleteFolder` | recursive in ops |
| `swapMedia` | `SwapMedia { clip_id, media_ref }` | in-place media replacement, type-must-match |

### 3.7 Special case (1)

| Request tag | Handling |
|---|---|
| `freezeFrame` | **Not** mapped in `into_command` (returns `Err("freezeFrame must be handled by edit_apply")`). The Tauri wrapper validates the clip/frame first, captures a still via `render::capture_freeze_frame` (GPU/ffmpeg render state), then dispatches `EditCommand::RegisterMediaAndFreezeFrame { media, clip_id, at_frame, duration_frames }`. On a rejected edit it deletes the captured file. This requires host render/media state and cannot be pure request conversion. |

### 3.8 `EditCommand` variants not reachable from `EditRequest` (18 + Undo/Redo)

These are internal/composite commands (the rest of the 75):

`CreateNestedSequence` (prebuilt child timeline), `SetNestedSequenceTimeline`, `AddClipsAutoTrack`,
`AddClipsToSeparateAutoTracks`, `RegisterMediaAndAddClip`, `RegisterMediaAndSwapClip`,
`RegisterMediaAndSwapClipClearingMasks`, `RegisterMediaAndFreezeFrame`, `FreezeFrame` (command form with a
pre-registered `media_ref`), `SetClipPropertiesPerClip`, `ApplyColorMatch`,
`ApplyCaptionTranslations`, `SaveScriptAssemblyPlan`, `ApplyScriptAssemblyPlan`, `SaveVoiceModel`,
`RevokeVoiceModel`, `CreateFolders`, `MoveToFolders`.
Plus `Undo`/`Redo`, which are invoked through dedicated Tauri commands (`undo`/`redo`), not `edit_apply`.

They are produced by agent/MCP dispatch, transcription/translation, export/capture and batch
automation. They are **not** required by the existing React editing UI, but some are required for
agent parity and must stay available on the Rust side.

---

## 4. Wire DTO → engine value conversions (`commands.rs` block)

20 local serde DTOs convert into `opentake-ops`/`opentake-domain` types. Summary of the non-obvious ones:

| DTO | Engine value | Notes |
|---|---|---|
| `ProjectTimelineSettingsDto` | `ProjectTimelineSettings` | 1:1 |
| `PlaceMediaTargetDto` | `PlaceMediaTarget` | `kind` enum; `trackType`→`kind` |
| `UnplacedClipEntryDto` / `ClipEntryDto` | `UnplacedClipEntry` / `ClipEntry` | same 10 fields; `track_index` only on placed entries |
| `NewTrackClipModeDto` | `NewTrackClipMode` | `move`/`duplicate` |
| `PasteClipEntryDto` | `PasteClipEntry` | full `Clip` snapshot |
| `ClipMoveDto` | `ClipMove` | 1:1 |
| `TrimEditDto` | `TrimEdit` (tuple) | `(clip_id, trim_start_frame, trim_end_frame)` |
| `FrameRangeDto` | `FrameRange` | `FrameRange::new(start,end)` |
| `ClipPropertiesDto` | `ClipProperties` | 18 optional fields; `None` = leave unchanged |
| `TextEntryDto` / `TextAutoTrackEntryDto` | `TextEntry` / `TextAutoTrackEntry` | `content`+`textStyle`+`transform` |
| `CaptionEntryDto` | `CaptionEntry` | adds `captionGroupId` |
| `RenameEntryDto` | `RenameEntry` | `id`+`name` |
| `KeyframePropertyDto` | `KeyframeProperty` | opacity/volume/rotation/position/scale/crop |
| `ScalarKfDto`/`PairKfDto`/`CropKfDto` | `Keyframe<f64>` / `AnimPair` / `Crop` tracks | `interpolationOut?` default preserves `Keyframe::new` |
| `KeyframePayloadDto` | `KeyframePayload` | `kind: scalar|pair|crop` |
| `KeyframeValueDto` | `KeyframeValue` | `kind: scalar|pair|crop` |

Domain value types deserialized directly from JSON inside these DTOs (so their serde shape is
**also the project-file shape**): `AnimPair`, `AudioDenoise`, `ChromaKey`, `Clip`, `ClipType`,
`ColorGrade`, `Crop`, `Effect`, `Interpolation`, `LoudnessNormalization`, `LutReference`, `Mask`,
`StabilizationTrack`, `TextStyle`, `Transform`, `TransitionKind`.

Contract properties to preserve when extracting:
`#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]` on `EditRequest`
(unknown fields are rejected) and camelCase fields on every DTO. The repo has already paid for a
DTO field-naming bug (#143); the web side keeps `api.commandContract.test.ts` + `types.ts` as the TS
source of truth.

---

## 5. Pure serde/command conversion vs Tauri/host side effects

### 5.1 Pure — safe to move into `opentake-ipc`

| Concern | Where it lives today | Notes |
|---|---|---|
| JSON → `EditRequest` | Tauri block / node copy | serde only |
| `EditRequest` → `EditCommand` (+ 20 DTO conversions) | Tauri block / node copy | pure, no I/O, no Tauri/`AppCore` dependency |
| `EditCommand` application | `opentake-ops::command::apply` | in-memory `EditorState` mutation only (timeline + media manifest + undo); ids injected by `IdGen` |
| Undo/redo, can_undo/can_redo | `opentake-core` (`EditorState` history) | in-memory |
| `EditResult`/`TimelineSnapshot` serialization | `opentake-core::dto` | serde of domain values; no I/O |
| Revision/epoch checks | `AppCore::apply_at_*` | in-memory lock check |

`opentake-ops` depends only on `opentake-domain` (no serde dep, no fs). `opentake-core` adds
`opentake-project` (bundle file I/O) and the event bus but the edit transaction itself is pure.
Error type: `EditError` (ops) / `CoreError` (core) / `CmdError { code, message }` (IPC).

### 5.2 Host/Tauri-only — must stay in `src-tauri` (or an N-API host adapter)

| Area | Commands (representative) | Why |
|---|---|---|
| Edit wrapper | `edit_apply` | updater admission gate, project identity lease, freeze-frame capture + cleanup, expected revision/path args |
| Project lifecycle / recents | `project_new`, `project_open`, `project_save`, `get_default_project_dir`, `check_path_exists`, `home_project_*`, `home_projects_sync`, `sample_project_materialize` | bundle fs, atomic save, cover capture, project lifecycle coordinator, OS paths |
| Media I/O & analysis | `import_media`, `import_folder`, `get_media`, `generate_thumbnail`, `get_waveform`, `relink_media`, `save_clip_as_media`, `save_range_as_media`, `extract_audio`, `preload_media`, proxies, `library_*`, `import_lut`, `import_stems_to_tracks`, `analyze_loudness`, `analyze_stabilization`, `prepare_denoise`, `separate_audio_stems` | ffprobe/ffmpeg, file IO, caches, model downloads, OS keychain (secrets) |
| Render / preview / playback | `composite_frame`, `cancel_composite_frame`, `preview_poster`, `request_timeline_sprite`, `set_timeline_sprite_interactive`, `capture_frame_to_media`, `playback_start/pause/stop/seek`, `get_preview_endpoint`, `set/get_proxy_playback_enabled` | wgpu/ffmpeg/video decode, GPU state, MJPEG loopback server, cpal audio |
| Export | `export_video`, `cancel_export`, `export_xmeml/fcpxml(_modern)/edl/otio`, `export_subtitles`, `generate_captions` | child processes, output files, progress cancellers |
| Agent/chat/accounts/updates/advanced | `chat_*`, `codex_*`, `account_*`, `external_mcp_*`, `check_for_update`/`install_update`, `advanced_*`, `generation_*`, `motion_*`, `transcribe_*`, `search_*`, `storage_*`, `secret_*`, `download_*` | network, background tasks, platform integrations |
| Events to WebView | `core.subscribe` → `app.emit` (`timeline_changed`, `project_opened`, `project_saved`, `media_changed`), playback/chat/motion events | Tauri runtime |
| Dialogs | `@tauri-apps/plugin-dialog` (JS side); no dialog command in `commands.rs` | Tauri plugin |

### 5.3 In-memory but not request-mappable

- `freezeFrame` (needs a captured still first; see §3.7).
- `RegisterMediaAnd*` / `RegisterMediaAndFreezeFrame` (require a pre-registered media manifest entry).
- `Undo`/`Redo` commands exist but IPC uses dedicated commands.

---

## 6. Recommended extraction: `crates/opentake-ipc` (request wire crate)

### 6.1 Target layout

```
crates/opentake-ipc/
  Cargo.toml          # deps: opentake-domain, opentake-ops, serde
  src/lib.rs          # pub use request::*;
  src/request.rs      # EditRequest + 20 wire DTOs + into_command (+ unit tests)
```

```toml
[package]
name = "opentake-ipc"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Serde wire mirror of opentake-ops EditCommand shared by the Tauri and N-API hosts."

[dependencies]
serde = { workspace = true }
opentake-domain = { workspace = true }
opentake-ops = { workspace = true }

[dev-dependencies]
serde_json = { workspace = true }
```

Add to workspace `members` and `[workspace.dependencies]` as
`opentake-ipc = { path = "crates/opentake-ipc" }`.

Only `EditRequest` and `EditRequest::into_command` need `pub` visibility; the 20 wire DTOs and their
`into_*` helpers can stay private inside the crate. Keep the doc comment warning that the TS union is
the field-name contract.

### 6.2 Exact moves

1. **Move** `src-tauri/src/commands.rs` lines **1350–2356** (`// MARK: - EditRequest …` through the end
   of `impl KeyframeValueDto`) into `crates/opentake-ipc/src/request.rs`.
   Make `pub enum EditRequest` and `pub fn into_command` (it is currently private).
   The block is self-contained; its only external deps are `serde`, `opentake_ops::command` DTO/value
   types, `opentake_ops` re-exports, and `opentake_domain` value types (already in `use` lines).
2. **Delete** the same block from `src-tauri/src/commands.rs`; add
   `use opentake_ipc::EditRequest;`. Prune now-unused `opentake_ops::{ClipEntry, …}`/`opentake_domain`
   imports (they are only used by the moved block; check `freezeFrame`/`edit_apply` remaining uses).
   Add `opentake-ipc` to `src-tauri/Cargo.toml` dependencies.
3. **Delete** `crates/opentake-node/src/edit_request.rs` (1,028 lines) and the `mod edit_request;`
   declaration; replace with `use opentake_ipc::EditRequest;` (the `into_command()` call is unchanged).
   Add `opentake-ipc` to `crates/opentake-node/Cargo.toml`.
4. **Cleanup:** after this, the node crate no longer contains request DTO copies; `cargo check -p
   opentake-tauri -p opentake-node` and `cargo test -p opentake-ipc` prove the extraction.
5. **Do not move** response DTOs (`EditResultDto`, `TimelineSnapshotDto`, `CmdError`) — they convert
   core types (`EditResult`, `TimelineSnapshot`, `CoreError`) and keeping them in
   `opentake-core::dto` avoids an `ipc → core` dependency cycle. Both hosts already depend on
   `opentake-core`.

### 6.3 Alternatives considered

| Option | Verdict |
|---|---|
| Put the mirror in `opentake-ops` behind a `serde` feature | Rejected: `opentake-ops` is deliberately serde-free (only `opentake-domain`) and contains pure algorithms; adding serde there contaminates the leaf crate. |
| Put it in `opentake-core::dto` | Rejected: core already pulls `opentake-project` and the event bus; request types should be reusable by an N-API host without the desktop assembly, and core is the request *consumer*, not the wire layer. |
| Separate `crates/opentake-ipc` | **Recommended**: smallest dependency set (domain + ops + serde), testable without GPU/media/Tauri, and both hosts already depend on ops. |

### 6.4 Feature flags

None required at first. The crate is pure `serde`; `serde_json` is a dev-dependency for round-trip
tests. If compile-time trimming matters later, a `ts-contract`/schema-generation feature can be added
without affecting the wire format. Do **not** gate `deny_unknown_fields` behind a feature: the Tauri
IPC contract relies on rejecting unknown fields.

### 6.5 Tests to add with the crate

- One round-trip test per request tag (56) with a minimal JSON fixture, asserting the mapped
  `EditCommand` variant. Prioritize DTO-heavy tags: `placeMedia`, `addClips`, `pasteClips`,
  `setClipProperties`, `setKeyframes` (3 `kind`s), `upsertKeyframe` (3 `kind`s), `addTexts`,
  `addTextsAutoTrack`, `addCaptions`, `setMasks`, `setEffects`, `setChromaKey`, `setTransition`,
  `setTimelineSettings`.
- camelCase regression: a snake_case field must fail deserialization.
- `deny_unknown_fields` regression: an unknown field must fail.
- Nested `editNestedSequence` recursion test.
- Optional: a test asserting the TS union tags match a checked-in list (keeps `web/src/lib/types.ts`
  and Rust in lockstep; the web already has `api.commandContract.test.ts` for command names).

---

## 7. N-API `apply(json)` — current state and recommended gaps closure

### 7.1 Current state (`crates/opentake-node/src/lib.rs`, 38 `#[napi]` annotations: class + constructor + 36 methods)

```rust
#[napi]
pub fn apply(&self, command_json: String) -> Result<String> {
    let request: EditRequest = serde_json::from_str(&command_json)?;   // local copy today
    let command = request.into_command()?;
    let result = self.core.apply(command)?;                            // unversioned
    Ok(json({ "result": EditResultDto, "timeline": TimelineSnapshotDto }))
}
```

- `Engine::new()` builds `AppCore::new()` and **does not call `set_id_gen`**, so generated ids are
  `CoreIdGen` (`id-1`, `id-2`, …), while Tauri installs `UuidIdGen`. Fine for tests, but a persisted
  project written by Node then reopened by desktop (or vice versa) has different id shapes.
- No event subscription: the desktop React sync depends on `timeline_changed` with
  `{projectEpoch, version}` floors; Node returns the timeline inline instead.
- `freezeFrame` request returns `Err("freezeFrame must be handled by edit_apply")`.
- Errors become `napi::Error::from_reason(CoreError::to_string())`; they are not structured
  `{code,message}` like Tauri's `CmdError`, so the web shim's `TauriCommandError` mapping cannot
  distinguish `staleProject`/`validation`/`internal`.

### 7.2 Recommended API shape

1. `apply(commandJson, identity?)` — when `identity` = `{projectEpoch, timelineVersion, projectPath}`
   is supplied, route through `AppCore::apply_at_project_revision`; otherwise keep the current
   unversioned `apply` (single-host convenience). Return `{result, timeline}` as today.
2. `subscribe(callback)` / `unsubscribe` — bridge `CoreEvent` to JS via `napi::threadsafe_function`
   (or a `Channel`), emitting the same names/payloads as Tauri:
   `{kind:"timeline_changed",projectEpoch,version}`, `project_opened`, `project_saved`,
   `media_changed {projectEpoch,count}`. This lets the existing `web/src/store/sync.ts` logic work
   unchanged behind an adapter.
3. `freezeFrame(clipId, atFrame, durationFrames)` — mirror the Tauri validation and use the node
   crate's existing render pipeline + `RegisterMediaAndFreezeFrame`; or document that the request tag
   is rejected and the host must call a dedicated method. The current inline `apply` rejection is a
   real behavior gap versus `edit_apply` (one of 56 tags fails).
4. Structured errors — throw/return `{code,message}` (e.g. via `napi::Error` with a JSON status or a
   dedicated rejected value) preserving `validation` / `internal` / `staleProject`.
5. ID generator — call `self.core.set_id_gen(Arc::new(UuidIdGen))` in `Engine::new()` for UUID parity
   with Tauri, or expose an option (`Engine::new({idFormat:"uuid"|"seq"})`) so deterministic tests can
   keep `SeqIdGen`.
6. Thread model — `Engine` currently uses `RefCell` for export session and is used from the JS thread;
   background event delivery needs `Send` state or a separate subscription handle. Document that one
   `Engine` instance serializes edits like Tauri's `AppCore` lock does.

### 7.3 What stays in `src-tauri` after extraction

Everything in §5.2: `edit_apply` wrapper (admission gate, identity lease, freeze-frame capture and
cleanup, expected revision/path), project lifecycle/cover/save gates, media probing/import/library,
render/playback, export, updates/accounts/agent/advanced, event forwarding, and the Tauri command
registration list. The extraction only removes the serde mirror + DTO conversions; it does not move
the transactional/undo engine (already in `opentake-ops`/`opentake-core`) nor any I/O.

---

## 8. Minimum command subset for the existing React UI

The web UI currently reaches **148 exported async IPC wrappers in `web/src/lib/api.ts`**; across
`api.ts` + `libraryApi.ts` + `haptic.ts`, **129 distinct Tauri command names** are referenced, and
`api.commandContract.test.ts` asserts every
frontend command name is registered in `tauri::generate_handler!`. All 56 `EditRequest` tags appear in
the TS union and are built by `store/editActions.ts` (some behind feature flags).

### 8.1 Tier A — boot / mirror / project lifecycle (must)

- `get_timeline` (initial mirror + refresh after each event)
- `project_new`, `project_open`, `project_save`, `get_default_project_dir`, `check_path_exists`
- `home_projects_sync`, `home_project_register`, `home_project_remove`, `home_project_reveal`,
  `home_project_trash` (Recent projects / Home)
- `can_undo`, `can_redo`
- Tauri events: `timeline_changed`, `project_opened`, `project_saved`, `media_changed`
  (payloads: `kind`, `projectEpoch`, `version`, `path?`, `count?`)
- Optional: `sample_project_materialize`, `check_path_exists`.

### 8.2 Tier B — timeline editing loop (must)

- `edit_apply` (all 56 request tags are reachable; minimum gesture subset is the 56 union itself) +
  `undo` / `redo` with the `expectedProjectEpoch`/`expectedTimelineVersion`/`expectedProjectPath`
  identity envelope.
- Editing gestures the store actually offers: nested sequence create/edit/rename/dissolve; place/add/
  insert/paste; move/duplicate/move-to-new-track; remove/split/split-many/trim/ripple/swap;
  set properties/transform/keyframes (set/stamp/upsert/remove/move/interpolation); grade/LUT/chroma/
  masks/effects; loudness/denoise/stabilization; transitions; link/unlink; tracks (insert/remove/swap/
  props); folders + media rename/move/delete/swap; timeline settings; freeze frame.
- Media needed to populate the timeline: `import_media`, `import_folder`, `get_media` (thumbnail/
  preview bytes are served through the Tauri asset protocol in desktop; a DSH host must provide an
  equivalent file route), `generate_thumbnail`, `get_waveform`, `relink_media`, `preload_media`.

### 8.3 Tier C — preview / playback (needed to see the result)

- `composite_frame` (+ `cancel_composite_frame`), `preview_poster`, `request_timeline_sprite`,
  `set_timeline_sprite_interactive`
- Streaming playback (`playback-engine` feature): `playback_start/pause/stop/seek`,
  `get_preview_endpoint`; browser fallback exists (`web/src/components/preview/rustEngine.ts`), so a
  host without playback can still edit and step with `composite_frame`.

### 8.4 Tier D — export (needed for completion, not for editing)

- `export_video` (+ `cancel_export`), `export_xmeml`, `export_fcpxml`, `export_fcpxml_modern`,
  `export_edl`, `export_otio`, `export_subtitles`
- `capture_frame_to_media`, `save_clip_as_media`, `save_range_as_media`, `generate_captions`.

### 8.5 Tier E — optional modules (lazy; not required to load or edit)

`library_*`, `search_*`, `transcribe_*`, `generate_captions`, `separate_audio_stems`,
`analyze_*`/`prepare_denoise`, `chat_*`, `codex_*`, `account_*`, `external_mcp_*`, `advanced_*`,
`generation_*`, `motion_*`, `storage_*`, `secret_*`, update commands, feedback/haptic.

### 8.6 Route B / Node crate coverage vs Tier A+B minimum

| Minimal need | Desktop command(s) | `opentake-node` today | Gap |
|---|---|---|---|
| Snapshot | `get_timeline` | `get_timeline()` | ✅ |
| Edit | `edit_apply` | `apply(json)` | ⚠ no revision identity, no `freezeFrame`, string errors |
| History | `undo`/`redo`/`can_undo`/`can_redo` | `undo`/`redo`/`can_undo`/`can_redo` | ✅ (returns snapshot; no identity args) |
| New/open/save | `project_new`/`open`/`save` | `new_project`/`new_project_at`/`open_project`/`save_project` | ✅/⚠ names & shape differ; no recents/default-dir/home |
| Events | Tauri events | ❌ none | needed for multi-writer/agent edits; otherwise polling `get_timeline` |
| Project recents/home | `home_*` | ❌ | adapter needed (host may own recents) |
| Media import/probe | `import_media`, `import_folder`, `relink_media` | `import_media`, `relink_media`; no folder import | ⚠ folder scan/probe can live in DSH host or media lib |
| Media bytes/thumb | `get_media`, `generate_thumbnail`, asset protocol | `media_list` (metadata), `thumbnail()` | ⚠ DSH needs its own `/media` file route; thumbnails return base64/bytes |
| Waveform/proxy | `get_waveform`, proxies | `waveform`, `create_media_proxy` | ✅ |
| Preview | `composite_frame` | `composite_frame` | ✅ (RGBA/base64; no playback stream) |
| Playback stream | `playback_*` | ❌ | gap for scrub-free playback; frame-stepping works via composite |
| Export | `export_video` etc. | `export_begin/step/finish/cancel`, `export_video`, `export_timeline`, `export_subtitles`, `export_audio` | ⚠ streaming export API differs from one-shot `export_video`; interchange formats adapter needed |
| Dialogs | `@tauri-apps/plugin-dialog` | ❌ | DSH UI provides its own directory/file picker |
| Tauri JS bootstrap | `__TAURI_INTERNALS__`, `@tauri-apps/api/{core,event}` | ❌ | DSH host must shim `invoke`/`listen` (or port the UI bridge) |

**Practical minimum to load the React UI and edit a timeline in DSH**: Tier A (snapshot + project
lifecycle + `can_undo/can_redo` + events) + Tier B (`edit_apply` with revision identity + undo/redo +
media import/thumbnail/relink) + `composite_frame` for the preview. Everything else can be added
module by module; the dialog/asset-protocol/recents adapters are DSH-host work, not Rust-engine work.

---

## 9. Risks & mitigations

| Risk | Evidence | Mitigation |
|---|---|---|
| **DTO drift between the two copies** | `commands.rs` block and `node/edit_request.rs` are identical today (947 normalized lines, 0 diff); any UI tag/payload change must be edited twice | Extract `opentake-ipc`, delete the node copy; add per-tag JSON round-trip tests in the crate; keep the frontend `types.ts`/contract test as the TS source of truth |
| camelCase / field-name regressions | `#143` was a DTO casing bug; `deny_unknown_fields` makes stale UIs fail loudly | Add a snake_case-must-fail test and a JSON fixture per DTO-heavy tag; consider a shared tag list assertion (Rust ↔ TS) |
| `freezeFrame` silently unsupported on N-API | `into_command` returns `Err` for the tag; Tauri wrapper captures first | Add a dedicated `freezeFrame` N-API method or explicitly return a typed `unsupported` error with a next-step hint |
| Revision semantics diverge | desktop `edit_apply` requires epoch/version/path; node `apply` doesn't | Add optional identity args and route to `apply_at_project_revision`; keep unversioned apply only as a convenience |
| Event ordering / stale mirrors | desktop uses version floors from `timeline_changed`; node has no events | Bridge `CoreEvent` (threadsafe function) exactly as `forward_event` does; or document polling + version checks |
| ID shape mismatch | Node uses `CoreIdGen` (`id-1…`), desktop uses `UuidIdGen` | Set a UUID generator in `Engine::new()` or make it configurable; document persisted-project portability |
| Domain serde is also project-file serde | DTOs embed `Clip`, `Mask`, `Effect`, …; changing domain serde changes both wire and `.opentake` JSON | Treat domain serde changes as schema changes; coordinate with project persistence/versioning |
| Node addon packaging/threading | `cdylib` per platform, `RefCell` export state, `apply` copies the full snapshot | Keep one Engine per host; use existing chunked export; consider `serde_json` streaming for very large timelines |
| Tauri-only features pulled by a shared crate | `opentake-ops` has no Tauri deps; core has project I/O | `opentake-ipc` depends only on domain+ops; do not add `opentake-core`/`opentake-project` to it |

---

## 10. Appendix — reproduction / source coordinates

- Branch/commit inspected: `5caeb7d` (2026-11-08) `feat(route-b): audio-only M4A/MP3 export`.
- `EditRequest` block: `src-tauri/src/commands.rs:1350–2356` (1,007 raw lines).
- Node duplicate: `crates/opentake-node/src/edit_request.rs:1–1028`.
- `EditCommand`: `crates/opentake-ops/src/command.rs` (enum starts line 786; `apply` follows).
- Tauri `edit_apply`: `src-tauri/src/commands.rs` (`fn begin_edit_activity`, `pub fn edit_apply`,
  `validate_freeze_frame_request`).
- Core revision/apply: `crates/opentake-core/src/core.rs` (`apply`, `apply_at_revision`,
  `apply_at_project_revision`, `apply_at_revision_persisted`); DTO shims in
  `crates/opentake-core/src/dto.rs`.
- Tauri event forwarding: `src-tauri/src/lib.rs` (`forward_core_event`, `forward_event`,
  `core.subscribe`); event names/payloads are asserted by `core_event_forwarding_maps_every_name_and_tagged_payload`.
- Frontend contract: `web/src/lib/api.ts` (`editApply`, `editIdentityArgs`), `web/src/lib/types.ts`
  (`export type EditRequest`), `web/src/store/editActions.ts` (builders), `web/src/store/sync.ts`
  (version-floor refresh), `web/src/lib/api.commandContract.test.ts` (invoke ↔ `generate_handler!`).
- Node addon: `crates/opentake-node/src/lib.rs` (`struct Engine`, `pub fn apply`),
  `crates/opentake-node/Cargo.toml`, `crates/opentake-node/build.rs`.
- Counts computed from the sources above: `EditRequest` = 56 (Rust) = 56 (TS union);
  `EditCommand` = 75; mapping = 54 same-name + 1 renamed (`CreateNestedSequence` →
  `CreateNestedSequenceFromClips`) + 1 special (`FreezeFrame`); 18 command-only variants + Undo/Redo.
- No source was modified for this document; the only write is this file.
