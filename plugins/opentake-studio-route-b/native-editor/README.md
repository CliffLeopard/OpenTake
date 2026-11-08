# Native editor body prototype (Route B)

Status: **wired as an optional native preview** in the DSH shell, 2026-11-08,
branch `feat/dsh-rust-engine`. The iframe editor remains the default and the
fallback; the shell exposes a toggle that lazily imports the served native
bundle, mounts it in a ShadowRoot and disposes it on switch/unmount.

## What this is

A real React mount of a small editor body into an open ShadowRoot, with
explicitly scoped CSS/locale and the existing `/opentake-studio-route-b/engine/*`
routes. It is not a second copy of the full app and does not import the existing
app stores/components.

Bounded milestone implemented:

- Home: engine status, project path, new/open/save actions, media count.
- Media library: media list from `/engine/media`, type/duration labels, selection,
  optional thumbnails from `/engine/asset?path=`.
- Timeline: tracks, clips, ruler, selected clip, undo/redo, ±1-frame move
  through `apply({type:"moveClips", ...})`.
- Preview: `/engine/preview/frame`, frame slider/step controls, revision-busted
  URLs.
- Inspector: selected clip/track properties, opacity/volume/transform edits,
  optional text content, and track mute/hide/sync-lock via `/engine/apply`
  (`setClipProperties` / `setTrackProps`).
- Export: codec, quality, bit depth, frame range, duck-music and HDR10 controls
  invoking the existing `export_video` IPC; progress polling via
  `/engine/export/status`; summary/error display.
- Settings: engine info, storage categories (cache clear), search/transcription
  model status and search-index status from existing `invoke` commands.
- Lifecycle: explicit `unmount()`, subscription teardown, optional timeline/media
  polling, AbortSignal ownership in `entry.js`, no global `document`/`head` writes.

## Files

| Path | Role |
|---|---|
| `web/src/native/ipc.js` | Plain-fetch engine client, error normalization, preview/asset URL helpers |
| `web/src/native/store.js` | React-free state model/actions, history, polling |
| `web/src/native/locale.js` | en/zh dictionaries and pure translator |
| `web/src/native/styles.js` | ShadowRoot-scoped CSS; `:host` + `.otn-*` only |
| `web/src/native/components.js` | React view (createElement, no JSX/import of React) |
| `web/src/native/mount.js` | ShadowRoot + CSS + React root mount/unmount contract |
| `web/src/native/index.js` | Public source barrel |
| `web/src/native/browser-entry.js` | Bundled entry; exports `mountNative` |
| `plugins/.../native-editor/build-bundle.mjs` | Vite library build for the served artifact |
| `plugins/.../native-editor/entry.js` | Source entry; owns AbortController |
| `plugins/.../web/native-editor/native-editor.js` | Served self-contained bundle (React/ReactDOM included) |
| `plugins/.../native-editor/preview.html` | Browser harness with real React 18 UMD + mocked engine fetch |
| `plugins/.../native-editor/preview.js` | Harness mock routes and mount call |
| `plugins/.../native-editor/test/native-editor.test.mjs` | Browser-free node:test contract |

## Test command

```bash
node --test plugins/opentake-studio-route-b/native-editor/test/native-editor.test.mjs
```

Current result: 14 tests pass (IPC routes/payloads, errors, store lifecycle,
move/undo, failure retention, locale, CSS isolation, mount/unmount, entry abort,
defensive DTO helpers, served bundle production contract, inspector/track apply
commands, export request shape/progress, settings/storage mutation, locale key
parity).

```bash
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
```

The DSH shell harness still has 11 passing tests, including the native/iframe
toggle, default iframe body and native host presence, dictionary parity and
bundle URL.

## Bundle build and serving

```bash
node plugins/opentake-studio-route-b/native-editor/build-bundle.mjs
```

Output: `plugins/opentake-studio-route-b/web/native-editor/native-editor.js`
(ES module, React 18 + ReactDOM bundled, production build, ~256 KB / ~67.5 KB
gzip). The existing Host static route serves it as:

```
/opentake-studio-route-b/app/native-editor/native-editor.js
```

`web/native-editor/**` is explicitly included in the package `files`. No package
export is needed because the shell loads it as a same-origin static ESM file.

## Browser harness

The harness uses the real React 18 UMD builds from `web/node_modules`, the real
native source modules and a mocked fetch layer (a static server cannot expose
the DSH Host `/engine` routes):

```bash
cd <repo>
python3 -m http.server 8877 --bind 127.0.0.1
# home
open 'http://127.0.0.1:8877/plugins/opentake-studio-route-b/native-editor/preview.html'
# editor layout
open 'http://127.0.0.1:8877/plugins/opentake-studio-route-b/native-editor/preview.html?view=editor'
```

Headless proof used Chrome 157 at 1280×800:

- `/tmp/native-editor-harness.png` (home)
- `/tmp/native-editor-editor.png` (media + preview + timeline)

Both render inside the ShadowRoot. This harness mocks the engine fetch; the live
DSH integration below uses the real Host routes.

## Shell integration (applied)

`plugins/opentake-studio-route-b/ui/client.js` now:

