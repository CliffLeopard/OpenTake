# Route B — Existing React/Tauri UI inventory and DSH migration/shim proposal

Status: inventory complete · 2026-11-08 · branch `feat/dsh-rust-engine` @ `5caeb7d`
Scope: read-only inspection of `web/`, `src-tauri/` and the existing Route B prototype.
No source was modified; the only artifact of this task is this document.

Related: [route-b.md](route-b.md), [route-b-packaging.md](route-b-packaging.md),
`plugins/opentake-studio-route-b/`.

---

## 1. Summary and recommendation

Route B already runs the unmodified OpenTake React editor inside a **same-origin
iframe** served by the `@opentake/studio-route-b` DSH Host plugin. A small
injected Tauri shim (`web/tauri-shim.js`, 201 lines) maps the app's
`@tauri-apps/api` calls onto the in-process N-API engine through
`POST /opentake-studio-route-b/engine/invoke`.

Inventory headline numbers:

| Fact | Value |
|---|---|
| Production `web/src` TypeScript (`.ts`/`.tsx`) | 134 files / 54,393 lines |
| Tests | 153 files / 38,722 lines |
| React / React DOM | 18.3.1 / 18.3.1 — **identical to the DSH web shell's React 18.3.1** |
| Vite build, main JS chunk | 1,528 kB min / 456 kB gzip |
| Vite build, all JS | 1,553 kB min / 455 kB gzip (including lazy chunks) |
| Vite build, CSS | 29.4 kB min / 6.5 kB gzip |
| Tauri commands registered by `src-tauri/src/lib.rs` | 138 unique |
| Commands referenced from `web/src` | 133 (132 typed wrappers + `snap_haptic`) |
| Events subscribed by `web/src` | 21 names |
| Editor shell | single SPA, no router, 4 primary views, 3 editor layout presets |

**Recommendation**

1. **Keep the iframe as the Route B delivery vehicle for now.** It is the only
   zero-change path to a *real* editing engine: the app already renders, imports
   media, edits, previews and exports through the host shim (see `route-b.md`).
   Fix the shim contract gaps listed in §5.1 (A1–A7) before adding features.
2. **Introduce one bridge abstraction in `web/src`** (`@tauri-apps/*` build
   alias + a `capabilities`/`engine` flag) so the same UI can run behind the
   iframe shim today and a native DSH mount later. This is the highest-leverage
   refactor; it is small (a new `lib/bridge` module plus alias config) compared
   with the global-side-effect work below.
3. **Defer a native DSH React mount** until the scoping work in §5.2 is done.
   The UI is *technically* mountable (React versions match; DSH's module table
   exposes `react`, `react/jsx-runtime`, `react-dom` and `react-dom/client`),
   but it currently owns document-global state: 12 window `keydown` registrations
   across 7 files, a document-level `contextmenu` handler, `document.documentElement.lang`,
   `document.querySelectorAll("audio, video")`, `document.body` portals and 14
   fixed-position overlays up to `z-index: 10020`. Mounting that in the DSH
   document would hijack host UI.
4. Do not chase "no iframe" as a goal by itself. The iframe is a legitimate
   isolation boundary for a dark-only, keyboard-heavy NLE; a native mount buys
   tighter DSH integration but needs a Shadow DOM/root-scoping phase first.

---

## 2. Current Route B UI architecture (as implemented)

```
DSH Host process
└── plugins/opentake-studio-route-b/index.js  (1774 lines, PREFIX=/opentake-studio-route-b)
    ├── N-API addon native/<platform>-<arch>/opentake_engine_v2.node → opentake-core::AppCore
    ├── engine routes (see §2.2) and opentake_route_b_* agent tools
    └── static /app/*  →  web/dist build of web/src + web/tauri-shim.js
            └── DSH client.js mounts an iframe in the `main` slot
```

DSH client (`plugins/opentake-studio-route-b/client.js`, 81 lines):

- registers `main` slot key `opentake-studio-route-b` → `EditorPage` iframe
  (`src="/opentake-studio-route-b/app/"`);
- registers `sidebar.panellist` list entry id `opentake-studio-route-b`,
  order `16`, label `OpenTake (Rust)`, glyph component;
- injects three small `.otsb-` CSS rules through `ctx.effect`.

DSH slot contract observed in the installed build (`Slots` catalog inside the
client runner bundle):

- `main` — **keyed, root scope**, required `key`; registering an occupied key
  replaces that occupant (already taken: `conversation`; also occupied by
  Plugin Manager and Task Manager).
- `sidebar.panellist` — **list, root scope**, `id` / `order` / `label`; the
  sidebar resolves the label and dispatches the matching `main` key.
- `settings.section` (used by the separate `dsh-opentake` plugin) is also
  available for Route B engine settings later.

### 2.1 Shim injection is hand-maintained

`plugins/opentake-studio-route-b/web/index.html` contains a hand-added
`<script src="/opentake-studio-route-b/app/tauri-shim.js?v=11"></script>` before
the module entry and a hand-pinned asset hash. `scripts/package-route-b.sh`
does **not** inject the shim; the README build recipe only copies `web/dist`.
Any rebuild of the app silently drops the shim unless the step is repeated.
This should become a Host-side HTML transform (see §7, Phase 0).

### 2.2 Host engine routes (existing)

