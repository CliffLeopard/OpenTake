# OpenTake Studio — independent host review & findings

| | |
|---|---|
| Reviewer | verifier (independent; wrote only `test/host.test.mjs` + this file) |
| Branch / plugin | `feat/dsh-native-studio` · `plugins/opentake-studio/` |
| Reviewed snapshot (sha256) | index.js `cf192c6c…` · client.js `d267c7ba…` · lib/export.js `55196681…` · lib/media.js `87c7c4cd…` · lib/model.js `c1b401a7…` · lib/project.js `5584952a…` |
| Suite | `node --test plugins/opentake-studio/test/` → **163/163 pass** (141 existing + 22 new `host.test.mjs`), stable across runs |
| Not done (constraints) | bundle not installed, profile untouched, no live GUI/browser driven |

Implementation changed while this review was in progress (Lead/editor-ui were still editing). This report and the new tests are against the snapshot above; the review was re-run after those edits.

## 1. Verified claims (evidence)

**Host integration (new `test/host.test.mjs`, 22 tests, fake Cordis ctx, real ffmpeg/ffprobe).** The fake host mirrors the live DSH contracts (`tools.register` fails on duplicates and returns the disposer; `webServer.register({kind:'prefix'})`; `ctx.effect`; `connection.requestRejection`), so `index.js` runs unmodified.

- Tool surface: exactly one prefix route at `/opentake-studio` and 14 native tools (`opentake_studio_get_state/new_project/open_project/import_media/add_clip/move_clip/trim_clip/split_clip/remove_clips/set_clip_properties/add_text/undo/redo/export`), each with `description`, object `parameters` (`additionalProperties:false`), `output.schema`/`output.render`, and `execute`; disposal unregisters all of them.
- Pure-DSH: host/lib imports are only `node:*` + relative modules; no `child_process` in `index.js`; only `spawn(tools.ffmpeg/ffprobe)` in `lib/media.js` (argv only, no shell); client bundle requires only `react`; no MCP/OpenTake binary references (only negating prose in comments/locale); no npm dependencies.
- Client: `window.__ModuleLoader__.load`, `main` (key) + `sidebar.panellist` (order 15) + `settings.section` registrations, one scoped `.ots-` stylesheet using `--dsw-alias-*` tokens (single hardcoded `#000` is the video-canvas backdrop), locale dictionaries, inject is `['slots','locale']` with optional `uiWorkspace`/`__DSH_DIRECTORY_PICKER__` directory picker. All client route names match host routes.
- Routes/lifecycle: no-project → 409 `no-project`; create/save/open project, `project-exists` 409, `project-not-found` 404, malformed project 400 `invalid-project`; requestRejection honoured for JSON and byte routes; **fail-closed 503 when `connection.requestRejection` is missing**; JSON body cap 1 MiB → 413; manual-media byte route 200/206/416 + HEAD, suffix/open-ended/clamped ranges, non-`bytes` range ignored (full 200); crafted `media.fileName: '../escape.mp4'` → 400 (filesystem traversal blocked); thumbnails JPEG + cache + audio placeholder; upload stores bytes under `media/` with basename sanitisation; text render stores `renders/<clipId>.png`, rejects non-PNG/missing clip/unsafe id (400) and decoded >8 MiB (413); export video-only MP4 verified with ffprobe (h264, 320×180, no audio, ~2 s), text overlay via browser-rendered PNG, explicit output path, `export-running` 409, cancel → idle + partial output removed, async missing-media failure lands in `export.state=error`, empty timeline → 400; save failure (EACCES) surfaces in `saveError` without losing the in-memory edit; missing ffmpeg → `/state.ffmpeg.available=false`, export route/tool → 503 `ffmpeg-unavailable`.
- Model errors now map to 400 (`ModelError` branch in `index.js:755-763`), e.g. `out-of-bounds`, `invalid-split`, `track-not-found`; `unsupported-fps` on project creation → 400.
- Areas the code protects: media file path validation (`lib/media.js:803-826`), thumbnail id sanitisation (`lib/media.js:828-837`), upload basename + UUID prefix (`index.js:401-407`), Range parsing (`index.js:108-127`), process invocation without a shell (`lib/media.js:269,409`), filtergraph escaping for `drawtext` (`lib/export.js:117-140`), atomic project writes (`lib/project.js:125-137`).
- No token/secret material exists in this plugin (there is no auth token). `StateResponse` does expose absolute local paths (`projectRoot`, ffmpeg binary paths, media file names) to the same-origin authenticated UI, which is by design for a local editor.

