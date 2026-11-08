# OpenTake Studio

OpenTake Studio is a **pure DeepSeek Harness (DSH) plugin** that puts a small,
working video editor inside the DSH Web UI: project and timeline state, a media
library, a canvas preview, ffmpeg export, and native Agent tools.

There is **no OpenTake or Tauri process**, **no MCP server**, and **no separate
OpenTake binary** involved. Both halves of the editor ship with this plugin:

- **Host half** (`index.js`, `lib/`) runs inside the DSH Host process. It owns
  the project and timeline model, probes and imports media with
  `ffprobe`/`ffmpeg`, serves preview media over same-origin routes, runs the
  ffmpeg export, and registers the Agent tools.
- **Client half** (`client.js`) is a hand-written browser bundle rendered in DSH
  Slots. It provides the editor page: media library, preview canvas, timeline,
  inspector, dialogs and status.

> **Status: MVP / experimental (plugin version `0.1.0`).** The editing loop is
> implemented and verified (see [Verification status](#verification-status)), but
> this is **not feature parity** with the Rust/Tauri OpenTake app. The explicit
> gaps are listed in [Limitations](#limitations-mvp).

- Full design contract: [docs/DESIGN.md](docs/DESIGN.md)
- Repository integration page: [docs/integrations/opentake-studio.md](../../docs/integrations/opentake-studio.md)

---

## Requirements

| Requirement | Details |
|---|---|
| DSH | A DeepSeek Harness build with the Web UI, the `webServer` service and the native `tools` registry (the current DSH desktop/web profile provides all three). |
| Browser | A modern browser with Canvas 2D. The preview draws video frames to `<canvas>`, and text clips are pre-rendered to PNG in the browser before an export. |
| Node.js | No separate install: the Host half runs in the same Node process as the DSH Host. The plugin has no npm dependencies. |
| ffmpeg / ffprobe | Required for media import, thumbnails and export. Both must be executable by the DSH Host process. Resolution order: `OPENTAKE_STUDIO_FFMPEG` / `OPENTAKE_STUDIO_FFPROBE`, then `PATH`. A stale environment override falls back to `PATH`. |

If ffmpeg or ffprobe is missing, the editor still opens and can edit an existing
project, but import, thumbnails and export are reported as unavailable. The
top bar shows `ffmpeg ready` or `ffmpeg missing`.

The export path uses `libx264` for video and `aac` for audio, so the ffmpeg build
must include those encoders.

---

## Install

The plugin is a **local Cordis bundle**, not an npm-registry package. There is
nothing to build: `index.js`, `client.js` and `lib/*.js` are plain ESM/browser
JavaScript, and `package.json` has no dependencies and no install or build
scripts.

### Install with the `plugin_manager` tool

In DSH, invoke the `plugin_manager` tool with:

- action: `install_bundle`
- target: the **absolute** path to this folder, for example
  `/Users/you/OpenTake/plugins/opentake-studio`

The current profile should then report a bundle named `@opentake/studio`
(version `0.1.0`) as installed and enabled. In this checkout the installed
source is the local link `link:/…/OpenTake/plugins/opentake-studio`.

If the editor does not appear after installation, reload the DSH Web UI once.
The profile applies the bundle to the running Host and Client; the left sidebar
entry and settings section are client registrations.

---

## Open the editor

- Click **OpenTake Studio** in the DSH left sidebar (`sidebar.panellist`
  registration, id `opentake-studio`, order 15). This is the full editor panel.
- The same plugin also registers a **Settings → OpenTake Studio** section with
  dependency and shortcut notes (`settings.section`, order 25).
- The main editor view is registered under the `main` Slot with key
  `opentake-studio`.

The first screen is a welcome card with **New project** and **Open project**.
Project state is held by the Host plugin, so the editor, the Agent tools and any
other DSH tab pointed at the same Host see the **same open project**.

---

## User workflow

### Create or open a project

1. **New** (or **New project** on the welcome card) opens the new-project dialog.
2. Use **Browse…** to pick a folder with the DSH native directory picker, or type
   an **absolute path** if the picker is unavailable.
3. Optionally set a project name, then **Create project**. The chosen folder
   becomes the project root. The plugin creates `media/`, `thumbnails/` and
   `exports/` inside it and writes `opentake-studio.json`.
4. **Open** works the same way and expects a folder that already contains
   `opentake-studio.json`.

A project folder can only be created once; choosing a folder that already has
`opentake-studio.json` returns a `project-exists` error instead of overwriting it.
The project frame rate and resolution are fixed when the project is created in
this MVP; the inspector shows them read-only. Defaults are 30 fps and
1920 × 1080; the accepted frame rates are 24, 25, 30, 50 and 60.

### Import media

- Click **Import folder** and choose an **absolute** folder. The folder is
  scanned recursively; hidden entries, symlinks and nested directories named
  `media`, `thumbnails` or `exports` are skipped.
- Supported files are probed with `ffprobe`, copied into `media/` (hard-linked
  when the filesystem supports it, otherwise copied), and added to the media
  library. A thumbnail is generated on first display.
- Files are classified by extension first (common video, audio and image
  containers). A file that cannot be probed is skipped rather than imported.
- Duplicate imports are skipped when an existing project media item has the same
  source file name and byte size. This is a name+size check, not a content hash.
- You can also drag files from your desktop onto the media panel. Dropped files
  are uploaded to the project through the Host upload route (bounded at 2 GiB per
  request) and then probed like folder imports.

Importing only fills the media library; it does not add clips to the timeline.

> Hard-linked imports share their inode with the source file. Avoid editing the
> original media in place while the project is using it; the project file and
> the source would both change.

### Put media on the timeline

- Click the **+** button on a media card, or **double-click** the card, to add the
  media at the current playhead on the first compatible track.
- Drag a media card onto a specific track to add it at the drop frame.
- If no compatible track exists, a video or audio track is created automatically.
  Video/image clips go to video tracks; audio clips go to audio tracks.
- Adding or moving a clip never creates an overlapping stack on the same track:
  the model overwrites, trims or splits the existing clip according to the
  overwrite rules in the design contract.
- Images have no intrinsic duration. When duration is omitted, an image clip
  defaults to 5 seconds (150 frames at 30 fps).

### Timeline editing

- **Select** a clip by clicking it.
- **Move**: drag the clip horizontally; drop it on another compatible track to
  move it across tracks.
- **Trim**: drag the left or right edge of a clip. Trimming a video/audio clip
  also adjusts its source in-point.
- **Seek**: click or drag on the ruler. The playhead position is the current
  frame.
- **Delete**: select a clip and press `Delete`/`Backspace`, or use **Delete clip**.
- **Split**: place the playhead strictly inside the selected clip and press
  `Cmd/Ctrl+K`, or use **Split at playhead**.
- **Add text**: use **Add text**; a 3-second text clip is created at the playhead
  on a dedicated text track. Text clips are overlays on a separate video track so
  they do not overwrite footage.
- **Tracks**: use **Add video track** / **Add audio track**. In this MVP the UI
  does not expose track deletion, renaming, mute or hide; those exist in the data
  model and are honored by export when present.
- **Zoom**: `−` / `+` buttons, **Fit**, or `Cmd/Ctrl` + mouse wheel. A plain mouse
  wheel scrolls the timeline horizontally.

Timeline frames are project frames. There is no clip speed control in this MVP;
`speed` is fixed at `1`.

### Preview

- **Space** plays/pauses; the transport also has **Loop** and a preview volume
  slider.
- The preview canvas shows the composited frame at the playhead, using hidden
  `<video>`, `<audio>` and `<img>` elements for the media, and draws with Canvas
  2D. Audio playback follows the active audio/video clips and their volumes.
- Click the ruler to seek; the frame/timecode display follows the project fps.
- The preview is an **approximate composite**. The ffmpeg export is
  authoritative. Some browser codecs may not decode even when ffprobe can read
  the file.

### Inspector

- With a clip selected, the inspector edits volume, opacity and transform
  (`x`, `y`, `width`, `height`, `rotation`). Transform values are normalized
  `0..1`; `x`/`y` are the top-left corner and rotation is in degrees.
- Text clips additionally expose content, font size, color, weight and alignment.
- Timing (start, duration, source offset, end) is read-only in the inspector;
  edit timing by dragging clips and clip edges on the timeline.
- With nothing selected, the inspector shows read-only project settings.

### Undo, redo and saving

- `Cmd/Ctrl+Z` undoes and `Shift+Cmd/Ctrl+Z` redoes. The undo stack keeps up to
  100 project snapshots and is reset when a project is created or opened.
- Every edit is auto-saved. Saving is debounced by 250 ms and uses an atomic
  write (temporary sibling file + rename). **Save** forces a save immediately.
- Save failures are surfaced as a banner; they are not silently discarded.

### Export

1. Click **Export**. The export dialog suggests
   `<project-name>-<timestamp>.mp4`.
2. Choose an absolute output path, or leave it empty to write into the project's
   `exports/` folder. A non-empty path must be absolute (or at least contain a
   path separator); otherwise the dialog reports an error.
3. For every text clip, the client renders the text to a transparent PNG on an
   offscreen canvas and `POST`s it to `text/render`. This is why a browser client
   must be open when a text-bearing export starts from the UI.
4. The Host starts an asynchronous ffmpeg export. The top bar shows progress;
   **Cancel export** aborts the running job.
5. The result is an MP4 at the project resolution and fps, encoded as H.264
   (`libx264`, `yuv420p`) with AAC audio when audio is present. If the timeline
   has no visual clips, the output is black video for the timeline duration. If
   it has no audio, the export is video-only (`-an`).

Only the plugin's own output is written; the source media is not modified.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Space` | Play / pause |
| `Delete` / `Backspace` | Delete the selected clip |
| `Cmd/Ctrl+Z` | Undo |
| `Shift+Cmd/Ctrl+Z` | Redo |
| `Cmd/Ctrl+K` | Split the selected clip at the playhead |
| `Cmd/Ctrl` + wheel | Zoom the timeline |
| Wheel | Scroll the timeline horizontally |

Typing in an input or textarea suppresses the editor shortcuts.

---

## Agent tools

The plugin registers **native DSH tools** through `ctx.tools.register`. They use
the same service functions as the UI, so an agent edit appears in the editor on
its next state poll (about 1 second), and both share the same undo history. No
MCP endpoint, client or credential is involved.

| Tool | Arguments | Behavior |
|---|---|---|
| `opentake_studio_get_state` | — | Returns a project summary: name, fps, resolution, total duration frames, media and tracks/clips. Call before editing. |
| `opentake_studio_list_media` | — | Returns the imported media list (id, name, kind, dimensions, duration frames). |
| `opentake_studio_new_project` | `path`, `name?`, `fps?`, `width?`, `height?` | Creates a project at an absolute folder path. |
| `opentake_studio_open_project` | `path` | Opens the folder containing `opentake-studio.json`. |
| `opentake_studio_import_media` | `path` | Imports every supported media file in an absolute folder; returns imported and skipped paths. |
| `opentake_studio_add_clip` | `mediaId`, `startFrame`, `trackId?`, `durationFrames?`, `trimStartFrame?` | Adds a media clip. Omit `trackId` to use/create the first compatible track. `durationFrames` defaults to the remaining source length. |
| `opentake_studio_move_clip` | `clipId`, `startFrame`, `trackId?` | Moves a clip. Existing clips are trimmed or split on overlap. |
| `opentake_studio_trim_clip` | `clipId`, `durationFrames?`, `trimStartFrame?` | Changes duration and/or source in-point. |
| `opentake_studio_split_clip` | `clipId`, `atFrame` | Splits at an absolute project frame strictly inside the clip; returns the left and right clip ids. |
| `opentake_studio_remove_clips` | `clipIds` | Removes one or more clips in one undoable edit. |
| `opentake_studio_set_clip_properties` | `clipIds`, `volume?`, `opacity?`, `transform?` | Sets volume/opacity (`0..1`) and/or normalized transform. |
| `opentake_studio_add_text` | `content`, `startFrame`, `durationFrames?`, `trackId?`, `fontSize?`, `color?`, `x?`, `y?` | Adds a text overlay; `durationFrames` defaults to 90 frames, `x`/`y` are normalized top-left coordinates. Uses or creates a `Text` video track with a free interval. |
| `opentake_studio_undo` | — | Undoes the most recent edit. |
| `opentake_studio_redo` | — | Redoes the most recently undone edit. |
| `opentake_studio_export` | `path?`, `overwrite?` | Starts an asynchronous ffmpeg export; omit `path` to write into `exports/`. An existing output is refused unless `overwrite:true`. Poll `get_state` for progress. |

### Frames and fps

- All frame values are **integer project frames** at `project.fps` (one of
  24/25/30/50/60). Seconds = `frames / fps`.
- `startFrame` is the clip's position on the timeline. `durationFrames` is its
  length. `trimStartFrame` is the source in-point, also expressed in project
  frames.
- Image clips have no source length; their duration is whatever is supplied (or
  the 5-second default when omitted).
- The export duration is the maximum `startFrame + durationFrames` across the
  timeline; an empty timeline cannot be exported.
- `transform` is normalized: `x`/`y` are the top-left corner in `0..1`,
  `width`/`height` are fractions of the project frame, and `rotation` is in
  degrees. The `add_text` tool accepts only `x`/`y`; use
  `set_clip_properties` for the full transform.

---

## Project storage

A project is a folder owned by the user. Everything the plugin needs lives
inside it:

```
<projectRoot>/
├── opentake-studio.json   # canonical Project JSON (version 1), atomic writes
├── media/                 # imported media files (<uuid>-<safeName>)
├── thumbnails/            # <mediaId>.jpg thumbnail cache
├── renders/               # <clipId>.png browser-rendered text, created on export
└── exports/               # default export output
```

- `opentake-studio.json` is plain JSON and is the source of truth. It is written
  atomically, so a crash or concurrent reader never sees a half-written file.
- `media/` uses sanitized, generated names. The original name is preserved in the
  project's `media[].name` field.
- `thumbnails/` and `renders/` are generated caches; deleting them is safe, and
  they will be regenerated as needed.
- There is one open project per DSH Host process. Opening or creating another
  project replaces the in-memory state and clears the undo stack.
- The project file can be copied or backed up like any other folder. Keep the
  `media/` directory with it; media references are relative to the project root.

---

## Security and trust

- **Same-origin only.** All routes are mounted under `/opentake-studio` on the
  DSH web server. Every request passes through `connection.requestRejection`
  first. If that service is unavailable, the handler responds `503` and serves
  nothing (fail-closed).
- **No MCP credentials or MCP endpoint.** Agent tools are registered in the DSH
  native tool registry; there is no second network service, token or pairing.
- **No remote calls.** Media probing/export spawn local `ffmpeg`/`ffprobe`
  processes. The Host performs no network requests, and the plugin has no
  telemetry.
- **No shell.** `ffmpeg` and `ffprobe` are spawned with an argument vector
  (`child_process.spawn`), never through a shell string.
- **Bounded input.** JSON bodies are limited to 1 MiB (16 MiB for the text-render
  route), the text PNG is limited to 8 MiB, and uploads are limited to 2 GiB.
- **Path confinement.** Media reads resolve inside `<projectRoot>/media/`; path
  traversal, absolute media names and backslash separators are rejected. The
  import scanner ignores hidden entries, symlinks and special files.
- **User-owned data.** The project is plain JSON plus media in a folder the user
  chose; the plugin stores no credentials in it.
- **Host permissions.** All file and process operations run with the DSH Host's
  user permissions. A project folder may be anywhere the Host user can read and
  write, so only open folders you trust.

---

## Limitations (MVP)

This is a deliberately small, verifiable editing loop, not a full NLE. Known
gaps:

- **No advanced editing features:** no transitions, keyframes, effects, speed
  changes, color grading, multicam, Lottie/Motion, AI generation, transcription,
  semantic search or media library folders.
- **Preview is approximate.** The canvas composite is for interaction, not a
  frame-accurate reference. Export is authoritative. Browser codec support can
  differ from ffmpeg.
- **Rotation previews but does not export.** The inspector can set rotation and
  the preview applies it, but the ffmpeg overlay path does not rotate clips.
- **Text export depends on the client.** UI export pre-renders text to PNGs in
  the browser, so a browser client must be open when export starts. If no PNG
  exists (for example, an agent calls `opentake_studio_export` directly), export
  falls back to ffmpeg `drawtext` with a system font; that fallback does not wrap
  text the same way the canvas renderer does.
- **Audio is basic.** A video clip's source audio is included when the media has
  audio and the track is not muted; audio clips are mixed with their clip
  `volume`. There are no fades, ducking, gain automation, or separate track
  effects. Only `clip.volume` is applied; the preview monitor volume is not part
  of the export.
- **One output format.** Export is H.264/AAC MP4 at the project resolution/fps.
  There are no ProRes/H.265/WebM variants, resolution presets, or audio-only
  exports.
- **One project, one export.** The Host holds one open project and one running
  export at a time; starting another export while one runs returns
  `export-running`.
- **Project settings are fixed.** Fps and resolution are set at creation; the UI
  does not edit them afterwards.
- **Track controls are minimal.** The UI can add tracks but does not expose
  deleting, renaming, muting or hiding them, even though the model and export
  understand `muted`/`hidden`.
- **Undo is in memory.** Up to 100 snapshots are kept per Host process; they are
  lost on restart, and history resets when a project is opened.
- **No signed standalone app.** DSH is the host process. This plugin has no
  separate desktop application or installer to sign; it is installed into a DSH
  profile.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ffmpeg missing` in the top bar; Import is disabled | `ffmpeg`/`ffprobe` are not executable by the Host. Install them on `PATH` for the DSH Host, or set `OPENTAKE_STUDIO_FFMPEG` / `OPENTAKE_STUDIO_FFPROBE` to absolute executable paths and restart DSH (the resolved tools are cached per process). |
| `Could not reach the OpenTake Studio Host routes` | The plugin is not applied, or the client is stale. Confirm the bundle is installed and enabled (`plugin_manager`, bundle `@opentake/studio`), then reload the DSH page. |
| `A project already exists in this folder` | That folder already contains `opentake-studio.json`. Open it instead, or choose a new folder. |
| `No OpenTake Studio project was found in this folder` | The selected folder must contain `opentake-studio.json`; open the project root, not a parent or the `media/` folder. |
| `The project file is invalid` | `opentake-studio.json` is not valid JSON or does not validate. Restore a backup or fix the JSON; invalid projects are not overwritten. |
| **Browse…** is unavailable in a dialog | The native directory picker is not available in this client. Type an absolute Host path instead; the dialog shows the same hint. |
| An import skips files | Unsupported extension, unreadable/corrupt media, a symlink/hidden file, or a duplicate name+size already in the project. The import result reports how many were skipped; successful files are still imported. |
| Export fails | Check that a clip exists, ffmpeg is available, the output folder is writable, and text rendering succeeded. The error banner includes the Host/ffmpeg message. |
| Preview is black at a frame | There may be no visual clip at that frame (`No visual clips at this frame`), or the browser cannot decode the media. Try another frame or re-encode the source media. |
| The export dialog rejects the output path | Use an absolute file path or leave the field empty. A bare file name is rejected. |

---

## Development and verification

### Checks

From the repository root:

```bash
cd plugins/opentake-studio
node --test test/                     # 163 tests: model, project, media, export, host routes/tools
node --check index.js
node --check client.js
node --check lib/model.js
node --check lib/project.js
node --check lib/media.js
node --check lib/export.js
```

The package also defines `check` and `test` scripts in `package.json`; the
commands above are the ones this verification exercised.

Documentation link checks are repo-wide:

```bash
python3 scripts/check_docs.py
```

### Verification status

Verified on **2026-11-08** on branch `feat/dsh-native-studio` (plugin version
`0.1.0`). The test-suite and installed-bundle rows were re-checked while writing
this document; the Client/UI/export rows are the verification run's results.

| Evidence | Result |
|---|---|
| Node test suite | **163/163 tests pass**, 18 suites, 0 failures (141 model/project/media/export + 22 host integration). Re-run for this document with `node --test test/`. |
| Bundle installation | `@opentake/studio` is installed in the DSH profile as a local link, enabled and active (`plugin_manager` inventory). |
| Client registration | DSH Client Slots expose `main` and `sidebar.panellist` with key/id `opentake-studio`; the left-sidebar **OpenTake Studio** editor panel was screenshot-verified. |
| Preview | A real video frame renders in the editor preview; the media route served HTTP **Range 206** partial content. |
| Host routes | Project create, media import, add clip and add text were exercised through the Host routes. |
| Agent tools | `opentake_studio_get_state`, `opentake_studio_add_text`, `opentake_studio_remove_clips` and `opentake_studio_export` were called live. |
| UI export | The export dialog ran; a text PNG was posted, and ffmpeg produced an MP4 at **1280×720, H.264 + AAC, 2.0 s**; the exported frame shows the text overlay. |

Not verified / not claimed:

- There is no separate signed desktop application. DSH is the host; the plugin is
  installed into a DSH profile and has no standalone installer or signature.
- Real human drag interactions beyond the automated checks were not exhaustively
  verified.
- Full feature parity is not implemented: transitions, keyframes, effects,
  rotation in export, generation, transcription and semantic search are absent
  (see [Limitations](#limitations-mvp)).

---

## Related documentation

- [Design contract](docs/DESIGN.md) — data model, routes, algorithms and the
  original implementation contract.
- [Repository integration page](../../docs/integrations/opentake-studio.md) —
  how this plugin fits the OpenTake repository and the end-to-end verification
  contract.
- [Documentation index](../../docs/INDEX.md)
- [Repository README](../../README.md)
