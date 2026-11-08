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

Current result: 10 tests pass (IPC routes/payloads, errors, store lifecycle,
move/undo, failure retention, locale, CSS isolation, mount/unmount, entry abort,
defensive DTO helpers, served bundle production contract).

```bash
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
```

The DSH shell harness now has 11 passing tests, including the native/iframe
toggle, default iframe body and native host presence, dictionary parity and
bundle URL.

## Bundle build and serving

```bash
node plugins/opentake-studio-route-b/native-editor/build-bundle.mjs
```

Output: `plugins/opentake-studio-route-b/web/native-editor/native-editor.js`
(ES module, React 18 + ReactDOM bundled, production build, ~230 KB / ~62 KB
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

Verified against a temporary DSH web profile on branch `feat/dsh-rust-engine`
(authenticated URL via `/connect?token=...`, headless Chrome 157, CDP on
127.0.0.1:9444):

- Opened the `OpenTake（原生）` panel; engine status showed ready.
- Clicked `原生预览`: ShadowRoot mounted (`children=2`, style + React root),
  no `process is not defined` after the production `NODE_ENV` define.
- Home rendered (engine status, project path, new/open, media count).
- Created/opened a project and clicked `编辑器`: media card, one timeline track
  and one clip rendered.
- Selected a clip and clicked `右移`: engine timeline `startFrame` changed
  0 → 1 and the clip's timeline style changed; `undo`/`redo` actions exist.
- Preview `<img>` loaded `/engine/preview/frame?frame=1...` with
  `complete=true`, `naturalWidth=1280`, `naturalHeight=720`; the route returned
  `200 image/png` (177,515 bytes) and the color-bar image rendered.
- Toggled back to `Iframe 编辑器`: iframe display `block`, native host `none`,
  ShadowRoot children `0`; toggled native again and remounted cleanly.
- Only DSH's pre-existing `Failed to apply window size` console message
  appeared; no native-editor exceptions.
- Screenshots: `/tmp/native-editor-live-home.png`,
  `/tmp/native-editor-live4.png`, plus `/tmp/live-preview.png`.

## Remaining integration notes

- React/ReactDOM are bundled (not externalized) in the served artifact, so the
  shell does not depend on a second React module-table entry.
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