## 2. Findings (ordered by severity)

No Critical/High code defects remain in this snapshot. Two concrete issues were found during review and fixed before this report: (a) text-render/export wrote `renders/<clipId>.png` with an unvalidated clip id, allowing `../` traversal for a crafted project file — now rejected by the safe-identifier check at `index.js:643-645` (test pins 400 + no file written); (b) model errors returned 500 with raw codes — now 400 via `index.js:755-763`. The client's directory picker also moved from a hard `uiWorkspace` inject to an optional lookup/fallback (`client.js:3451-3470, 3511`). Everything below is against the fixed snapshot.

### Medium

**M1. Native tools accept arbitrary absolute paths, including export output overwrite.**
`index.js:341-394` (`projectRootFromInput`, `importFolder`) and `index.js:663-674` (`startExport` `path.resolve(input.path)`) accept any absolute path from DSH tools; `opentake_studio_export` (`index.js:1103-1110`) can therefore write an MP4 anywhere the DSH user can write (`ffmpeg -y`, `lib/export.js:406-431,448-518`), overwriting an existing file. `new_project` also mkdirs `media/thumbnails/exports` anywhere. This is within a coding agent's normal file capability and the client export dialog asks for a path, but the plugin presents itself as a scoped editor: prefer defaulting agent tools to `<projectRoot>/exports` and requiring an explicit override, or document the trust boundary. Test: explicit output outside the project is accepted (`exports browser-rendered text overlays…`).

**M2. No subprocess/request timeouts for probe/import/upload/export.**
`lib/media.js:258-389` (`runFfmpeg`) and `:398-477` (`runFfprobe`) have no default deadline; `probeMedia`/`importToProject` (`:507-588,682-793`) and thumbnails pass no signal, and the upload path (`index.js:396-443`) has no read deadline. A malformed or wedged media file (or a stalled client body) can hold a request and a child process indefinitely. Only export has explicit cancel. Recommend default timeouts (e.g. probe 10-30 s via existing `signal` support) and an upload idle timeout.

**M3. Failed/rejected uploads leave orphan files; oversize upload resets the connection.**
`index.js:396-443`: the destination file is created before `probeMedia`; when the probe fails the file is not removed (test pins this). At `index.js:410-417` exceeding `MAX_UPLOAD_BYTES` calls `req.destroy()`/`out.destroy()` and rejects with a 413 `RouteError`, but by then the socket is gone, so the client cannot receive the JSON 413 — it sees a connection error. An aborted request also leaves a partial file. Fix: delete the target on failure/abort, and stop reading/blow up without destroying the socket (or set `res` first and drain).

**M4. Export state is global, not per project.**
`state.export` (`index.js:143`) is shared; opening/creating another project while an export runs is not blocked. Verified: after switching projects mid-export, `/opentake-studio/export/status` reports the old project's output/path under the new project until another export starts; `project/open`/`project/new` (`index.js:769-786`) do not cancel or clear it. `export/cancel` (`index.js:711-719`) also resets a `done`/`error` state to `idle` even when nothing is running, hiding the previous result. Decide per-project export state (or cancel + clear on project switch) and make cancel a no-op unless running.

**M5. Missing `opentake_studio_list_media` tool required by the contract.**
`docs/DESIGN.md:249` lists it; `index.js:883-1108` registers 14 tools without it (get_state returns the media array instead). Either add the tool or amend DESIGN/README; docs-writer must not claim it.

**M6. Client bundle is entirely untested/unverified (3.5k-line hand-written bundle).**
`test/host.test.mjs` statically checks the module-loader shape, registrations, react-only `require`, and theme-token discipline, but the editor page, playback/seek, drag/move/trim/split interactions, media elements/Range consumption, directory picker integration, real browser text PNG rendering and the export dialog flow have no automated coverage and could not be exercised here (see §4). Highest residual risk in the deliverable.

### Low

