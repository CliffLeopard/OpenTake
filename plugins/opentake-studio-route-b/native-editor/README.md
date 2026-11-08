# Native editor body prototype (Route B)

Status: **wired as an optional native preview** in the DSH shell, 2026-11-09,
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
- Inspector tabs: properties, effects, keyframes, masks and advanced; selected
  clip/track opacity/volume/transform, text content, track mute/hide/sync-lock,
  color grade (exposure/temperature/tint/contrast/saturation), LUT reference
  form, chroma key (key color/similarity/smoothness/spill), text style controls,
  and mask transform/polygon-points editing via the existing apply commands.
- Export: codec, quality, bit depth, frame range, duck-music and HDR10 controls
  invoking the existing `export_video` IPC; progress polling via
  `/engine/export/status`; summary/error display.
- Settings: engine info, storage categories (cache clear), search/transcription
  model status and search-index status from existing `invoke` commands.
- Effects: engine registry (`grayscale`/`sepia`/`invert`) add/remove/enable and
  amount via `setEffects`.
- Captions: list caption clips, create with `addCaptions`, edit text/timing with
  `setClipProperties` + `moveClips`.
- Keyframes/masks: list/add/remove scalar keyframes (`opacity`/`volume`/
  `rotation`), show pair/crop tracks, client-side interpolation readout; add
  rectangle/ellipse masks with feather/invert via `setMasks`.
- Playback: play/pause/stop/seek through existing `playback_start`,
  `playback_pause`, `playback_seek`, `playback_stop` and
  `/engine/playback/status`; preview frame follows playback.
- Media import: path-entry import through `/engine/import-media` and media
  library refresh; a native file input is offered but browsers do not expose an
  absolute path, so it reports the limitation and leaves path entry as the
  usable route (no drag/drop upload route exists).
- Keyboard shortcuts: scoped to the native root — Space play/pause, arrows seek,
  Shift+arrows nudge, Delete removes, Cmd/Ctrl+Z/Shift+Z undo/redo, Cmd/Ctrl+S
  save, Cmd/Ctrl+E export, `?` shortcut-help overlay.
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

Current result: 19 tests pass (IPC routes/payloads, errors, store lifecycle,
move/undo, failure retention, locale, CSS isolation, mount/unmount, entry abort,
defensive DTO helpers, served bundle production contract, inspector/track apply
commands, export request shape/progress, settings/storage mutation, effects/
masks/keyframes commands, caption create/update, media import + playback,
advanced color/LUT/chroma/text/remove commands, locale key parity and
keyframe/caption helpers).

```bash
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs
```

The DSH shell harness still has 11 passing tests, including the native/iframe
toggle, default iframe body and native host presence, dictionary parity and
bundle URL. Combined native + shell suite: **30/30**.

## Bundle build and serving

```bash
node plugins/opentake-studio-route-b/native-editor/build-bundle.mjs
```

