# Native editor body prototype (Route B)

Status: bounded native-mount prototype, 2026-11-08, branch
`feat/dsh-rust-engine`. **Not wired into the active DSH shell.** The working
iframe editor body remains unchanged and is still the default; this directory is
the evidence and integration source for the next step.

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
| `plugins/.../native-editor/entry.js` | Source entry for the future client bundle; owns AbortController |
| `plugins/.../native-editor/preview.html` | Browser harness with real React 18 UMD + mocked engine fetch |
| `plugins/.../native-editor/preview.js` | Harness mock routes and mount call |
| `plugins/.../native-editor/test/native-editor.test.mjs` | Browser-free node:test contract |

## Test command

```bash
node --test plugins/opentake-studio-route-b/native-editor/test/native-editor.test.mjs
```

Current result: 9 tests pass (IPC routes/payloads, errors, store lifecycle,
move/undo, failure retention, locale, CSS isolation, mount/unmount, entry abort,
defensive DTO helpers).

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

Both render inside the ShadowRoot. This proves the React mount/CSS/layout path;
it does not prove live DSH integration because that requires the shared shell
edit and a real Host route.

## Integration patch (not applied)

`client.js` and package exports were **not edited**. The iframe fallback stays
intact. A future integration needs a deliberate shared-file change:

1. **Bundle source with external React.** Build `native-editor/entry.js` +
   `web/src/native/**` into a single client artifact with React externalized
   (React from the DSH module table) and a ReactDOM-client implementation
   available. The current DSH client artifact format does not bundle arbitrary
   relative ES modules at runtime.
2. **Package the artifact.** Add the built native artifact (and only the
   runtime files, not the whole `web/src`) to the plugin `files`; add an
   explicit export only if the client loads it as a second artifact.
3. **Mount through the existing client shell.** Add an explicit native-preview
   action (or feature flag) in `client.js`:
   - keep the iframe as default/fallback;
   - lazily create a host element in the slot;
   - call `createNativeEditorController({host, React, ReactDOM, base, locale, theme})`;
   - on toggle/unmount call `controller.dispose()` and restore the iframe;
   - pass `ctx.locale` and theme/token changes into the native store; do not
     write `documentElement.lang` or global styles.
4. **Live verification:** point the client at the real plugin prefix, exercise
   new/open + media + timeline selection/move + preview against live
   `/engine/*`, then compare with the iframe before switching the default.

The source entry already isolates the client signal:

```js
const controller = createNativeEditorController({
  host,
  React,
  ReactDOM,
  base: '/opentake-studio-route-b',
  locale: ctx.locale,
  theme: 'system',
});
// later
controller.dispose();
```

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

## Blockers before editing shared files

- **Client build/ReactDOM:** need a client-bundle build that externalizes React
  and supplies `react-dom/client`; current client manifest only documents
  `require('react')`.
- **DSH lifecycle/locales:** need live `ctx.locale`/theme propagation and slot
  unmount semantics verified in the Web GUI.
- **Asset route:** `/engine/asset` currently accepts an absolute path and has no
  Range support; native thumbnails/video would inherit that prototype-only
  security gap.
- **Event model:** no push channel; this prototype polls. The full app's
  timeline/media event behavior is not ported.
- **Feature parity:** bounded native shell is not the full editor; do not switch
  the default until the milestone is explicitly accepted and the iframe remains
  available.
- **Package wiring:** adding the native entry/artifact to `package.json`
  exports/files and changing `client.js` is a shared-file step and needs the
  Lead's approval; not done here.