- **L1. JSON routes do not validate `content-type`** (`index.js:766-851`). Mutation routes accept any body content type. Same-origin `requestRejection` is the actual fence and browsers cannot send JSON cross-origin without preflight, so this is defence-in-depth only.
- **L2. Malformed percent-encoding → 500.** `decodeURIComponent` inside `handle` (`index.js:798-803`) throws `URIError`, which `errorResponse` reports as 500 `internal-error` (test pins it); should be 400 `invalid-input`.
- **L3. Method/route semantics.** Unknown paths and method mismatches return JSON 404 `not-found` (`index.js:848-849`) rather than 405/Allow; `/media/thumb/<id>` supports GET only, so HEAD there is 404 while the media byte route supports HEAD. Minor REST inconsistency.
- **L4. Import error mapping.** A missing import folder surfaces as 500 `io-error` (`index.js:379-394` + `statusForCode` default `index.js:733-753`) although DESIGN §7.3 lists `io-error` among route errors; unprobeable files are silently skipped (`lib/media.js:754-773`) while upload failures become 400 `media-error` — inconsistent but not unsafe.
- **L5. Host normalization quirks (pinned by tests).** `trimStartFrame ≥ source` is silently reset to 0 (`index.js:266-269`) instead of the model's `out-of-bounds`; image clips default to a hard-coded 150 frames (`index.js:42,271`) although the model default is `5s × fps` (`lib/model.js:24,838`, i.e. 120 at 24 fps); an `add-text` `fontWeight: 700` numeric is downgraded to `'600'` (`index.js:313-322` vs `lib/model.js:267-269`).
- **L6. Batch semantics are implicit.** `add-media` and `add-clip` in the *same* `/edit` request fails with `Unknown media` because normalization resolves against current state (`index.js:229-266`); UI/tools issue two requests. Works, but the `/edit` contract should say media must exist before placement (test pins the failure).
- **L7. Export overwrites without confirmation.** `startExport` + `ffmpeg -y` overwrite an existing file at a user/agent-supplied path; `existedBefore` (`lib/export.js:476,496`) only prevents cleanup of a pre-existing file on failure — ffmpeg has already truncated it. `startExport` also creates the parent directory before setting the running state (`index.js:674`), so a mkdir failure returns 500 with a raw fs code instead of a clean project/export error.
- **L8. Import uses hard links and name+size dedupe.** `lib/media.js:744-749` links source files into `media/` (DESIGN §4 preference), so later edits to the original mutate the project's media; re-import dedupes by `name + size` (`lib/media.js:667-708,734-738`), so a changed file with the same name/size is skipped. Document or switch to copy+hash for user-facing imports.
- **L9. Project JSON has no size cap.** `lib/project.js:92-117` reads/parses the whole `opentake-studio.json`; opening a very large/crafted file can block/OOM the Host. Project files are user-owned, so low.
- **L10. Save ordering can regress transiently.** Every edit commits then `await saveNow()` (`index.js:163-181,324-334`), and `commit` also schedules a 250 ms debounced save; overlapping atomic writes can rename an older snapshot last. The debounced save normally rewrites current state, but a hard crash in that window can leave the older JSON.
- **L11. State polling cost.** `/state` returns the full project (tracks, clips, media) and the client polls it every 1000 ms (600 ms while exporting) unless the page is hidden (`client.js:2525-2545`); large timelines re-serialize and transfer the whole project each second.
- **L12. Text render has no PNG sanity check.** `index.js:647-660` accepts any canonical base64 ≤8 MiB as a `.png`; a non-PNG payload is stored and only fails later at export. Magic-byte/size check would fail fast.
- **L13. Upload/read limits.** `MAX_UPLOAD_BYTES` is 2 GiB streamed; there is no per-request byte cap on project JSON open, no upload count cap, and no import entry/size cap (a recursive import of a huge folder copies/links everything without a budget).
- **L14. Undo snapshot memory.** Up to 100 full project snapshots are retained (`index.js:41,173-181`); fine for normal projects, but large clip counts multiply memory and every edit also clones via the model.

### Info / documentation drift

