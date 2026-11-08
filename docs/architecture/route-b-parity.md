# Route B — Feature Parity Matrix

> Status: planning + verification inventory · 2026-11-08 · branch `feat/dsh-rust-engine`
>
> Compares three surfaces:
> **(R)** the Rust/Tauri desktop app, **(J)** the current pure-JS DSH plugin
> `plugins/opentake-studio/`, and **(B)** the Route B prototype
> `plugins/opentake-studio-route-b/` (Rust engine as an in-process N-API addon +
> the existing React editor in a DSH iframe).
>
> This page records what the repository can support today. It does **not** turn
> prototype claims into acceptance: `Verified*` means "claimed verified in
> `docs/architecture/route-b.md`; not independently re-run for this page". The
> unknowns are listed in [§6](#6-unknowns-and-contradictions).

- Route B architecture and prototype notes: [route-b.md](route-b.md)
- Route B packaging: [route-b-packaging.md](route-b-packaging.md)
- Rust/Tauri capability manifest: [requirements.json](../capabilities/requirements.json)
- Rust/Tauri evidence ledger: [CAPABILITY-LEDGER.md](../capabilities/CAPABILITY-LEDGER.md)
- Pure-JS plugin parity plan: [PARITY-PLAN.md](../../plugins/opentake-studio/docs/PARITY-PLAN.md)
- Pure-JS plugin contract: [DESIGN.md](../../plugins/opentake-studio/docs/DESIGN.md)

---

## 1. How to read the matrix

### 1.1 Status labels

| Label | Meaning |
|---|---|
| **Verified** | An explicit repository evidence source supports the user-visible behavior: a named test/audit, installed-app evidence, or prototype verification. |
| **Partial** | Code exists, and often tests exist, but the evidence is incomplete, the scope is a subset, or a known limitation prevents calling it parity. |
| **Missing** | No implementation or bridge was found in the cited source. |
| **Unknown** | Evidence is contradictory or insufficient. See the unknown ID. |
| **N/A** | The concept does not apply to that surface (for example, native packaging in a DSH plugin). |

**Evidence codes** (`R*`, `J*`, `B*`) map to exact files/tests in [§7](#7-evidence-registry).

### 1.2 Route B milestones used for targets

These labels follow [route-b.md §4](route-b.md#4-milestones-m1m6). The
prototype developed them out of order, so a target of "M4" means the row must be
closed in that milestone, not that the milestone is complete.

| ID | Milestone | Exit condition |
|---|---|---|
| **M1** | Engine embedding spike | N-API addon loads; project new/open/save, `get_timeline`, `apply(EditRequest)`, undo/redo; smoke test passes; no UI requirement. |
| **M2** | Render and preview | wgpu `composite_frame`; thumbnails/waveforms; streaming preview; A/V sync is explicitly not yet the desktop `PlaybackEngine`. |
| **M3** | Frontend migration | Existing React editor in DSH via iframe/Tauri shim; home/editor, media import, timeline select/move/trim/split, preview, undo/redo, export dialog; Phase-0 shim hardening. |
| **M4** | Media, AI and Motion | Import/probe/relink/proxy, library, ASR/captions, text search, generation, Motion, nested sequences and interchange, with capability gating. |
| **M5** | Platform build and packaging | macOS/Windows/Linux addon builds; per-platform tarball; signing/notarization; install/update story. |
| **M6** | Full parity and acceptance | Every matrix row verified or explicitly out of scope; real DSH GUI and provider runs; rollback exercised; parity report signed off. |

> This page is the parity matrix referenced by `route-b.md` §4 (M6) and §8.3.
> `route-b.md` §8.3 explicitly distinguishes its branch-record claims from an
> independent audit; `Verified*` below follows that distinction.


---

## 2. Feature matrix

### A. Project, timeline and clip operations

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **A1** Project lifecycle: new/open/save/autosave/recent | **Verified** — `.opentake` bundle IO, recent registry, installed-app open/save/recent re-open [`R2`][R2], [`R3`][R3], [`R9`][R9], [`R10`][R10]. | **Verified (automated)** — folder project, atomic autosave, recent list/route/tool [`J1`][J1], [`J7`][J7]. | **Verified\*** — new project writes a real `.opentake`; open/save; the home screen renders in DSH; recent-project sync is bridged but not separately verified [`B1`][B1], [`B3`][B3]. | M1 done; M3 UI prototype; M6 re-verify. |
| **A2** Clip operations: add/move/trim/split/delete, overwrite, ripple, undo/redo, linked A/V | **Verified** — `EditCommand` engine + ops tests and undo/redo [`R1`][R1], [`R4`][R4]. | **Verified (automated)** — model and host tests; 422 tests pass [`J1`][J1], [`J4`][J4], [`J7`][J7]. | **Verified\*** — `apply(EditRequest)` + undo/redo; addon smoke test passes [`B1`][B1], [`B2`][B2]. | M1 done; M6 re-verify. |
| **A3** Timeline UI gestures: drag/trim, snapping, range marks, multi-select, copy/paste, ripple delete | **Partial** — `UP-TIMELINE-UI` is partial; range/multiselect/undo evidence exists, Option-trim and drag parity remain incomplete [`R1`][R1], [`R3`][R3]. | **Partial** — implemented in the client and phases claim coverage, but the phase UI was not independently GUI-verified [`J1`][J1], [`J8`][J8]. | **Partial** — full editor renders and the core load/edit/preview path was exercised; `route-b.md` §8.2 lists Phase-0 shim gaps (hand-injected shim, missing `unregisterListener`, polling instead of events, `/tmp` dialogs) and there is no gesture-specific verification [`B1`][B1], [`B9`][B9], [`B11`][B11]. | M3 prototype; Phase 0 + M6 acceptance. |
| **A4** Generic clip groups (independent of linked A/V) | **Missing** — the engine has `link_group_id` and `caption_group_id`, no generic group command [`R4`][R4]. | **Verified (automated)** — Phase 19 model + UI (`create-group`/`update-group`/`delete-group`, badge/selection) [`J1`][J1], [`J4`][J4], [`J8`][J8]. | **Missing** — inherits the Rust engine/UI; no generic group bridge [`B3`][B3]. | Out of scope for Rust parity (JS-only extension); decide separately. |
| **A5** Nested / compound sequences | **Partial** — create/edit/rename/dissolve commands and UI wiring exist; ops tests cover them, no installed-app evidence in the ledger [`R4`][R4], [`R6`][R6]. | **Missing** — no nested-sequence operation in the model operation list or UI [`J1`][J1], [`J4`][J4]. | **Verified\*** — `route-b.md` §8.1 records nested 60-frame composite/export with nested audio in the mixdown [`B1`][B1]. | M4 recorded; M6 re-verify. |
| **A6** Project format / interchange and migration | **Verified** — `.opentake` bundle (`project.json`, `media.json`, `generation-log.json`) [`R10`][R10]. | **N/A (different format)** — `opentake-studio.json` v1 is the plugin format; there is no `.opentake` importer [`J1`][J1]. | **Verified** — uses the Rust `.opentake` engine; **migration from JS plugin projects is missing** [`B1`][B1], [`B2`][B2]. | M1 done; migration decision at M6. |

### B. Effects, keyframes and stabilization

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **B1** Speed, fades and transitions | **Partial** — speed/transition/fade commands exist and are tested; installed-app transition/UI acceptance is not complete [`R1`][R1], [`R4`][R4], [`R6`][R6]. | **Partial** — true `xfade` only for opaque, static, same-track clips; fallback for text/transform/chained endpoints; tests exist [`J1`][J1], [`J2`][J2], [`J5`][J5]. | **Partial** — engine supports `EditRequest` speed/fades/transitions and the original UI is present; no Route B verification for these commands [`B1`][B1], [`B3`][B3]. | M3/M4 verification; M6 acceptance. |
| **B2** Keyframes / property animation | **Partial** — domain keyframe tracks, inspector, playback and render sampling; installed-app keyframe matrix is not closed [`R1`][R1], [`R5`][R5], [`R6`][R6]. | **Partial** — volume/opacity/x/y keyframes affect export; width/height/rotation keyframes preview and degrade to a static transform in export [`J1`][J1], [`J2`][J2], [`J5`][J5]. | **Partial** — engine supports keyframe commands; no Route B-specific verification [`B1`][B1], [`B3`][B3]. | M3/M4 verification; M6 acceptance. |
| **B3** Effects, color, LUT, masks, blend modes | **Partial** — domain/render/ops/UI exist; the ledger records Effect UI click/Undo as not closed and the mask/blend/grade paths as implemented [`R1`][R1], [`R2`][R2], [`R5`][R5], [`R6`][R6]. | **Partial** — ordered effects (eq/colorbalance/blur/sharpen/chroma key/LUT), rect/ellipse masks and 8 blend modes; blend is limited to full-frame unrotated/maskless clips [`J1`][J1], [`J2`][J2], [`J5`][J5]. | **Partial** — engine supports masks/effects/grade; original UI; no Route B effect/mask/blend verification [`B1`][B1], [`B3`][B3]. | M3/M4 verification; M6 acceptance. |
| **B4** Stabilization and motion tracking | **Partial** — stabilization analysis/commands + Inspector entry and Undo verified; numeric boundaries/analysis remain pending; motion tracking exists in `advanced.rs` and Agent tools [`R2`][R2], [`R3`][R3], [`R6`][R6]. | **Missing** — no stabilization or motion-tracking module/route in the plugin [`J1`][J1], [`J4`][J4], [`J6`][J6]. | **Missing** — no stabilization-analysis or motion-tracking bridge in the Host; the engine can apply a solution via `EditRequest`, but the UI has no analysis path [`B3`][B3]. | M6 (not bridged). |

### C. Captions, transcription and search

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **C1** Captions/subtitles: edit, SRT/VTT import/export | **Partial** — caption clips, SRT/VTT serializer, UI; subtitle SavePanel was opened/cancelled, not a full export re-run [`R1`][R1], [`R2`][R2], [`R8`][R8]. | **Partial** — caption clips, SRT/VTT import/export, styled captions; no word-level timeline and no caption-group batch sync [`J1`][J1], [`J2`][J2], [`J6`][J6]. | **Verified\*** — captions added via `AddCaptions`; SRT/VTT export with two cues at 30 fps [`B1`][B1]. | M4 recorded; M6 re-verify. |
| **C2** Transcription / word timestamps | **Partial** — whisper pipeline, cache and word→project-frame mapping exist; installed-app real transcription depends on model download and is not re-run here [`R1`][R1], [`R2`][R2], [`R8`][R8]. | **Partial** — provider-backed ASR via an OpenAI-compatible endpoint; segment-level transcript, no word rows [`J1`][J1], [`J6`][J6]. | **Partial** — provider ASR mock verified end-to-end with transcript/captions; real provider was not called [`B1`][B1]. | M4. |
| **C3** Search: text/spoken/semantic | **Partial** — SigLIP2 macOS inference/ranking verified; Windows qualification pending; Moments/Spoken UI exists [`R1`][R1], [`R2`][R2], [`R8`][R8]. | **Partial** — literal name/transcript search plus provider-generated vision descriptions; no CLIP/SigLIP embedding index or Moments [`J1`][J1], [`J6`][J6]. | **Partial** — text-only over names/cached transcripts; visual embeddings explicitly unavailable; model status reports `route-b-text-search` [`B1`][B1]. | M4. |

### D. Media library, proxies and relink

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **D1a** Media import, folders and view modes | **Verified** — import, recursive folders, missing/relink and folder/flat/grouped view modes have installed evidence [`R1`][R1], [`R2`][R2], [`R3`][R3]. | **Verified (automated)** — import, folder navigation and view modes [`J1`][J1], [`J6`][J6], [`J7`][J7]. | **Partial** — import verified; folder/view-mode bridges exist through the original UI but are not Route B-verified [`B1`][B1], [`B3`][B3]. | M4 recorded; M6 re-verify. |
| **D1b** Global media library: favorites/categories/folders | **Partial** — library UI visibility/empty-state recheck is still noted, so the surface is not fully verified [`R2`][R2], [`R3`][R3]. | **Verified (automated)** — folders/favorites/categories/tags and library→project [`J1`][J1], [`J6`][J6], [`J7`][J7]. | **Partial** — list/favorite/import verified; folder/category/rename/delete bridges exist but are not all verified [`B1`][B1], [`B3`][B3]. | M4/M6. |
| **D2** Proxies, thumbnails, waveforms, filmstrip sprites | **Partial** — proxy/thumbnail/waveform/sprite code exists; no installed-app proxy/sprites evidence in the ledger [`R2`][R2], [`R6`][R6]. | **Partial** — 360p proxy, thumbnails and audio waveforms verified; no filmstrip sprite cache [`J1`][J1], [`J6`][J6], [`J7`][J7]. | **Partial** — proxy create/remove, thumbnails and waveform buckets recorded; sprites not bridged (`spritePath` is null), and sprite/preset-resolution parity is unverified [`B1`][B1], [`B3`][B3]. | M2/M4 recorded; M6 re-verify. |
| **D3** Relink / missing media | **Verified** — relink included in the verified import/folder/relink capability [`R1`][R1], [`R2`][R2]. | **Verified (automated)** — relink keeps media id, invalidates proxy/thumbnail; tests exist [`J1`][J1], [`J6`][J6], [`J7`][J7]. | **Verified\*** — relink keeps the asset id via Host tool [`B1`][B1], [`B3`][B3]. | M4 recorded; M6 re-verify. |

### E. Generation / AI

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **E1** Image/video/speech generation | **Partial** — BYOK clients, Tauri commands and Agent tools exist; upstream generation panel/rerun/orchestration is not fully ported and paid-provider acceptance is separate [`R1`][R1], [`R2`][R2], [`R8`][R8]. | **Partial** — OpenAI-compatible image/speech + fal video; requires keys; no upscale/rerun/model catalog [`J1`][J1], [`J6`][J6]. | **Partial** — image/speech/video generation bridged as Agent tools; verified against local mocks, no real provider call [`B1`][B1], [`B3`][B3]. | M4. |
| **E2** Advanced AI analysis: beats/silence/smart reframe/denoise/stems/remove object/color match/translate/script-to-video | **Partial** — `advanced.rs` and Agent tools implement several workflows; coverage/UI/installed evidence is not uniform [`R2`][R2], [`R6`][R6], [`R8`][R8]. | **Missing** — no analysis modules or routes for these workflows [`J1`][J1], [`J4`][J4]. | **Missing** — no Host bridge for advanced analysis commands [`B3`][B3]. | M4/M6; if not bridged by M6, declare out of scope explicitly. |

### F. Motion / Lottie

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **F1** Lottie import / preview / export | **Partial** — `.json`/`.lottie` import partially verified; JSON screen evidence, container screen pending; native Lottie playback wired [`R1`][R1], [`R2`][R2], [`R6`][R6]. | **Partial** — `.json`/`.lottie` import, lottie-web preview, PNG-sequence export; 100k-frame sequence cap [`J1`][J1], [`J2`][J2], [`J5`][J5]. | **Partial** — `.json`/`.lottie` import and simple-shape render verified; no full Lottie matrix [`B1`][B1]. | M4 recorded; M6 re-verify. |
| **F2** Motion Studio / motion templates | **Partial** — Motion Studio implemented; transparent Motion publishing/export is partial; fixed Motion Canvas runner exists [`R1`][R1], [`R2`][R2], [`R6`][R6]. | **Partial** — Canvas motion templates (title/lowerThird/callout) only; no Motion Studio document authoring [`J1`][J1], [`J2`][J2], [`J5`][J5]. | **Partial** — Motion document CRUD/preview/publish through headless Chrome; H.264 + transparent ProRes 4444 verified; per-frame rendering is slow; not full Motion Canvas parity [`B1`][B1]. | M4 recorded; M6 re-verify. |

### G. Playback / preview

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **G1** Composite preview, playback, audio clock, preview tabs | **Partial** — `UP-PREVIEW-PLAYBACK` is partial; preview tabs are verified; native compositor and audio clock exist with remaining sync/pixel acceptance [`R1`][R1], [`R2`][R2]. | **Partial** — Canvas composite is explicitly approximate; hidden `<video>/<audio>` elements; no preview tabs [`J1`][J1], [`J8`][J8]. | **Partial** — direct source playback + composite-frame + wall-clock streaming emulation with a mixed WAV; true cpal master clock and full A/V sync remain; original UI has preview tabs [`B1`][B1], [`B4`][B4]. | M2 recorded; M6 re-verify. |

### H. Export

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **H1** Video codecs / presets / alpha / bit depth | **Partial** — H.264, H.265, ProRes 422 and ProRes 4444-alpha; no VP9/WebM; tests and packaged evidence exist but not all presets are screen-verified [`R1`][R1], [`R2`][R2], [`R7`][R7]. | **Verified (automated)** — H.264/H.265/ProRes/ProRes 4444/VP9-WebM, 8/10-bit, RGB alpha and color tags; export tests [`J1`][J1], [`J5`][J5], [`J7`][J7]. | **Partial** — H.264/H.265/ProRes/ProRes 4444 (incl. transparent) recorded; no VP9; export mix currently includes `Audio` clips only, so video-clip audio and denoise are absent, and preset-resolution parity is unverified [`B1`][B1], [`B2`][B2]. | M3/M4 recorded; M6 re-verify. |
| **H2** Range, audio-only, subtitles and timeline interchange | **Partial** — save-range-as-media, XMEML/EDL/OTIO/FCPXML and subtitles exist; no dedicated user audio-only export found [`R1`][R1], [`R7`][R7]. | **Partial** — range and audio-only (M4A/MP3) plus SRT/VTT; no XMEML/EDL/OTIO/FCPXML [`J1`][J1], [`J5`][J5]. | **Verified\*** — range export, audio-only AAC/MP3, subtitle export and all four interchange formats claimed verified [`B1`][B1]. | M4 recorded; M6 re-verify. |
| **H4** Export audio-mix parity: video-clip audio, denoise, ducking | **Partial** — desktop export mixes audio and video-clip audio; denoise is implemented; ducking/automation parity is not fully verified [`R2`][R2], [`R7`][R7]. | **Partial** — video-clip audio, fades and track `ducking` are implemented; no denoise [`J1`][J1], [`J5`][J5]. | **Missing** — Route B export mix currently includes `Audio` clips only; video-clip audio and denoise are absent and ducking envelopes are unimplemented [`B1`][B1]. | M4/M6. |
| **H3** Export progress, cancel, overwrite/failure cleanup | **Partial** — progress/cancel/cleanup paths and tests exist; real-mid-export cancel and A/V sync remain acceptance gaps [`R1`][R1], [`R2`][R2], [`R7`][R7]. | **Verified (automated)** — async progress/cancel, overwrite refusal, failure cleanup covered by host tests [`J7`][J7]. | **Partial** — chunked progress/cancel + partial-output cleanup claimed; file dialogs are stubbed and no Route B cancel acceptance run is recorded [`B1`][B1], [`B4`][B4]. | M3/M4 recorded; M6 re-verify. |

### I. Agent and DSH integration

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **I1** Agent / MCP tool surface and Context Signal | **Partial** — upstream tool set, dispatcher and hardened MCP transport exist; capability-gated publication and external-client pairings are implemented, not every tool is individually verified [`R1`][R1], [`R2`][R2], [`R8`][R8]. | **Verified (automated)** — 44 native DSH tools on the same service as the UI; no MCP [`J1`][J1], [`J3`][J3], [`J7`][J7]. | **Partial** — 27 `opentake_route_b_*` tools plus a generic `apply(EditRequest)`; no MCP server and no Context Signal [`B1`][B1], [`B3`][B3]. | M6 (tool-parity script). |
| **I2** Tauri IPC compatibility / UI shell | **Verified** — Tauri commands and React IPC are the production surface [`R4`][R4], [`R7`][R7]. | **N/A** — DSH routes + client bundle instead of Tauri IPC. | **Partial** — Tauri shim maps `invoke`/events/`convertFileSrc`; file dialogs are stubbed to `/tmp/opentake-route-b/`; unknown commands throw `command-not-implemented`; `/engine/asset` lacks `Range`/allowlist; the shim covers 73 of 133 UI command names and is pre-Phase-0 hardening [`B1`][B1], [`B4`][B4], [`B5`][B5], [`B9`][B9]. | M3 prototype; M6 harden/replace stubs. |
| **I3** IPC parity: revision guard, events, freezeFrame, structured errors, ID generator | **Verified** — Tauri `edit_apply` checks project epoch/timeline version/path, emits `CoreEvent`s, supports freeze-frame capture, returns structured errors and uses `UuidIdGen` [`R4`][R4], [`R7`][R7]. | **N/A** — the JS plugin uses its own routes/model, not Tauri IPC. | **Missing** — the addon `apply` is unversioned, there is no `CoreEvent` subscription, `freezeFrame` is rejected on the Node path, errors are strings and ids use `CoreIdGen` (`id-1`…); documented in `route-b.md` §3.2/§8.2 and the command map [`B1`][B1], [`B9`][B9]. | M3 (revision/events/freezeFrame); M6. |

### J. Product and platform

| ID / feature | Rust/Tauri app (current) | Pure-JS DSH plugin (current) | Route B (prototype) | Route B target |
|---|---|---|---|---|
| **J1** Settings | **Partial** — settings taxonomy is partial; settings UI exists [`R1`][R1], [`R9`][R9]. | **Partial** — a settings section for dependencies/shortcuts exists; no full settings taxonomy [`J3`][J3], [`J8`][J8]. | **Partial** — storage usage/clear is bridged; the rest of the original settings UI depends on Tauri commands that are incomplete or stubbed [`B1`][B1], [`B3`][B3]. | M6. |
| **J2** Account / cloud contract | **Missing / blocked** — `UP-ACCOUNT-CLOUD-BOUNDARY` is blocked; no official OpenTake account service; optional third-party backend only [`R1`][R1], [`R9`][R9]. | **Missing** — no account surface [`J1`][J1], [`J3`][J3]. | **Missing** — no account commands in the Host dispatcher [`B3`][B3]. | Out of scope until the account/cloud contract is decided. |
| **J3** Updater | **Partial** — updater module/commands and signed-install admission exist; full signed update flow is not re-verified here [`R2`][R2], [`R9`][R9]. | **N/A** — DSH owns plugin distribution and updates; no OpenTake updater. | **Missing** — `check_for_update` returns `null`; no update surface [`B3`][B3]. | Out of scope (DSH update model); decide at M6. |
| **J4** Platform packaging / signing | **Partial** — macOS `.app` builds; DMG tail script still incomplete; Windows/Linux builds and signing are not verified [`R2`][R2], [`R9`][R9]. | **N/A** — DSH bundle; no native binary. | **Partial** — macOS arm64 tarball built/tested; macOS x64 cross-built but not runtime-tested; Windows/Linux not built; no signing/notarization [`B6`][B6], [`B7`][B7]. | M5. |
| **J5** Performance, HDR/color management, frame-accurate playback | **Unknown** — no current evidence for large-project budgets, HDR tone mapping, or frame-accurate playback; HDR is explicitly not a passthrough claim [`R2`][R2]. | **Unknown** — approximate preview and no performance/HDR evidence [`J1`][J1]. | **Unknown** — no Route B performance/HDR/frame-accuracy evidence [`B1`][B1]. | M6; if not verified, declare out of scope. |

---

## 3. Acceptance criteria for “feature parity”

### 3.1 Definition

Route B reaches **feature parity** when every Rust/Tauri user-visible capability
in this matrix (rows where the Rust surface is not `Missing`) has an equivalent
Route B workflow inside DSH, with the same data semantics, and the Route B row is
**Verified** — not only present in code or claimed in prose.

Parity is behavioral and data-level, not byte-identical UI: the original React
editor is expected to run mostly unchanged, but the DSH shell, file dialogs,
provider configuration and update surface may differ.

### 3.2 Tiers

| Tier | Rows | Acceptance |
|---|---|---|
| **P0 — core editing loop** | A1–A3, A5, A6 (open/round-trip), D1a, D1b, D3, G1, H1 (H.264/AAC), H3, I2, I3 | All P0 rows **Verified**; no `Missing` or `Unknown`; no `command-not-implemented` on required commands; no `/tmp` dialog stub in a required flow. |
| **P1 — full editor parity** | A4 only if product decides; B1–B4, C1–C3, D2, E1–E2, F1–F2, H2, H4, I1 | All P1 rows **Verified** in a supported configuration; provider/model-dependent rows must fail closed when unavailable, and that gate must be visible in the UI. |
| **P2 — product/platform** | J1–J5 | Each row either **Verified** or explicitly listed as out of scope with a product decision. No silent omission. |

### 3.3 Evidence standard per row

A Route B row may be marked Verified only with one of:

1. **Automated test** with a named command and result (Rust unit/integration, Node
   host/route test, or a real `ffprobe` assertion).
2. **Real-run artifact** — file, ffprobe output, screenshot, or installed-app
   check — with date and artifact identity.
3. **Reconciled route-b documentation** that names the exact command and test
   evidence; prose claims alone are `Verified*`, not `Verified`.

### 3.4 Cross-cutting acceptance checks

- `.opentake` new/open/save round-trip preserves the timeline and media manifest.
- The same camelCase `EditRequest` JSON edits produce the same timeline state as
  the Rust/Tauri command path (undo/redo included).
- Export outputs pass `ffprobe` for codec/container/duration and, where
  applicable, alpha/pixel checks.
- No Tauri window, sidecar process or MCP bridge is started.
- Capability-gated features fail closed with a user-visible reason, never a
  silent no-op.
- Every P0/P1 UI workflow has an installed-DSH screenshot or an end-to-end
  automation record.
- macOS arm64 is the first gate; Windows and Linux are separate acceptance
  matrices (not implied by a successful macOS run).

---

## 4. Out of scope (explicit)

These are **not** required for Route B parity as defined above, or are explicitly
deferred to a later decision:

1. **Tauri runtime, window, sidecar or MCP bridge.** Route B is in-process N-API
   inside DSH; reintroducing any of these would violate the Route B premise.
2. **OpenTake account / subscription / cloud-generation backend.** The Rust
   boundary is blocked; Route B does not carry a cloud contract.
3. **OpenTake desktop updater.** DSH owns plugin installation and updates; an
   OpenTake updater inside DSH is out of scope.
4. **Code signing, notarization and store packaging** for the addon. These are
   M6 platform work, not prototype scope.
5. **Live paid-provider acceptance.** CI and repository verification use local
   mocks/configured endpoints; real paid provider calls require separate evidence.
6. **Automatic migration of `opentake-studio.json` projects** to `.opentake`.
   Route B opens `.opentake`; a migration tool is a separate deliverable unless
   added to M6.
7. **Generic clip groups** are a pure-JS plugin extension; the Rust/Tauri app has
   no equivalent, so they are not required for Rust parity.
8. **Real-time collaboration, remote sessions, multi-user editing.**
9. **HDR tone mapping / wide-gamut delivery / 5.1 / sample-rate policy** beyond
   what the Rust/Tauri app currently claims. The current app explicitly does not
   claim HDR passthrough.
10. **CapCut / upstream-palmier feature parity beyond the Rust app matrix.**
11. **Arbitrary Motion Canvas TSX project hosting** beyond the fixed runner /
    HTML-CSS document flow currently supported; full authoring parity stays M5.

---

## 5. Recommended closure order

1. **Fix the evidence base first.** Reconcile `route-b.md` with the code and
   remove the stale “Known gaps” statements (unknown U1/U2). A matrix cannot be
   signed off on a self-contradicting source.
2. **Close P0 with real DSH runs.** Project round-trip, core editing, media
   import/relink, preview, H.264/AAC export, undo/redo and file dialogs. This is
   the minimum to call Route B usable.
3. **Close P1 in this order:** export variants/interchange → captions/ASR/text
   search → effects/keyframes/transitions/stabilization → proxies/waveforms →
   Lottie/Motion → generation/advanced AI → Agent tool surface.
4. **Resolve product decisions:** generic groups (JS-only), project migration,
   account/updater, audio-only/interchange parity, VP9.
5. **Then M6:** cross-platform addon builds, packaged install, signing decision,
   full matrix re-run and parity report.

---

## 6. Unknowns and contradictions

| ID | Unknown / contradiction | Why it matters | What would settle it |
|---|---|---|---|
| **U1** | Route B prototype claims are largely **branch-record**, not an independent audit: `route-b.md` §8.1/§8.3 distinguishes “recorded” from re-run checks, and earlier README/route-b drafts contained contradictory gap lists. | Parity cannot be signed off from prose records; “recorded” rows need a re-run or artifact. | Keep the recorded/verified split; add route/tool integration tests and an installed-DSH E2E script; update the stale README/older notes. |
| **U2** | Route B has no automated test suite beyond the addon smoke test; the GUI/provider/Motion/export claims are recorded, not repeated. | Every `Verified*` row is a claim, not a regression gate. | Add route/tool integration tests, a headless DSH E2E script, and recorded ffprobe/provider artifacts. |
| **U3** | The pure-JS plugin `README.md` is stale relative to Phases 1–20 (e.g., it says groups/nested/audio-only are missing when groups and audio-only exist; it says track controls are minimal when they exist). | Copying README gaps into a matrix would understate the JS surface. | Treat `PARITY-PLAN.md` + model operations as the status source; update the README or link this matrix. |
| **U4** | Pure-JS phase claims are automated-test-backed (422 tests) but not installed-DSH GUI-verified for the later phases. | “Verified” for UI rows needs a real DSH run, not just model/export tests. | Install the current plugin, run the phase UI checklist, capture screenshots. |
| **U5** | Rust/Tauri installed-app evidence is dated (2026-08/09) and tied to specific package SHA-256 values. | The current branch may not reproduce those results. | Rebuild/package the current branch and re-run the relevant matrix rows. |
| **U6** | Route B carries a duplicated `EditRequest` mirror (1,028 lines; 56 variants) instead of a shared `opentake-ipc` crate, and the Node apply path lacks revision-bound apply, event subscription, `freezeFrame`, structured errors and the desktop `UuidIdGen`. | Every Rust command change must be mirrored manually; the remaining IPC gaps are P0 parity blockers. | Extract the shared crate; add per-tag round-trip tests; implement revision identity, events, freezeFrame, structured errors and ID parity (command map §7). |
| **U7** | Route B Tauri dialogs are stubbed to `/tmp/opentake-route-b/`; `/engine/asset?path=` reads any absolute path with no `Range`/allowlist; the shim covers 73 of 133 UI command names. | P0 “new/open/export” cannot be accepted through stubs, and the asset route is a path/security risk. | Bridge DSH directory picker/save panel; add project-root allowlist + `HEAD`/`Range`; publish command coverage and fail closed on unknowns. |
| **U8** | macOS x64 is cross-built but not runtime-tested; Windows/Linux addons are not built. | Cross-platform packaging and parity remain unknown. | Build and run the addon smoke/E2E on each target; record N-API/Node versions. |
| **U9** | Account/cloud contract is blocked; no decision on optional third-party backend. | Account UI cannot be declared in or out of parity. | Product decision: drop account UI or define a BYOK-only replacement and gate. |
| **U10** | Real paid-provider generation/ASR/search acceptance is not recorded; only local mocks. | “Generation works” depends on user credentials and provider behavior. | Record one real run per provider with redacted credentials, or keep capability-gated partial status. |
| **U11** | Large-project performance, 4K preview, HDR/color management and frame-accurate playback have no current evidence for any surface. | These are potential P1/P2 blockers. | Define budgets (timeline size, 4K playback, memory) and measure. |
| **U12** | `opentake-studio.json` projects cannot be opened by Route B; no migration plan. | Users of the JS plugin cannot move to Route B without losing work. | Decide: migration tool, import-on-open, or explicit out-of-scope. |
| **U13** | Route B motion uses headless Chrome per frame; performance/quality vs the Rust Motion Canvas runner is not measured. | Motion parity may be impractically slow on long clips. | Measure frame render time and publish a budget; compare output to the Rust runner. |
| **U14** | Desktop and Route B can both open the same `.opentake` bundle, but concurrent access/locking is untested (`route-b.md` §5.4). | A user could corrupt state by opening the same project in two hosts. | Define single-writer policy or locking; test concurrent open/save. |
| **U15** | The Route B target UI is unresolved: iframe delivery vs DSH-native component shell vs native React mount (`route-b-ui-integration.md`, `route-b-ui-inventory.md`). | The UI target changes the parity and packaging work; the iframe has theme/focus/command-coverage limits. | Product decision at M3/M6; adopt the inventory Phase-0 hardening first. |
| **U16** | Route B provider credentials live in Host memory/env, not the DSH credentials store; the config routes accept keys. | Key handling differs from DSH conventions and needs a consent/storage decision. | Decide credential storage and redaction; align with DSH credentials/MCP security patterns. |

---

## 7. Evidence registry

### Rust/Tauri app

- **R1** — [requirements.json](../capabilities/requirements.json): machine-readable capability statuses, source paths and named tests (`UP-MODELS-TIMELINE`, `UP-EDITOR-COMMAND-TRANSACTION`, `UP-EDITOR-SPLIT-TRIM-RIPPLE`, `UP-TIMELINE-UI`, `UP-PREVIEW-PLAYBACK`, `UP-PREVIEW-TABS`, `UP-MEDIA-IMPORT-AND-FOLDERS`, `UP-MEDIA-LOTTIE-IMPORT`, `UP-MEDIA-VIEW-MODES`, `UP-INSPECTOR`, `UP-TRANSCRIPTION-SEARCH-CAPTIONS`, `UP-EXPORT`, `UP-AGENT-MCP`, `OT-MOTION-STUDIO`, `OT-MOTION-ALPHA`, `UP-ACCOUNT-CLOUD-BOUNDARY`, `UP-SETTINGS-TAXONOMY`, `UP-SEMANTIC-SEARCH-MODEL`).
- **R2** — [CAPABILITY-LEDGER.md](../capabilities/CAPABILITY-LEDGER.md): dated installed-app and automated evidence, explicit partial/blocked gaps.
- **R3** — [full-desktop-functional-matrix.md](../audit/2026-08-21/full-desktop-functional-matrix.md): desktop GUI scenario matrix.
- **R4** — [crates/opentake-ops/src/command.rs](../../crates/opentake-ops/src/command.rs) and [command_apply.rs](../../crates/opentake-ops/tests/command_apply.rs): Rust edit command set and tests (nested sequences, stabilization, transitions, paste/ripple, linked A/V).
- **R5** — [crates/opentake-domain/src/](../../crates/opentake-domain/src/) and [domain overview](../modules/opentake-domain/OVERVIEW.md): keyframes, transforms, masks, grade, captions, caption-group sync.
- **R6** — [web/src/components/inspector/](../../web/src/components/inspector/) and [src-tauri/src/media.rs](../../src-tauri/src/media.rs): inspector/keyframe/effect/stabilization UI + analysis backend.
- **R7** — [src-tauri/src/export.rs](../../src-tauri/src/export.rs), [ExportDialog.tsx](../../web/src/components/shell/ExportDialog.tsx), [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs): export codecs, interchange commands, subtitles.
- **R8** — [src-tauri/src/transcribe.rs](../../src-tauri/src/transcribe.rs), [search.rs](../../src-tauri/src/search.rs), [generation.rs](../../src-tauri/src/generation.rs), [crates/opentake-media](../../crates/opentake-media/), [crates/opentake-gen](../../crates/opentake-gen/): transcription/search/generation.
- **R9** — [src-tauri/src/home.rs](../../src-tauri/src/home.rs), [updater.rs](../../src-tauri/src/updater.rs), [account.rs](../../src-tauri/src/account.rs), [web/src/components/settings/](../../web/src/components/settings/), [src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json): project registry, updater, account, settings, packaging.
- **R10** — [project overview](../modules/opentake-project/OVERVIEW.md): `.opentake` bundle format and XMEML export.

### Pure-JS DSH plugin

- **J1** — [PARITY-PLAN.md](../../plugins/opentake-studio/docs/PARITY-PLAN.md): Phase 1–20 implemented list, remaining gaps, 422-test claim, milestones.
- **J2** — [DESIGN.md](../../plugins/opentake-studio/docs/DESIGN.md) §§11–17: extended contracts for speed, keyframes, effects, markers, transitions, captions, masks/blend/track volume, motion templates.
- **J3** — [index.js](../../plugins/opentake-studio/index.js): 44 native `opentake_studio_*` tools and Host routes.
- **J4** — [lib/model.js](../../plugins/opentake-studio/lib/model.js): pure operation list, including groups, markers, effects, transitions, captions, motion.
- **J5** — [lib/export.js](../../plugins/opentake-studio/lib/export.js): codec/preset/alpha/10-bit, filters, true xfade, Lottie/motion sequences, range/audio-only.
- **J6** — [lib/](../../plugins/opentake-studio/lib/): `media.js`, `captions.js`, `transcribe.js`, `vision.js`, `generate.js`, `library.js`.
- **J7** — [test/](../../plugins/opentake-studio/test/): 422 tests pass on 2026-11-08 with `node --test plugins/opentake-studio/test/`.
- **J8** — [client.js](../../plugins/opentake-studio/client.js): editor UI (timeline, inspector, keyframes, effects, export dialog, captions, groups, library).

### Route B

- **B1** — [route-b.md](route-b.md): architecture, implemented list, known gaps, milestones, prototype verification claims. **Contradiction U1 applies.**
- **B2** — [crates/opentake-node/src/lib.rs](../../crates/opentake-node/src/lib.rs), [edit_request.rs](../../crates/opentake-node/src/edit_request.rs), [smoke.mjs](../../crates/opentake-node/test/smoke.mjs): addon API; smoke test passes on 2026-11-08 (`route-b addon smoke: ok`).
- **B3** — [plugins/opentake-studio-route-b/index.js](../../plugins/opentake-studio-route-b/index.js): `/engine/*` routes, 27 `opentake_route_b_*` tools, Tauri-invoke dispatch and stubs.
- **B4** — [tauri-shim.js](../../plugins/opentake-studio-route-b/web/tauri-shim.js): Tauri IPC shim; file dialogs stub to `/tmp/opentake-route-b/`.
- **B5** — [plugins/opentake-studio-route-b/README.md](../../plugins/opentake-studio-route-b/README.md): prototype scope and current limits.
- **B6** — [route-b-packaging.md](route-b-packaging.md): platform matrix and build flow.
- **B7** — [build-route-b-addon.sh](../../scripts/build-route-b-addon.sh), [package-route-b.sh](../../scripts/package-route-b.sh), and the `dist/opentake-studio-route-b-*.tgz` artifacts: addon build and packaging path.
- **B8** — [plugins/opentake-studio-route-b/client.js](../../plugins/opentake-studio-route-b/client.js): DSH main/sidebar shell with the same-origin iframe.
- **B9** — [route-b-command-map.md](route-b-command-map.md): `EditRequest`/`EditCommand` variants, duplicated 1,028-line mirror, extraction plan and residual revision/event/ID gaps.
- **B10** — [route-b-media-map.md](route-b-media-map.md): media/render/export/playback boundary, external runtimes (ffmpeg, Chrome, wgpu, whisper/ORT) and media milestone ordering.
- **B11** — [route-b-ui-inventory.md](route-b-ui-inventory.md): React/Tauri UI inventory, shim gaps A1–A10, command/event counts, native-mount scoping.
- **B12** — [route-b-ui-integration.md](route-b-ui-integration.md): iframe vs native mount options, DSH wiring, CSP/theme/focus risks and target-shell recommendation.

### Checks re-run for this page

- `node --test plugins/opentake-studio/test/` → **422 pass, 0 fail** (40 suites), 2026-11-08.
- `node crates/opentake-node/test/smoke.mjs` → **ok** (addon loads, edits, undo/redo, save/open).
- `node --check` on Route B `index.js`, `client.js`, `web/tauri-shim.js` → **ok**.
- `python3 scripts/check_docs.py` → **0 errors** after adding this page.

These checks cover the addon/JS/static surface only. They do **not** re-run the
installed-DSH GUI, provider, Motion, or cross-platform checks claimed in
`route-b.md`.

---

## 8. Related documents

- [Route B architecture and prototype](route-b.md)
- [Route B packaging](route-b-packaging.md)
- [Rust/Tauri capability ledger](../capabilities/CAPABILITY-LEDGER.md)
- [Pure-JS plugin parity plan](../../plugins/opentake-studio/docs/PARITY-PLAN.md)
- [Pure-JS plugin README](../../plugins/opentake-studio/README.md) — note U3: its gap list predates Phases 1–20.
- [Route B prototype README](../../plugins/opentake-studio-route-b/README.md)
- [Route B command map](route-b-command-map.md)
- [Route B media/render/export map](route-b-media-map.md)
- [Route B UI inventory](route-b-ui-inventory.md)
- [Route B UI integration](route-b-ui-integration.md)

[R1]: ../capabilities/requirements.json
[R2]: ../capabilities/CAPABILITY-LEDGER.md
[R3]: ../audit/2026-08-21/full-desktop-functional-matrix.md
[R4]: ../../crates/opentake-ops/src/command.rs
[R5]: ../../crates/opentake-domain/src/
[R6]: ../../web/src/components/inspector/
[R7]: ../../src-tauri/src/export.rs
[R8]: ../../src-tauri/src/transcribe.rs
[R9]: ../../src-tauri/src/home.rs
[R10]: ../modules/opentake-project/OVERVIEW.md
[J1]: ../../plugins/opentake-studio/docs/PARITY-PLAN.md
[J2]: ../../plugins/opentake-studio/docs/DESIGN.md
[J3]: ../../plugins/opentake-studio/index.js
[J4]: ../../plugins/opentake-studio/lib/model.js
[J5]: ../../plugins/opentake-studio/lib/export.js
[J6]: ../../plugins/opentake-studio/lib/
[J7]: ../../plugins/opentake-studio/test/
[J8]: ../../plugins/opentake-studio/client.js
[B1]: route-b.md
[B2]: ../../crates/opentake-node/src/lib.rs
[B3]: ../../plugins/opentake-studio-route-b/index.js
[B4]: ../../plugins/opentake-studio-route-b/web/tauri-shim.js
[B5]: ../../plugins/opentake-studio-route-b/README.md
[B6]: route-b-packaging.md
[B7]: ../../scripts/build-route-b-addon.sh
[B8]: ../../plugins/opentake-studio-route-b/client.js