| Method | Path | Purpose |
|---|---|---|
| POST | `/opentake-studio-route-b/engine/invoke` | `{ cmd, args, options }` → command result / `{ error: { code, message } }` |
| GET | `/engine/asset?path=…` | local media bytes for `<img>/<video>` (shim's `convertFileSrc` target) |
| GET | `/engine/preview/frame` | Rust playback frame (MJPEG/JPEG) for `<img>` |
| GET | `/engine/playback/status`, `/engine/playback/audio`, POST `/engine/playback/sync` | wall-clock/WAV playback loop |
| GET | `/engine/export/status`, `/engine/motion/status` | progress polling |
| POST | `/engine/asr/config`, `/engine/generation/config`, `/engine/speech/config`, `/engine/video/config` | provider configuration |
| GET/POST | `/engine/info`, `/engine/new`, `/engine/open`, `/engine/save`, `/engine/timeline`, `/engine/apply`, `/engine/undo`, `/engine/redo`, `/engine/media` | typed direct routes (legacy/shortcut surface) |

---

## 3. `web/src` inventory

### 3.1 Entry, build and output

| Item | Value |
|---|---|
| `web/index.html` | `#root`, inline SVG favicon data URI, no fonts/assets |
| `web/src/main.tsx` | 15 lines; `createRoot(#root).render(<StrictMode><App/>)` |
| `web/src/App.tsx` | 280 lines; mounts primary views + global overlays + lifecycle |
| Bundler | Vite 8.1.3 + `@vitejs/plugin-react`; `tsc -b` only in `pnpm build` |
| Base path | must be built with `--base=/opentake-studio-route-b/app/` (route-b recipe) |
| Entry scripts | `src/main.tsx`; CSS via `import "./styles/global.css"` |
| Tests | Vitest 4 + happy-dom; `web/test/setup.ts`, `web/test/contrast.ts` |

Measured production build (out-of-tree, same source, `vite build`, no type
check; see §10 for the exact command):

| Chunk | minified | gzip |
|---|---|---|
| `index-*.js` (app + React + vendor) | 1,528.16 kB | 456.28 kB |
| `index-*.css` | 29.37 kB | 6.45 kB |
| `window-*.js` (lazy `@tauri-apps/api/window`) | 10.98 kB | 2.77 kB |
| `menu-*.js` (lazy `@tauri-apps/api/menu`) | 8.51 kB | 1.82 kB |
| `dpi-*.js`, `event-*.js`, `image-*.js`, `dist-js-*.js` | 2.12 / 1.34 / 0.61 / 1.24 kB | ≤0.63 kB each |
| **All JS** | **1,552.99 kB** | **454.61 kB** |

The checked-in Route B snapshot (`plugins/opentake-studio-route-b/web/assets/`)
matches: `index-DeeYDWaC.js` = 1,528,193 bytes; total JS gzip = 455,390 bytes.

### 3.2 Shell and navigation

- There is **no URL router**. Shell state lives in `store/uiStore.ts`
  (`view: "home" | "library" | "editor" | "motion" | …`, `settingsOpen`,
  panel visibility, `layoutPreset: "default" | "media" | "vertical"`,
  maximized panel, fullscreen, focused panel).
- `App.tsx` mounts each visited primary view once (`mountedPrimaryViews`) and
  hides inactive ones; editor-only hooks (`useKeyboardShortcuts`,
  `useTimelinePlaybackEngine`, `useAutosave`) stay mounted unconditionally.
- Editor layout (`components/shell/EditorSplit.tsx`): agent column + preset
  subtree; panes `MediaPanel`, `Preview`, `Inspector`, `TimelineRegion`;
  upstream default widths media 500 / inspector 260 / agent 320, minimum editor
  width from 300 px (vertical) plus pane minimums.
- Global overlays rendered by `App.tsx`: `CompatibilityBanner`,
  `ApplicationMenuBridge`, `SettingsView`, `UpdateCenter`, `ExportDialog`,
  `SaveAsProgress`, `ProjectSettingsMismatchDialog`, `Toast` (`role=status`,
  `aria-live=polite`).
- `TitleBar` / `HomeView` / `LibraryView` / `SettingsView` set
  `data-tauri-drag-region` and rely on `--titlebar-safe-left`,
  `--titlebar-safe-top` (macOS traffic-light overlay) in `styles/tokens.css`.
- Settings panes: `general`, `appearance`, `import`, `ai`, `mcp`, `shortcuts`,
  `account`, `storage`, `about` (`SettingsView.tsx`).
- Keyboard: `hooks/useKeyboardShortcuts.ts` (688 lines) attaches **two window
  `keydown` listeners** (one capture for Space) with editable/modal guards;
  6 other shell components add their own window `keydown` handlers.

### 3.3 Components (production files / lines per directory)

| Directory | Files | Lines | Main modules |
|---|---|---|---|
| `components/media` | 12 | 7,122 | `MediaPanel` (3,129), `MediaSearch`, `LibraryView`, `CaptionsTab`, `MusicTab`, `SoundLibraryTab`, `ScriptToVideoTab`, `TransitionTab`, `IdentityGenerationTabs`, `SmartPackTab`, `favorites` |
| `components/inspector` | 12 | 5,784 | `Inspector` (2,790), `KeyframesPanel/LaneRow/Ruler`, `TextTab`, `AiEditTab`, `ColorMatchSection`, `MattingSection`, `MotionTrackingSection`, `ObjectRemovalSection`, `SwapMediaSection`, `ScrubbableNumberField` |
| `components/timeline` | 12 | 5,794 | `TimelineContainer` (2,783), `TimelineRegion`, `TrackHeaderColumn`, `ClipContextMenu`, `TimelineRangeContextMenu`, `SwapMediaPicker`, `Playhead`, `SnapIndicator`, `clipRenderer`, `timelineCanvas`, `hitTest`, `rulerCanvas` |
| `components/preview` | 17 | 5,556 | `Preview` (1,651), `previewEngine`, `playbackRoute`, `TimelinePlaybackLayer`, `RustFrameBuffer`, `rustFrameBuffer`, `nativePlaybackSession`, `rustEngine`, overlays (`Transform/Crop/PolygonMask/MotionTracking`), `scrubGesture`, `interactiveSeek`, `audioGain` |
| `components/shell` | 8 | 3,064 | `EditorSplit`, `TitleBar`, `ViewMenu` (813; native app menu), `ExportDialog` (728), `CompatibilityBanner`, `ProjectSettingsMismatchDialog`, `SaveAsProgress`, `SplitPane` |
| `components/settings` | 5 | 2,517 | `SettingsView` (987), `ExternalMcpPane` (502), `AccountPane`, `StoragePane`, `UpdateDialog` |
| `components/home` | 1 | 1,166 | `HomeView` (recent projects, samples, about) |
| `components/agent` | 1 | 1,080 | `AgentPanel` (OpenTake's own chat agent; `chat_*` commands) |
| `components/motion` | 4 | 594 | `MotionStudio`, `MotionCodeEditor` (CodeMirror), `MotionTimeline`, `MotionPreview` |
| `components/ui` | 5 | 571 | `Icon`, `HoverButton`, `Dropdown`, `PanelShell`, `Reveal` |
| `components/toolbar` | 1 | 307 | `Toolbar` |

### 3.4 Stores (`web/src/store`, 15 files / 15,650 lines)

| Store | Lines | Responsibility |
|---|---|---|
| `editActions.ts` | 1,721 | every timeline edit → `edit_apply` + optimistic mirror |
| `uiStore.ts` | 931 | view/panels/selection/playhead/fullscreen/zoom (largest cross-cutting store) |
| `chatStore.ts` | 873 | OpenTake agent chat streams (`chat_*` commands + events) |
| `motionStudioStore.ts` | 955 | Motion Studio documents/CRUD/preview |
| `sync.ts` | 514 | timeline mirror sync on `timeline_changed` / `project_opened` |
| `projectActions.ts` | 393 | new/open/save/export flows |
| `libraryStore.ts` | 360 | global asset library |
| `recentStore.ts` | 284 | Home recent projects (`home_project_*`) |
| `mediaStore.ts` / `mediaActions.ts` / `mediaDeleteActions.ts` | 247 / 157 / 122 | media catalog, import, delete |
| `settingsStore.ts` | 196 | window size, proxy playback, BYOK provider |
| `updateStore.ts` | 227 | updater state |
| `projectStore.ts` | 129 | authoritative timeline mirror |
| `clipboardStore.ts` | 40 | internal clip clipboard |

11 stores use `zustand` (5.0.14).

### 3.5 Libraries (`web/src/lib`, 34 files / 15,797 lines)

| Module | Lines | Role |
|---|---|---|
| `api.ts` | 2,670 | the only Tauri bridge; 133 invokes + 21 event subscriptions + fallback gate |
| `fallback.ts` | 2,102 | browser-only in-memory timeline mirror (shell explorable without Tauri) |
| `types.ts` | 1,806 | DTO mirrors of Rust (`EditRequest` = 56 variants, snapshots, media, chat) |
| `clip.ts` | 903 | clip/geometry helpers |
| `derivedResourceScheduler.ts` | 341 | thumbnail/waveform/sprite request scheduling |
| `theme.ts` | 267 | canvas color constants duplicated from `tokens.css` |
| `asset.ts` | 24 | `convertFileSrc(path, "opentake-asset")`, gated on `isTauri` |
| `dialog.ts` | 26 | lazy `@tauri-apps/plugin-dialog` open/save |
| `haptic.ts` | 64 | macOS snap haptic via dynamic `core.invoke("snap_haptic")` |
| remainder | | geometry, keyframes, snapping, timeline ranges, zoom, presets, formats |

### 3.6 i18n

- Custom runtime (`src/i18n/index.ts`, ~80 lines) on `zustand`; dictionaries in
  `src/i18n/dict.ts` (**2,408 lines / 123 kB**, `en` + `zh-CN`, flat keys with
  `{placeholder}` interpolation).
- Default locale `zh-CN`, persisted in `localStorage["locale"]`; switching sets
  `document.documentElement.lang`.
- No `react-i18next` or other dependency. DSH locale is independent; a native
  mount must decide whether to follow the app setting or DSH's locale service.

### 3.7 CSS, tokens, fonts, assets

- `src/styles/tokens.css` — 213 lines, **151 custom properties**, dark theme
  only ("Dark theme is the only theme upstream ships"), 1:1 with upstream
  `AppTheme.swift`: `--bg-*`, `--border-*`, `--text-*`, `--accent-*`,
  `--status-*`, track colors, radius/spacing/font/opacity/shadow/animation,
  titlebar safe areas.
- `src/styles/global.css` — 307 lines; `@import tokens.css`; **global
  `html, body, #root { height:100%; overflow:hidden }`**, `body` background,
  font, `user-select:none`, `cursor:default`; shared utility classes.
- `src/styles/components.css` — 877 lines of shared classes used by components
  (components otherwise use inline style objects extensively).
- Fonts: system stacks only (`--font-ui`, `--font-serif`, `--font-mono`), no
  `@font-face`, no bundled font files, no image/SVG asset files, favicon is an
  inline data URI in `index.html`.
- Canvas drawing cannot read CSS variables, so `lib/theme.ts` duplicates the
  same values as JS constants — a second source of truth when theming for DSH.

### 3.8 Tests

153 test files / 38,722 lines, mostly `vitest` + happy-dom, including
interaction/parity suites (`interactionParity.test.tsx`,
`releaseParity.test.tsx`, lifecycle, DOM tests for `RustFrameBuffer`). These are
valuable as a regression net for the bridge refactor, but they mock
`@tauri-apps/api/*` at the module boundary (`vi.mock("@tauri-apps/api/core")`),
which is exactly the seam a DSH bridge should preserve.

---

## 4. Tauri IPC / asset API inventory

### 4.1 The `isTauri` gate

`web/src/lib/api.ts:77`

```ts
export const isTauri =
  typeof window !== "undefined" &&
  "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
```

- `true` → every wrapper lazily imports `@tauri-apps/api/core` / `event`
  (`ensureTauri()`) and forwards.
- `false` → editing uses the in-memory `fallback.ts`; dialogs/menus/updater/
  window calls are skipped. `recentStore.ts:156` repeats the same check.

The Route B shim works by defining `window.__TAURI_INTERNALS__` before entry,
which flips this gate to `true` without touching app source. That single global
is also the reason window/menu/updater code paths activate unexpectedly (see
§5.1 A3/A4 and §6.2).

### 4.2 Commands

- **138 unique command names** are registered in the Tauri handler
  (`src-tauri/src/lib.rs`, `generate_handler![ … ]`, lines ~357–500).
- **133 are referenced from `web/src`**: 132 through the typed `invokeImpl`
  wrappers (`lib/api.ts`, `lib/libraryApi.ts`) and `snap_haptic` through the
  dynamic `core.invoke` in `lib/haptic.ts`.
- `web/src` references no unregistered command.
- 5 registered commands are unreferenced by the UI: `export_fcpxml` (legacy
  alias; UI uses `export_xmeml`/`export_fcpxml_modern`), `generation_log`,
  `motion_edit`, `submit_feedback`, `transcript_get`.

Counts by area (prefix of the 132 wrapper commands): motion 10, cancel 9,
advanced 9, library 7, get 6, export 6, chat 6, home 5, external-MCP 5,
account 5, search 4, playback 4, import 4, codex 4, secret 3, project 3,
download 3, transcribe 2, storage 2, remaining singles.

Full referenced list (132 typed wrappers; `snap_haptic` additionally):

```
account_get_backend_url account_get_status account_login account_logout
account_set_backend_url advanced_apply_caption_translation_review
advanced_clone_voice advanced_generate_avatar advanced_generate_matte
advanced_match_color advanced_remove_object advanced_script_to_video
advanced_track_motion advanced_translate_captions analyze_loudness
analyze_stabilization can_redo can_undo cancel_advanced_workflow
cancel_composite_frame cancel_denoise_analysis cancel_export
cancel_loudness_analysis cancel_matting_model_download cancel_media_proxy
cancel_stabilization_analysis cancel_stem_separation capture_frame_to_media
chat_cancel chat_history chat_history_authoritative chat_send
chat_session_set_open chat_sessions check_path_exists check_for_update
close_update codex_auth_status codex_login_cancel codex_login_start
codex_logout composite_frame create_media_proxy download_matting_model
download_search_model download_transcribe_model edit_apply export_edl
export_fcpxml_modern export_otio export_subtitles export_video export_xmeml
external_mcp_pair external_mcp_regenerate external_mcp_revoke
external_mcp_set_enabled external_mcp_status extract_audio generate_captions
generation_cancel generation_retry get_default_project_dir get_media
get_preview_endpoint get_proxy_playback_enabled get_timeline get_waveform
home_project_register home_project_remove home_project_reveal
home_project_trash home_projects_sync import_folder import_lut import_media
import_stems_to_tracks install_update library_categorize library_delete
library_favorite library_import_to_project library_list library_rename
library_unfavorite matting_model_status motion_add motion_cancel
motion_capability motion_document_create motion_document_hash
motion_document_list motion_document_patch motion_document_read motion_preview
motion_preview_cancel open_update_releases playback_pause playback_seek
playback_start playback_stop preload_media prepare_denoise preview_poster
project_new project_open project_save redo relink_media remove_media_proxy
request_timeline_sprite sample_project_materialize save_clip_as_media
save_range_as_media search_index_start search_index_status search_model_status
search_query secret_delete secret_load secret_save separate_audio_stems
set_proxy_playback_enabled set_timeline_sprite_interactive storage_clear
storage_usage sync_project_favorites toggle_favorite transcribe_media
transcribe_model_status undo
```

Argument convention: JS camelCase keys (`expectedProjectEpoch`,
`expectedTimelineVersion`, `expectedProjectPath`, `mediaRef`, `newPath`,
`maxSize`, `operationId`, …) are deserialized by Tauri v2 command arguments.
Any shim must forward `args` **unchanged** — Route B's `/engine/invoke` already
does this and the Rust `EditRequest` serde mirror accepts the same shapes.

### 4.3 Events (21 names)

All subscriptions go through `listenImpl` = `@tauri-apps/api/event.listen`,
which under the hood calls `plugin:event|listen` and
`__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`.

| Event | Payload consumed by `web/src` |
|---|---|
| `timeline_changed` | `{ projectEpoch, version }` |
| `project_opened` | `{ path, projectEpoch, version }` |
| `project_saved` | `{ path, projectEpoch }` |
| `media_changed` | (any; handler refetches media) |
| `go_home` | (any; sets view=home) |
| `playback_frame` | `PlaybackFrameEvent`: `{ projectEpoch, timelineVersion, sessionId, frame, sequence, terminal }` |
| `export://progress` | `{ operationId?, done?, total? }` |
| `motion_progress` | `{ phase, doneFrames, totalFrames }` (motion publish) |
| `motion_document_changed` | document change descriptor |
| `transcribe://progress`, `matting://progress`, `search://progress`, `search://index`, `loudness://progress`, `denoise://progress`, `proxy://progress`, `stems://progress` | progress fractions/counters |
| `chat_delta`, `chat_tool_call`, `chat_done` | bounded agent stream envelopes |
| `external_mcp_status_changed` | `ExternalMcpStatus` |

Only the first six are required for first render/edit/playback. Route B's shim
emits `timeline_changed`, `media_changed`, `playback_frame`, `motion_progress`
and `export://progress`; the rest have no Route B bridge yet.

### 4.4 Dialogs

`lib/dialog.ts` lazily imports `@tauri-apps/plugin-dialog` and only uses
`open` / `save` (no `message`/`ask`/`confirm` in app code). Route B stubs both
to deterministic `/tmp/opentake-route-b/*` paths. This is the largest functional
gap for "new/open/save/export" flows in a real DSH session.

### 4.5 Window, menu, DPI, other native APIs

| API | Usage | Route B reality |
|---|---|---|
| `@tauri-apps/api/window` | `settingsStore.applyWindowSize` (scaleFactor, innerSize, outerPosition, setSize/setPosition, currentMonitor/primaryMonitor); `uiStore.syncFullscreen/toggleFullscreen` (isFullscreen/setFullscreen) | shim only defines metadata; the `plugin:window|*` commands are not implemented |
| `@tauri-apps/api/dpi` | `LogicalSize`, `LogicalPosition` (pure JS) | no IPC needed |
| `@tauri-apps/api/menu` | `ViewMenu.installNativeApplicationMenu` (Menu/Submenu/MenuItem/CheckMenuItem/PredefinedMenuItem + setText/setChecked/…), gated on `isTauri`, failure shows `menu.installFailed` toast | not implemented |
| `snap_haptic` | macOS trackpad tick on snap engagement | not implemented (best-effort, silently ignored) |
| updater `Channel` | `check_for_update`, `install_update` (`Channel<UpdateInstallEvent>` → `plugin:resources|close` on drop), `close_update`, `open_update_releases` | not implemented; updater is desktop-only and should stay disabled under DSH |
| `shutdown_on_exit`, `submit_feedback`, `ffmpeg_status` | registered, unused by `web/src` | irrelevant |

### 4.6 Asset protocol

- App code uses exactly one function: `lib/asset.ts`
  `convertFileSrc(path, "opentake-asset")`, gated on `isTauri`, returning a URL
  or `null`. Imported from `@tauri-apps/api/core` (static import → part of the
  main chunk).
- Native side (`src-tauri/tauri.conf.json`): `assetProtocol.enable = true`;
  allow `$APPCACHE/**/*`, `$APPDATA/OpenTake/Library/**/*`, `$RESOURCE/**/*`;
  deny `$HOME/.ssh`, `$HOME/.gnupg`, `$HOME/.aws`.
  CSP `img-src` / `media-src` allow `opentake-asset:`,
  `http://opentake-asset.localhost`, `blob:`, `data:`, `http://127.0.0.1:*`;
  `connect-src` allows IPC and loopback.
- The native protocol is a bounded, path-authorized, range-serving
  `safe_asset_protocol` (see `src-tauri/src/safe_asset_protocol.rs`), not plain
  `asset:`; the comment in `asset.ts` explains why (no UI-thread blocking,
  symlink/FIFO safety, File Provider placeholders).
- Consumers: media card posters/thumbnails/sprites (`thumbnailPath`,
  `spritePath`), `preview_poster` paths, audio waveform is numeric so no URL,
  `<video>` preview of source files via `TimelinePlaybackLayer`, and
  `RustFrameBuffer` (composite frames are PNG data URLs, not asset URLs).
- Route B replaces the scheme with a same-origin
  `GET /opentake-studio-route-b/engine/asset?path=…` (shim's `convertFileSrc`).
  **That route currently lacks the native protocol's allowlist/range
  guarantees** and must be hardened before it becomes the bridge contract
  (see §6.4).
- `get_preview_endpoint` returns a loopback HTTP URL used as `<img src>` for
  Rust streaming playback; Route B returns `/engine/preview/frame` (same-origin),
  which avoids DSH CSP loopback restrictions in a native mount.

### 4.7 Playback architecture (relevant for the shim)

- `components/preview/playbackRoute.ts` selects per-revision between
  `webkit` (DOM `<video>`/`<audio>`), `rust` (`get_preview_endpoint` `/frame`
  images + `playback_frame` events + WAV audio), or `unsupported` (Lottie,
  text, color grade, chroma key, stabilization, masks, effects, reversed or
  speed-changed clips outside Rust support).
- Feature flags persisted in `localStorage` (`opentake.rustEngine`;
  `proxyPlaybackEnabled` in `settingsStore`).
- `playback_start { fromFrame, identity, mediaId? }`,
  `playback_seek { identity, frame }`, `playback_pause { identity, frame }`,
  `playback_stop { identity }`, `get_preview_endpoint`, `composite_frame`
  (`{ request: { frame, projectEpoch, timelineVersion, sessionId,
  sessionGeneration, seekGeneration, sequenceId?, sourceMediaId? }, maxSize? }`
  → `{ width, height, dataUrl }`), `cancel_composite_frame`.
- Route B implements a wall-clock loop + mixed WAV + `/engine/playback/sync`
  from `audio.currentTime*fps` (see `route-b.md`). A native DSH mount inherits
  the same command/event surface; no change needed in `web/src`.

### 4.8 Boot sequence (what a shim must survive)

1. `main.tsx` mounts `App` in `StrictMode`.
2. `App` effect: `initI18n`, `initWindowSize` (window plugin → errors logged
   under Route B), `initProxyPlayback` (`get/set_proxy_playback_enabled`),
   `startUpdateScheduler` (Tauri only), retrying `startSync`
   (`get_timeline` + event subscriptions), `startMediaSync` (`get_media` +
   `media_changed`), `onGoHome`, global `contextmenu` suppression.
3. Home view: `home_projects_sync` (or fallback throws/empty), samples,
   `get_default_project_dir`; view switches unsubscribe library/media sync.
4. Editor: media posters/thumbnails/waveforms/sprites, preview route, playback.

---

## 5. DSH integration options

### 5.1 Option A — same-origin iframe (current, recommended short term)

**What works today** (verified by the Route B prototype, `route-b.md`):
full Home/editor render, new project writing a real `.opentake` bundle, media
import + probe + list, timeline insert/edit/undo/redo, poster thumbnails,
waveforms, wgpu composite preview, direct video preview, export with progress,
global library, storage pane, Motion Studio publish, provider ASR/search, and
agent image/speech/video tools.

**Why it needs no app change:** the app is loaded in its own document, so its
CSS resets, `html/body` rules, window-level keyboard listeners, `document.body`
portals, `z-index` floor and dark theme are naturally isolated from the DSH
shell. The shim supplies the Tauri internals globals before `main.tsx` runs.

**Blockers / gaps to fix for a production iframe:**

| # | Gap | Impact |
|---|---|---|
| A1 | Shim is injected by hand into the built `index.html`; asset hash and `?v=` are manual | rebuild loses the shim; unreproducible packaging |
| A2 | `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` is not defined | `event.unlisten` throws; internal listeners leak (observed in `@tauri-apps/api@2.11.1` event.js) |
| A3 | `plugin:window|*` handled as generic invoke → Host rejects | `initWindowSize` logs errors on every boot; fullscreen toggle fails; console noise |
| A4 | `plugin:menu|*` unhandled | `ApplicationMenuBridge` shows `menu.installFailed` toast on every editor boot |
| A5 | `plugin:dialog|*` returns `/tmp` paths | new/open/save/export flows are not usable from DSH |
| A6 | No push channel; shim polls export/motion/playback status | latency and polling cost; no `timeline_changed` push, so shim emits after known mutations only (Host-side edits via tools won't reach the iframe) |
| A7 | Asset route semantics differ from native safe protocol | path traversal / non-regular file / unbounded read risk; must validate |
| A8 | No DSH agent interoperability | DSH chat cannot see the editor selection; Route B's own `AgentPanel` chat is unbridged |
| A9 | iframe focus/shortcut handoff | DSH global shortcuts keep working when iframe is not focused; clicking into iframe gives the editor its own keyboard world; acceptable but must be documented |
| A10 | DSH CSP for `frame-src` not inspected in this task | prototype works in this build; re-verify after installing/updating DSH |

Verdict: **ship Route B on the iframe**, fix A1–A7 as Phase 0/2, keep A8–A9 as
known limits.

### 5.2 Option B — native DSH client bundle in the `main` slot (target)

**Enablers**

- DSH web shell and OpenTake both run **React 18.3.1** (checked: DSH web
  frontend bundle reports `version:"18.3.1"`; `web/package.json` `^18.3.1`).
- The DSH client module table (installed `dsh-web-frontend` bundle) exposes
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` (plus
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`,
  `@deepseek-ai/dsh-client-store`, `…-ui-slots`, `…-ui-primitives`,
  `…-ui-dockkit`). A compiled client bundle can externalize React and mount
  into the slot element; `dsh.client.external` declares non-baseline imports if
  needed.
- The app is a single `createRoot` SPA with no router and no server rendering:
  it can be booted into an arbitrary element instead of `#root`.
- `main` (keyed) and `sidebar.panellist` (list) slot options are already used by
  the prototype and are sufficient.

**Blockers (ranked)**

| # | Blocker | Why it matters / work needed |
|---|---|---|
| B1 | `@tauri-apps/*` imports | `lib/api.ts`, `lib/asset.ts`, `lib/dialog.ts`, `lib/haptic.ts`, `store/settingsStore.ts`, `store/uiStore.ts`, `components/shell/ViewMenu.tsx` import `@tauri-apps/api/{core,event,window,dpi,menu}` and `@tauri-apps/plugin-dialog`. Build-time alias to a `lib/dsh-bridge/*` adapter (same signatures) is the clean fix; alternatively keep the global shim, but then window/menu/updater paths activate. |
| B2 | `isTauri` conflates "engine present" with "native window present" | Native mount wants engine=true, window/menu/updater=false. Needs a capability object (`engine`, `window`, `menus`, `dialogs`, `updater`, `haptics`) and small edits in `api.ts`, `recentStore.ts`, `settingsStore.ts`, `uiStore.ts`, `ViewMenu.tsx`, `App.tsx`. |
| B3 | Document-global side effects | 12 `window.addEventListener("keydown")` registrations across 7 files (two in `useKeyboardShortcuts`), a global `document.addEventListener("contextmenu")` that calls `preventDefault` outside inputs (`App.tsx`), `document.querySelectorAll("audio, video")` pausing **all** page media (`App.tsx` stopHiddenPlayback), `document.documentElement.lang` mutation, `document.documentElement.style` motion vars (`ui/Reveal.tsx`), one `document.body.append` portal (`MediaPanel.tsx`), `createPortal` for track headers, and 14 non-test files using fixed-position overlays (z-index up to 10020). Native mount must scope events to the panel root (or Shadow DOM) and portal into a root-owned overlay host. |
| B4 | Global CSS | `global.css` styles `html, body, #root` and `tokens.css` defines 151 vars on `:root`; native mount must scope to `.opentake-root` / shadow root so DSH layout and tokens are untouched (and DSH tokens untouched by `--bg-*` etc.). |
| B5 | Dark-only theme | The editor is dark-only; DSH can be light. Native mount needs either a forced dark panel/`--dsw`-mapped theme or a light adaptation (not in scope now). Iframe side-steps this. |
| B6 | Asset URLs | `convertFileSrc` does not exist in a browser; bridge must return same-origin `/engine/asset?path=…`. `get_preview_endpoint` must be same-origin (Route B already is) or DSH CSP must allow loopback images. |
| B7 | Native dialogs | No Tauri dialog; need Host route or browser picker (File System Access API is not universally available in Electron/WebView). Until then, project paths must be Host-managed. |
| B8 | Window/title-bar assumptions | `data-tauri-drag-region` in 4 files and traffic-light safe areas; no window to drag/fullscreen in a panel. Map fullscreen to `element.requestFullscreen`, drop the native menu and title-bar chrome under DSH. |
| B9 | Layout minimums | editor split minimums assume a desktop window (media 500/inspector 260/agent 320; `minWidth` 760 in `tauri.conf.json`); in a narrower DSH panel the layout will overflow/collapse. Needs a compact preset / responsive step. |
| B10 | Bundle size and boot cost | 1.53 MB min / 456 kB gzip main chunk. Loading that synchronously inside the DSH page at boot is risky; lazy-import the app on first panel mount, externalize React (~139 kB min) and lazy-load Motion/CodeMirror (~700 kB min of `@codemirror` deps) and settings panes. |
| B11 | localStorage / i18n | App keys mix namespaced (`opentake.*`, `opentake.ui.v1.*`) and unprefixed names (`locale`, `windowSize`, `proxyPlaybackEnabled`, `defaultImportFolder`, `byokProvider`); the app default locale `zh-CN` is independent of DSH locale. Decide on namespacing/migration and locale policy. |
| B12 | Multiple mounts / StrictMode | DSH slot can unmount/remount panels; app stores are module singletons (`started` flags in `sync.ts`, media/library sync). Native mount must ensure clean dispose (already partly handled) and a single app instance. |

Verdict: native mount is **feasible but a multi-phase refactor**. Start with the
bridge + capability flags (small), then scoping (medium), then the bundle
(mechanical). Do not attempt it before Phase 3.

### 5.3 Decision matrix

| Criterion | Iframe (A) | Native bundle (B) |
|---|---|---|
| Real editing today | **Yes** (proven) | No (needs bridge + scoping) |
| App source changes | none (shim only) | bridge alias, capability flags, root scoping |
| DSH theming/layout integration | isolated, dark panel | full, requires theme work |
| DSH agent/interop | no | possible after bridge |
| Global host side effects | none (separate document) | must be refactored away |
| Bundle delivery | lazy on panel open | lazy import on first mount |
| Risk | low, shim gaps | medium-high, broad regression surface |
| Effort to first working | days (fix shim) | weeks (5 phases) |

---

## 6. Minimal Tauri shim surface (first render / edit / playback)

The shim can be implemented two ways with the **same contract**:

1. **Global shim** (current iframe approach): define the browser globals before
   the app entry runs.
2. **Build alias** (native mount + cleaner iframe): alias `@tauri-apps/api/core`,
   `.../event`, `.../window`, `.../menu`, `.../dpi` and
   `@tauri-apps/plugin-dialog` to `web/src/lib/dsh-bridge/*` modules that
   export the same functions and use the same Host routes. Keeping the same
   exported signatures preserves the existing `vi.mock("@tauri-apps/api/core")`
   test seam.

### 6.1 Required browser globals (global-shim variant)

```ts
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args, options),            // -> POST { cmd, args, options }
  transformCallback(cb, once),           // returns numeric id, registry
  unregisterCallback(id),
  runCallback(id, payload),              // for event dispatch
  callbacks,                             // Map used by some modules
  convertFileSrc(path),                  // -> /engine/asset?path=…
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
}
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, eventId),    // required by @tauri-apps/api@2 event.js
}
```

`@tauri-apps/api/core` also uses `metadata.windows/webviews` and
`__TAURI_INTERNALS__.plugins.path.{sep,delimiter}`; those are only needed if the
app imports `@tauri-apps/api/path`/`window` more deeply. Provide `plugins.path`
if window support is kept. `plugin:resources|close` must resolve (Channel drop
in the updater path) even when updates are disabled.

### 6.2 Command surface by milestone (app-level names, arguments unchanged)

**First render — Home**

| Command | Args | Returns |
|---|---|---|
| `home_projects_sync` | `{ entries: LegacyRecentProject[] }` | `HomeProjectEntry[]` (`path,name,createdAt,openedAt,modifiedAt,thumbnailPath?,preview?,missing`) |
| `get_default_project_dir` | — | `string` |
| `check_path_exists` | `{ path }` | `boolean` |
| `home_project_register` | `{ path, openedAt }` | `void` |
| `home_project_remove` / `home_project_reveal` / `home_project_trash` | `{ path }` | `void` |
| `sample_project_materialize` | `{ slug }` | `string` (project path) |
| `project_new` | `{ path: string \| null }` | `RuntimeTimelineSnapshot` |
| `project_open` | `{ path }` | `RuntimeTimelineSnapshot` |

**First editor render**

| Command | Args | Returns |
|---|---|---|
| `get_timeline` | — | `RuntimeTimelineSnapshot` = `{ timeline, version, projectEpoch, projectPath, compatibilityReadOnly, compatibilityBlockers }` |
| `get_media` | — | `MediaList` = `{ items, folders }` |
| `get_proxy_playback_enabled` / `set_proxy_playback_enabled` | `{ enabled }` (set) | `boolean` |
| `preview_poster` | `{ mediaRef, timeSecs? }` | `string \| null` (path) |
| `generate_thumbnail` | `{ mediaRef, timeSecs?, maxFrames?, includeSprite? }` | `ThumbnailResult \| null` = `{ mediaRef,type,thumbnailPath?,spritePath?,tileWidth?,tileHeight?,columns?,times[] }` |
| `request_timeline_sprite` | `{ mediaRef, maxFrames? }` | `{ status, thumbnail } \| null` |
| `set_timeline_sprite_interactive` | `{ active }` | `void` |
| `preload_media` | `{ mediaRef }` | `"queued" \| "duplicate" \| "cached" \| "busy" \| "staleProject" \| "cancelled" \| null` |
| `get_waveform` | `{ mediaRef }` | `number[] \| null` |

**Editing**

| Command | Args | Returns |
|---|---|---|
| `edit_apply` | `{ command: EditRequest (56 variants), expectedProjectEpoch, expectedTimelineVersion, expectedProjectPath }` | `EditResult` = `{ changed, actionName, affectedClipIds, timelineVersion, summary }` |
| `undo` / `redo` | same identity triple | `EditResult` |
| `can_undo` / `can_redo` | — | `boolean` |
| `project_save` | `{ path: string \| null, expectedProjectEpoch, expectedProjectPath }` | `string` (written path) |
| `import_media` | `{ paths: string[] }` | `MediaList` |
| `import_folder` | `{ path, recursive }` | `MediaList` |
| `relink_media` | `{ mediaRef, newPath }` | `MediaList` |
| `save_clip_as_media` | `{ clipId, operationId }` | `MediaList` |
| `save_range_as_media` | `{ request: { inFrame, outFrame, operationId } }` | `MediaList` |
| `capture_frame_to_media` | `{ frame, nameBase, folderId, sourceMediaId }` | `MediaList \| null` |
| `import_lut` | `{ path }` | `LutReference` |

**Playback**

| Command | Args | Returns |
|---|---|---|
| `get_preview_endpoint` | — | `string \| null` (same-origin `/engine/preview/frame`) |
| `playback_start` | `{ fromFrame, identity: { projectEpoch, timelineVersion, sessionId }, mediaId? }` | `void` |
| `playback_seek` | `{ identity, frame }` | `void` |
| `playback_pause` | `{ identity, frame }` | `void` |
| `playback_stop` | `{ identity }` | `void` |
| `composite_frame` | `{ request: { frame, projectEpoch, timelineVersion, sessionId, sessionGeneration, seekGeneration, sequenceId?, sourceMediaId? }, maxSize? }` | `{ width, height, dataUrl } \| null` |
| `cancel_composite_frame` | `{ projectEpoch, timelineVersion, sessionId, sessionGeneration, minimumSeekGeneration }` | `void` |

**Stubbed / no-op for the first milestone** (return capability=false so the UI
degrades rather than toasting): window `plugin:window|*`, menu
`plugin:menu|*`, updater (`check_for_update`, `install_update` Channel,
`close_update`, `open_update_releases`, `plugin:resources|close`), dialog
`plugin:dialog|open/save` (return a Host-chosen path), `snap_haptic`,
`shutdown_on_exit`, `submit_feedback`.

Window subset if fullscreen/window size is kept: `plugin:window|scale_factor` →
`1`, `inner_size` → panel size `{width,height}`, `outer_position` → `{x:0,y:0}`,
`set_size`/`set_position` → no-op, `current_monitor`/`primary_monitor` → `null`,
`is_fullscreen` → `document.fullscreenElement !== null`, `set_fullscreen` →
`element.requestFullscreen()`/`exitFullscreen()`.

### 6.3 Event surface

Bridge `listen(event, handler)` must return an unlisten function and deliver
`{ event, id, payload }` objects. Minimal set for render/edit/playback:

`timeline_changed`, `project_opened`, `project_saved`, `media_changed`,
`playback_frame`, `go_home`; then `export://progress`, `motion_progress`,
`motion_document_changed` for progress UI.

Transport options, in preference order:

1. `EventSource` from a Host `GET /engine/events` SSE route (one connection,
   host pushes `{ event, payload }`; works in iframe and native mount, no
   polling, survives panel focus changes).
2. Poll `/engine/events?since=<seq>` with a cursor (fallback; easy to implement
   with the existing status routes).
3. Keep the current shim's polling only for prototype parity.

### 6.4 Asset route contract

`GET /opentake-studio-route-b/engine/asset?path=<urlencoded absolute path>`

must mirror the native safe protocol closely enough for production use:

- resolve realpath; reject non-regular files, FIFOs, symlinks escaping the
  allowed roots;
- allow roots: project bundle media/derived dirs, `$APPCACHE` thumbnails,
  Route B cache root, `$RESOURCE`; deny `$HOME/.ssh|.gnupg|.aws` etc.;
- `Content-Type` by extension (video/image/audio/font),
  `Accept-Ranges: bytes`, honor `Range` (required for `<video>` seeking);
- `Cache-Control` for immutable derived files, `no-store` for source media;
- 403 for denied paths, 404 for missing, `HEAD` support.

### 6.5 Error envelope and capabilities

- Errors cross the bridge as `{ error: { code, message } }` with the app's
  `TauriCommandError` shape (`code` drives UI handling; never include secrets or
  tokens). Route B already returns this from `/engine/invoke`.
- Add `GET /engine/capabilities` → `{ engine: true, window: false, menus:
  false, dialogs: "stub", updater: false, haptics: false, playback: "wall-clock",
  events: "sse" }`; the bridge maps it onto the app's capability flags so UI
  hides window/menu/updater affordances cleanly instead of relying on the
  single `isTauri` boolean.

---

## 7. Proposed migration sequence

Each phase is independently shippable and verifiable in DSH. "Acceptance" is
the checklist for switching the default delivery.

### Phase 0 — Harden the iframe shim (now; smallest, highest value)

- Inject the shim from Host `serveStatic`/HTML transform instead of the
  hand-edited `web/index.html` (A1).
- Implement `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` and correct
  `plugin:event|listen`/`unlisten` id handling (A2).
- Implement the window subset as no-ops returning plausible values; stop noisy
  `initWindowSize` errors (A3).
- Make `ApplicationMenuBridge` skip under DSH via a capability flag (A4).
- Dialog route: Host-managed project root for new/open/save (A5).
- Harden `/engine/asset` (§6.4) and add range support (A7).
- Add SSE `/engine/events` (A6) and emit `timeline_changed` when Host tools
  mutate the timeline, so Host-driven edits reach the UI.
- Add `/engine/capabilities` (§6.5).
- Acceptance: reload after rebuild keeps the iframe working; editor boot has no
  console errors; new/open/save/export work with Host paths; Host tool edit
  shows in the UI without reload.

### Phase 1 — Introduce the bridge seam in `web/src`

- Add `src/lib/bridge.ts` with `hasEngine`, `capabilities`, and typed
  `invoke`/`listen`/`assetUrl`/`dialog` helpers; alias `@tauri-apps/*` to
  adapter modules (`tauri` adapter keeps current behavior; `dsh` adapter uses
  the Host routes).
- Replace direct `isTauri` uses with capability flags (engine vs window vs
  menus vs updater).
- Keep the existing `vi.mock("@tauri-apps/api/core")` seam or move mocks to the
  adapter; run the full `vitest` suite.
- Acceptance: `pnpm test` green; standalone Tauri app and DSH iframe both boot;
  no behavior change.

### Phase 2 — Iframe on the bridge (no globals)

- Build the app with the `dsh` adapter; remove the injected shim script
  entirely; iframe HTML is a plain Vite build with `--base`.
- Move to SSE events; remove status polling hacks for export/motion/playback.
- Acceptance: same feature set as Phase 0 without any `window.__TAURI_*`
  globals; no `@tauri-apps` in the served bundle beyond stubs.

### Phase 3 — Scope the UI for native mounting

- Root container contract: `createRoot(slotElement)`; move
  `html/body/#root` rules and `:root` tokens under `.opentake-root` (or render
  the app inside a Shadow DOM root for isolation).
- Scope window keyboard listeners to the root (capture only within the panel),
  replace global `contextmenu` prevention with panel-local handling, replace
  `document.querySelectorAll("audio, video")` with app-owned media registry,
  portal overlays into a panel overlay host, stop mutating
  `documentElement.lang`.
- Capability-gate TitleBar drag/fullscreen/native menu; add a compact layout
  preset for narrow DSH panels; decide theme policy (force dark or map tokens).
- Acceptance: two OpenTake panels or OpenTake + DSH chat side by side; DSH
  shortcuts and context menus unaffected outside the panel; no document-level
  side effects (grep for `document.body`, `window.addEventListener`,
  `documentElement` in the mounted path).

### Phase 4 — Native DSH client bundle

- Emit one `client.js` in the DSH module format
  (`window.__ModuleLoader__.load({ id, factory })`) that registers `main` +
  `sidebar.panellist`, injects scoped CSS through `ctx.effect`, and
  `import()`s the app chunk on first mount; externalize `react`/`react-dom`
  (module table) and declare non-baseline imports in `dsh.client.external`.
- Host serves engine + asset + events routes; no iframe.
- Acceptance: `cordis_inspect_query` shows the slots; Home/editor render,
  import, edit, undo/redo, playback, export work from the native panel;
  bundle loads lazily; DSH theme and shortcuts intact.

### Phase 5 — Parity and cleanup

- Retire the injected shim and the iframe `EditorPage`; keep the iframe path
  behind a manifest flag for one release as fallback.
- Update `route-b.md`, `route-b-packaging.md`, README; verify packaging on
  darwin-arm64/x64 and (later) Windows/Linux.
- Acceptance: Route B acceptance matrix in `route-b.md` re-run on the native
  mount; only then remove the iframe.

---

## 8. Bundle size / dependency risks

| Dependency | Version | Package footprint | Runtime contribution / risk |
|---|---|---|---|
| `react` + `react-dom` | 18.3.1 | — | bundled prod JS ≈ 138.6 kB min (131.7 + 6.9). **Externalize in the native mount** (must match DSH's 18.3.1 or hooks/context break); ~45 kB gzip saved. |
| `@tauri-apps/api` | 2.11.1 | 832 kB package | tree-shaken; only 4 lazy chunks (window 11.0, menu 8.5, dpi 2.1, event 1.3 kB) + core in main. Replacing with the bridge removes unused window/menu code; `convertFileSrc` import stays static. |
| `@tauri-apps/plugin-dialog` | 2.7.1 | small | lazy chunk only; replaced by bridge dialogs. |
| `zustand` | 5.0.14 | 252 kB package | runtime tiny; 11 stores. No risk. |
| `lucide-react` | 0.468.0 | 36 MB package | 50 unique named icons across 31 import sites → tree-shaken to used icons. **Keep named imports; never `import *`.** |
| `codemirror` + `@codemirror/*` | 6.0.2 / 6.x | `@codemirror/state` 145.7 kB, `@codemirror/view` 490.8 kB, `lang-html` 26.1, `lang-css` 16.0, `theme-one-dark` 4.8, meta 4.7 (unminified dist) | only used by Motion Studio (`MotionCodeEditor.tsx`). `MotionStudio` is **statically imported by `App.tsx`**, so the whole editor lands in the main chunk. Lazy-load Motion Studio (and settings panes) to cut boot cost substantially. |
| app source | — | 54,393 prod TS/TSX lines; i18n dict 123 kB | main chunk 1,528 kB min / 456 kB gzip — acceptable as a lazily imported panel, too heavy for synchronous DSH boot. |
| CSS | — | 29.4 kB min / 6.5 kB gzip | inline into the client bundle or serve as one file; scope in Phase 3. |

Additional risks: source maps off; no separate vendor chunk (React/vendor in the
app chunk); hashed asset names in the checked-in Route B snapshot are manually
pinned in `web/index.html`; `?v=11` shim cache-buster is manual.

---

## 9. Open questions / residual unknowns

1. **DSH CSP for iframes** was not inspected in this task. The prototype works
   in the installed build; re-verify `frame-src`/`sandbox` after DSH updates.
2. **Native mount bundle format**: whether `react-dom/client` resolves through
   `require` in a compiled dynamic client bundle (module table lists it) or
   must be declared in `dsh.client.external`; confirm with a throwaway client
   bundle in a scratch profile before Phase 4.
3. **Dialog strategy**: browser File System Access vs Host-managed path vs DSH
   file picker component. Affects new/open/save and export UX.
4. **Asset allowlist semantics** for Route B: replicate
   `safe_asset_protocol` rules or define a narrower project-scoped allowlist.
5. **Theme policy** for native mount (forced dark panel vs DSH token mapping);
   also whether `lib/theme.ts` canvas constants need a token bridge.
6. **Multi-instance/multi-panel** behavior: module-singleton stores and
   `sync.ts` `started` flags assume one editor instance per page.
7. **Agent integration**: whether Route B should embed DSH chat (instead of its
   own `AgentPanel`) once the native mount exists.
8. **Cross-platform**: only darwin-arm64 was runtime-tested; the shim/bridge is
   platform-neutral but packaging and ffmpeg sidecars are not (see
   `route-b-packaging.md`).

---

## 10. Evidence and method

- Read (no edits): `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`,
  `web/vitest.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`,
  `web/src/lib/{api,asset,dialog,haptic,fallback,types}.ts`,
  `web/src/store/{settingsStore,uiStore,recentStore,sync}.ts`,
  `web/src/hooks/useKeyboardShortcuts.ts`,
  `web/src/components/{shell/*,preview/playbackRoute.ts,settings/SettingsView.tsx}`,
  `web/src/styles/{tokens,global}.css`, `web/src/i18n/index.ts`,
  `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`,
  `plugins/opentake-studio-route-b/{index.js,client.js,web/index.html,web/tauri-shim.js}`,
  `docs/architecture/route-b.md`, `docs/architecture/route-b-packaging.md`.
- Command inventory: `grep` of `invokeImpl(...)` / `requireExternalMcpDesktop()(...)`
  call sites vs the `generate_handler![…]` block (138 registered, 133 referenced).
- Event inventory: `grep` of `listenImpl(...)` / `listen(...)` across non-test
  source (21 names).
- Bundle measurement (out-of-tree, does not write `web/dist`):

  ```bash
  # /tmp/otk-vite-build.config.mjs: root=web/, cacheDir=/tmp/otk-vite-cache,
  # plugins=[@vitejs/plugin-react], build.outDir=/tmp/otk-web-dist
  cd web && pnpm exec vite build --config /tmp/otk-vite-build.config.mjs
  ```

  Output: 1,738 modules; `index-*.js` 1,528.16 kB / 456.28 kB gzip;
  `index-*.css` 29.37 kB / 6.45 kB gzip; lazy `window` 10.98 kB, `menu` 8.51 kB,
  `dpi` 2.12 kB, `event` 1.34 kB, `image` 0.61 kB, `dist-js` 1.24 kB.
  Total JS 1,552,992 B / 454,614 B gzip. The checked-in Route B snapshot
  (`index-DeeYDWaC.js`, 1,528,193 B; total JS gzip 455,390 B) matches.
- DSH facts: installed web bundle `index-BgUyXZcc.js` (frontend 0.2.2-rc.1)
  reports React `18.3.1` and its module table exposes `react`,
  `react/jsx-runtime`, `react-dom`, `react-dom/client`, cordis, zod,
  virtual, dsh-client-store, dsh-client-ui-slots/primitives/dockkit. Slot
  catalog for `main` / `sidebar.panellist` / `settings.section` read from the
  installed client runner bundle.
- Test environment: `vitest` config merges `vite.config.ts` with
  `web/test/setup.ts`; existing bridge mocks are
  `vi.mock("@tauri-apps/api/core" | "@tauri-apps/api/event")`.

Limitations of this inventory:

- No live DSH page was available to this task for `cordis_inspect_query`
  (`Slots.listSubTree` timed out), so slot topology/theme verification relies on
  the installed slot catalog and the shipped Route B prototype.
- No native DSH mount was attempted; feasibility claims are static.
- Bundle sizes are from an out-of-tree Vite production build of the current
  working tree, not from `pnpm build` (which also runs `tsc -b`); type errors
  and the checked-in snapshot's exact base path do not affect the byte counts
  materially.
- The `web/` tree was not modified; `docs/architecture/route-b-ui-inventory.md`
  is the only file written by this task.