Output: `plugins/opentake-studio-route-b/web/native-editor/native-editor.js`
(ES module, React 18 + ReactDOM bundled, production build, ~301 KB / ~76.9 KB
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
- Effects: added `grayscale` from the Inspector; live timeline returned
  `effects:[{name:"grayscale",params:{amount:1},enabled:true}]`.
- Masks: added an ellipse; live timeline returned `masks:[{shape:{kind:"circle",
  center:{x:0.5,y:0.5},radius:{x:0.3,y:0.3}},feather:0,invert:false}]`.
- Keyframes: added an opacity keyframe at frame 0; live timeline returned
  `opacityTrack:{keyframes:[{frame:0,value:1,interpolationOut:"smooth"}]}`.
- Captions: created `Native caption line` at 30+45 via `addCaptions`; live
  timeline showed the text clip/caption group. Edited it to
  `Edited native caption` at 40+50 through `setClipProperties` + `moveClips`.
- Media import: imported a distinct local image through the native path field;
  `/engine/media` grew from 1 to 2 items and the media panel rendered 2 cards.
- Playback: play showed `data-otn-playback="playing"` and the UI frame advanced
  (frame 59 while engine status frame 62); pause showed `paused`; stop returned
  `idle`.
- Advanced Inspector: switched to the `advanced` tab. Applied a color grade
  through the form; live timeline returned `colorGrade:{exposure:0.5,
  temperature:0,tint:0,contrast:0.2,saturation:1.3,...}`. Applied chroma key;
  live timeline returned `chromaKey:{keyColor:{r:0,g:1,b:0},similarity:0.2,
  smoothness:0.35,spill:0.5}`. Applied text style; live timeline returned
  `textStyle:{fontName:"Helvetica-Bold",fontSize:42,...}`.
- Advanced masks: added a rectangle mask and changed its transform; live timeline
  returned `masks:[{shape:{kind:"poly",points:[...]},...,transform:{offset:{x:0,
  y:0},scale:{x:1.2,y:1},rotationDegrees:0}}]`.
- Keyboard shortcuts: focused the native root and dispatched keys. Space started
  playback (`data-otn-playback="playing"`, frame 30), second Space paused
  (`paused`); Right arrow seeked and Shift+Right nudged the selected clip to
  `startFrame:1`; Delete removed the clip (live clips 0) and Ctrl+Z restored it
  (1). `?` opened the shortcuts help overlay with the full list.
- LUT controls render and are unit-tested for the exact `setLut` request; no
  live LUT was applied because the test project has no real 64-hex LUT asset.
- File picker: the native file input is rendered; browser file objects expose no
  absolute path, so it reports `filePathUnavailable` and path entry remains the
  usable import route. Drag/drop upload is not available without a Host upload
  endpoint.
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
  is ~301 KB / ~76.9 KB gzip.
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

- Advanced inspector parity beyond the bounded forms: LUT asset management,
  full text/caption style controls (shadow/background/border/font scale), full
  keyframe property/curve editing and effect parameter coverage beyond
  `grayscale`/`sepia`/`invert`.
- Interactive mask pen tool; the native mask panel supports rectangle/poly and
  ellipse plus transform fields and JSON polygon points, not a canvas pen.
- Full playback/pipeline parity, native audio edge cases, export dialogs.
- Media file-picker/drag-drop upload, native dialogs, save-as flows, project
  mismatch/update dialogs, full menu/window behavior. Basic native keyboard
  shortcuts are implemented; the full app shortcut set is still iframe-only.
- Motion studio, library and agent panels: no native routes/components in this
  slice; they remain explicit iframe-only surfaces.
- Account/storage settings beyond the bounded status panel, motion studio,
  agent panel, library.
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
- **Event model:** no push channel; the native store polls/refreshes and polls
  playback status rather than using a real timeline/media event stream.
- **Advanced LUT:** the LUT form requires a real project LUT asset/64-hex id;
  there is no LUT picker route in this slice.
- **File picker/drag-drop:** the DSH Web browser does not expose an absolute
  file path for File objects and there is no upload route, so only path entry can
  feed `/engine/import-media`; the native file input reports this limitation.
- **Bounded panel behavior:** effects are limited to the engine registry;
  captions use one default style and only content/timing edits; masks support
  rectangle/polygon and ellipse plus feather/invert but not the pen tool or
  advanced mask transforms; media import is path-entry only (no file picker or
  drag/drop); playback preview follows a 200 ms status poll and may lag one or
  two frames behind the engine clock.
- **Bundle maintenance:** `web/native-editor/native-editor.js` is generated by
  `build-bundle.mjs`; rebuild it whenever `web/src/native/**` changes. The bundle
  is included in `files` via `web/**` and the explicit `web/native-editor/**`.
- **Default switch:** changing the iframe default to native remains a product
  decision; the toggle already leaves the fallback intact.