- **I1. Text-track behavior differs from DESIGN §3.** DESIGN says `add-text` auto-creates a "suitable video track"; the implementation intentionally creates/reuses a dedicated track named `Text`, never splitting the video clip (`index.js:274-301`; asserted by tests). Update DESIGN §3/§7.4 to describe this model, since the UI relies on it.
- **I2. `StateResponse` extras.** `saveError`, `lastError`, `pluginVersion` are returned beyond DESIGN §7.2 (`index.js:188-207`); additive but the client contract should list them.
- **I3. Error-status mapping is not in DESIGN.** Actual: `no-project`/`project-exists`/`export-running` → 409, `project-not-found`/`media-not-found` → 404, `ffmpeg-unavailable` → 503, `RouteError`/`ModelError` → 400 (or explicit status), other fs errors → 500 with raw code (`index.js:733-763`). Document this table.
- **I4. Extra route not in DESIGN §7.3.** `POST /opentake-studio/tracks` (`index.js:837-843`) is used by the client (`client.js:2944`) but absent from the route table.
- **I5. One hardcoded style colour.** `.ots-canvas-wrap{background:#000}` (`client.js:551`) is the video letterbox backdrop; every other style uses `--dsw-alias-*` tokens (static test asserts the single exception). Consider a token for consistency.
- **I6. MCP/OpenTake references are prose only.** The plugin has no MCP/import/binary dependency; comments/locale state that explicitly. Static test enforces the import/dependency side.
- **I7. Upload is implemented though DESIGN marked it optional**, with a 2 GiB streaming cap; document the cap and the failure-mode (M3).
- **I8. Text export resolution** is the normalized transform box in project pixels (`client.js:347-399`); preview and export both scale from the same box, but very large boxes / many text clips produce larger PNGs and a slower render step before export — worth noting in docs.

## 3. Missing tests (suggested follow-ups)

- Host: >2 GiB/aborted upload cleanup (M3), slow/hung ffprobe/ffmpeg timeout (M2), export-vs-project switch cancellation policy (M4 — a deterministic export-switch test exists but pins current behavior rather than a chosen policy), concurrent save ordering, huge project JSON, `HEAD` on thumbnail/media edge cases beyond the covered set.
- Client: no unit/browser tests for the 3.5k-line bundle (M6); at minimum a DOM-less test of `renderTextClipToDataUrl`/route helper extraction would help.
- End-to-end: real DSH install + Slots + GUI (see §4).

## 4. What I could not verify

- **Live DSH bundle install** (`plugin_manager install_bundle … → applied`) and the live Client Slots (`main`, `sidebar.panellist`, `settings.section`) / editor page: the client `Service.listService` inspect timed out (no browser page answered), and I had no GUI/browser control. Only static bundle checks are covered here.
- The optional directory-picker integrations (`uiWorkspace.pickDirectory`, `globalThis.__DSH_DIRECTORY_PICKER__`) are unverified client contracts; the client degrades to a text path input when unavailable.
- Real-browser editor behaviour: playback/seek, media-element Range consumption, drag/trim/split, canvas text rendering, export dialog and locale/theme rendering.
- `drawtext` fallback export path on a machine that has drawtext: this machine's ffmpeg 9.0.2 reports no drawtext filter, so only the browser-rendered-PNG path and the failure hint were exercised (export.test covers the hint).
- The 2 GiB upload boundary, slowloris-style uploads, Windows path behaviour (`media.fileName` backslash rejection exists but is untested on Windows), and very large projects/state polling cost.

## 5. Resolution status (Lead, 2026-11-08, post-review)

- **M1 (overwrite risk)** — `POST /export` and `opentake_studio_export` now refuse an existing output unless `overwrite:true`; agent tools still accept absolute project/export paths (documented trust boundary in README security).
- **M2 (timeouts)** — `probeMedia` and `ensureThumbnail` now bound ffprobe/ffmpeg with a 30 s `AbortSignal.timeout`; export remains intentionally unbounded except for explicit cancel; upload still has no host-side deadline.
- **M3 (upload orphans / 413)** — failed or oversized uploads now unpipe, destroy the partial stream and delete the partial file; the 413 path no longer calls `req.destroy()` before responding.
- **M4 (export across project switch)** — opening/creating a project aborts and resets the previous export; `/cancel` is a no-op unless an export is running.
- **M5 (`list_media`)** — `opentake_studio_list_media` is registered; the tool set is now 15 and tests/docs are updated.
- **I1/I3/I4/I7** — DESIGN §7.2–§7.4 now documents the Text-track behavior, extra state fields, error-status table, `/tracks` route and implemented upload; client `uiWorkspace` is optional.
- Remaining open items are the low/informational findings above (M6 client test coverage, L10–L14, unbounded state polling) and the documented MVP gaps.