- keeps the iframe mounted by default (`data-otn-editor="iframe"`);
- renders a hidden native host next to it (`data-otn-editor="native"`);
- exposes a `data-otn-action="toggle-mode"` button (label “原生预览” / “Iframe
  编辑器”) that switches modes without unmounting the iframe;
- lazily imports the served bundle and calls `mountNative({host, base, locale,
  theme})`; the controller is disposed on mode switch, native retry, or panel
  unmount;
- shows `data-otn-native-state="loading|error"` and a native retry action;
- passes the current DSH document language as the native locale and reads an
  optional `data-theme` marker; theme tokens remain inherited from DSH.

The bundle re-exports `mountNative`; it creates its own engine client and
`AbortController`, so switching back to iframe aborts in-flight `/engine`
requests and unmounts React/ShadowRoot resources.

## Live CDP verification

Verified against the authenticated DSH Web GUI at **http://127.0.0.1:56474/**
(headless Chrome CDP on 9333, branch `feat/dsh-rust-engine`):

- Opened `OpenTake（原生）` and switched to `原生预览`; ShadowRoot mounted with
  style + React root and no native exceptions.
- Opened `/tmp/routeb-native-panels.opentake` (created through the live engine
  IPC with a local color-bar PNG), one video track/clip.
- Inspector: selected the clip and changed opacity through the native field;
  the live `/engine/timeline` returned `opacity: 0.42`. Track mute toggled in
  the native inspector; live timeline returned `muted: true`.
- Export: opened the native panel, set output path `/tmp/routeb-native-live-export.mp4`,
  h264/720p/8-bit, range start 0/end 1; the live export completed and returned
  `{width:1280,height:720,fps:30,frameCount:1,hasAudio:false,hdr10:false}`.
  CDP Network captured the exact request body:
  `{"cmd":"export_video","args":{"req":{"outPath":"/tmp/routeb-native-live-export.mp4","codec":"h264","quality":"720p","rangeStartFrame":0,"rangeEndFrame":1,"bitDepth":8,"duckMusic":false,"hdr10":false},"operationId":"native-export"}}`.
- Settings: opened the native settings sheet; live storage showed `thumbnails
  210 KB`, search model `ready · siglip2-base-patch16-256`, transcription
  `not configured`, and search-index JSON.
- Fallback: switched back to `Iframe 编辑器`; iframe `display:block`, native host
  `display:none`, ShadowRoot children 0. Then toggled native again and it
  remounted cleanly.
- No native-editor exceptions; only DSH's pre-existing
  `Failed to apply window size` console message.
- Screenshot: `/tmp/native-editor-export-live.png` (native export sheet over
  the native editor). Inspector/settings behavior is recorded above as live
  engine/UI values; the earlier home/editor screenshots remain under `/tmp`.

## Remaining integration notes

- React/ReactDOM are bundled (not externalized) in the served artifact, so the
  shell does not depend on a second React module-table entry; the rebuilt bundle
  is ~256 KB / ~67.5 KB gzip.
- The toggle is opt-in; iframe remains default until the native milestone is
  accepted. Do not switch the default without a follow-up.
- DSH theme changes are inherited through tokens; there is no explicit live
  locale/theme subscription beyond the value read at mount time. Remount the
  native preview after changing language/theme until that adapter lands.
- `/engine/asset` remains an absolute-path/no-Range prototype route.

## Tauri shim scoping

The native path deliberately does **not** install `window.__TAURI_INTERNALS__`
and does not load `web/tauri-shim.js`. It talks to the Host through
`web/src/native/ipc.js` (same-origin fetch), so a future native shell cannot
leak a global Tauri shim or let the iframe's shim affect DSH. If shared app
components are reused later, their Tauri calls must go through an adapter passed
into the mount/component tree, not a page-global shim. The existing iframe's Tauri
shim and asset/dialog/event behavior are untouched.

## What is still iframe-only

- Full editor: inspector/properties, effects, captions, keyframes, export,
  settings, account/storage, motion studio, agent panel, library.
- Playback engine and native compositor playback; this prototype only requests
  preview frames.
- Media import/drag/drop, native dialogs, save-as flows, project mismatch/update
  dialogs, keyboard shortcuts, full menu/native window behavior.
- Existing app stores, event sync and all Tauri-specific commands. The native
  prototype intentionally has its own small store and a bounded UI.
- The existing iframe remains the only path that currently renders the complete
  working editor.

## Remaining blockers / follow-ups

- **Feature parity:** bounded native shell is not the full editor; keep iframe as
  default until the native milestone is explicitly accepted.
- **Locale/theme reactivity:** the native store receives the document language
  and optional theme marker at mount; a live DSH locale/theme subscription is
  not implemented, so remount after changing language or theme.
- **Asset route:** `/engine/asset` currently accepts an absolute path and has no
  Range support; native thumbnails/video inherit that prototype-only security
  gap.
- **Event model:** no push channel; the native store polls/refreshes rather than
  using a real timeline/media event stream.
- **Bundle maintenance:** `web/native-editor/native-editor.js` is generated by
  `build-bundle.mjs`; rebuild it whenever `web/src/native/**` changes. The bundle
  is included in `files` via `web/**` and the explicit `web/native-editor/**`.
- **Default switch:** changing the iframe default to native remains a product
  decision; the toggle already leaves the fallback intact.
