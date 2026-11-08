# Route B — independent parity & verification report

| | |
|---|---|
| Status | **Independent verification of the v28 working tree; not a full-parity claim** |
| Branch / commit | `feat/dsh-rust-engine` @ `97ea163fc1a9a771a73790f3fc5e70d8dc51df3c` |
| Working tree | **dirty by design**: `plugins/opentake-studio-route-b/index.js`, `package.json` modified; new `crates/opentake-{search,playback,export-pro}/`, `plugins/opentake-studio-route-b/{lib,test,ui}/`, `scripts/route-b/{search,playback,export,platform,verify}/`, and the new workstream docs are untracked |
| Snapshot | `index.js` sha256 `6bed03de…` (21:22 local), `package.json` `3c3a4924…`, `lib/motion-templates.js` `48f60766…`, `lib/providers.js` `077347d0…`, `dist/*.tgz` `350e1033…` (21:08) |
| Environment | macOS 27.2 arm64 · system Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10, Electron 44.7.0) · rustc/cargo 1.99.1 · ffmpeg/ffprobe 9.0.2 · Chrome present |
| Verifier scripts | `scripts/route-b/verify/revalidate-v28.sh`, `verify-addon.mjs` (existing, Lead-owned), `verify-tarball.mjs`, `verify-host-api.mjs` |

Method: every claim below was re-run in this session against the working tree above
or read from implementation files with line evidence. Existing documents are
**not** treated as proof; stale document claims are listed in §7. Temp projects
and packages live under the OS temp dir; no implementation file and no profile
was edited, and nothing was committed.

## 1. Results summary

| # | Area | Status | Evidence (this session) |
|---|---|---|---|
| 1 | Addon independent build + ABI + load | **Verified** | clean crate rebuild 13 s; sha256 `66de5f82…` equals checked-in arm64 addon; smoke OK; `verify-addon.mjs --workers` **22/22** (2 expected warnings) in system Node **and** DSH Electron Node; N-API 8 feature chain, no libnode link |
| 2 | Universal package (fresh pack) + DSH profile install | **Verified** (fresh pack) / **Blocked** (`dist/` artifact) | fresh `npm pack` 19 files (17 + `lib/motion-templates.js` + `lib/providers.js`); both slices arm64+x64 with matching bytes; `verify-tarball.mjs` **10/11** (1 size warning); `dsh plugin --profile <temp> add <fresh.tgz>` in temp `DSH_HOME` → package mounted, `--dump-config` contains the bundle, installed arm64 addon loads |
| 3 | Host API (routes/tools, current working tree) | **Verified**, one gap | `verify-host-api.mjs` **25/27** (1 warning) against repo plugin **and** extracted fresh package: project bundle, recursive `import_folder`, media/thumbnails, waveform, sprite grid, placeMedia, preview, playback endpoints + WAV, H.264 range export, AAC mixdown, XMEML/EDL, ASR mock + captions + SRT, image/speech/video provider mocks, Motion document + **integrated template preview/publish**, save/reopen, static `/app/`, storage |
| 4 | Search (SigLIP2 slice) | **Partial** | crate: 26 unit + 2 contract tests pass; probe script 6/6; text fallback deterministic, `visual_unavailable` explicit. **Missing:** visual assets/backend (deliberately) and Host still hardcodes the gate instead of importing the crate (`index.js:990-1010`); no visual Moments by design |
| 5 | Playback (native slice) | **Partial** | crate: 17 engine tests pass; cpal feature 1 pass + 1 ignored; ignored hardware probe ran: clock `0 → 8704` samples @48 kHz; probe demos pass. **Missing:** addon/Host integration (docs say not done, `route-b-playback.md:267,314`); timeline audio not mixed into the cpal callback |
| 6 | Export-pro (10-bit/HDR/ducking) | **Partial** | crate: 26 tests pass; `run-evidence.sh` PASS; independent ffprobe: H.265 Main10 `yuv420p10le`, BT.2020/PQ tags + x265 mastering params; `hdr-policy` explicit SDR/HDR decisions; `tone-map` changes PQ luma (`changed: true`); ducking voice-window mean `-11.73 dB` (requested −12). **Missing:** integration into addon/Host (`route-b-export-pro.md:285` "next milestone"); docs' own artifact is a standalone slice |
| 7 | Motion templates | **Verified (working tree integration)** | `lib/motion-templates.js` 11 tests; independent Chrome render of `title-card`, `lower-third.glass`, `callout` at frames 0/15 → real PNGs (`/tmp/routeb-motion-render/report.json`); Host integration landed (`index.js:18,533,589`) and Host API probe previewed **and published** a template clip through headless Chrome + ffmpeg |
| 8 | Providers | **Partial** | `lib/providers.js` 21 loopback-mock tests pass; request/response/auth-redaction shapes covered; **not integrated** (Host uses its own inline provider code; no `lib/providers.js` import); real providers never called (documented) |
| 9 | Platform (Linux/Windows/packaging) | **Partial / Blocked** | platform `verify-package.mjs` 35 pass / 2 warnings; package matrix sees only darwin arm64+x64; `build-linux.sh` and `build-windows.sh` exit **78 (BLOCKED)** with 4/5 missing prerequisites (no Linux target/linker, no MSVC/Windows SDK, wgpu Metal-only source, Docker daemon down); signing identities = 0 |
| 10 | DSH-native UI shell | **Partial / Unknown** | `ui/client.js` + 11 stub tests pass (module format, slots, locales, token-only styles, polling/cleanup, iframe fallback); **not shipped**: package `exports` still points at the iframe `client.js` and `files` has no `ui/**`; live Client Slots inspect timed out → real mount **Unknown** |
| 11 | Live DSH Host | **Partial** | live tools report v28 addon loaded (`node 24.21.0`, NAPI 10) and read-only `get_timeline`/`media` work; latest `index.js` integration changes are newer than the Host's loaded module, so live motion/search/provider integrations were **not** observed until a Host reload/reinstall |

Totals from the reproducible run: `scripts/route-b/verify/revalidate-v28.sh --clean --fresh-pack`
→ **18 passed, 0 failed, 1 warning** (warning = stale `dist/` tarball).

## 2. Exact commands and observed output

```bash
# --- environment ---
git rev-parse HEAD            # 97ea163fc1a9a771a73790f3fc5e70d8dc51df3c
node -v                       # v26.13.0   (process.versions.napi = 10)
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  -p 'process.versions.node + " napi=" + process.versions.napi'
                              # 24.21.0 napi=10

# --- 1. independent addon build (clean crate artifacts; deps reused) ---
rm -rf target/release/.fingerprint/opentake-node-* target/release/libopentake_node.*
cargo build -p opentake-node --release --locked        # Finished in 13.19s
shasum -a 256 target/release/libopentake_node.dylib \
  plugins/opentake-studio-route-b/native/darwin-arm64/opentake_engine_v28.node
# both: 66de5f82facbd99528b4cea5cc245918bfbce4a612f4fc959d0a9d39e13eada1

node crates/opentake-node/test/smoke.mjs /tmp/route-b-v28/opentake_engine_v28.node
# route-b addon smoke: ok
node scripts/route-b/verify-addon.mjs --addon /tmp/route-b-v28/opentake_engine_v28.node --workers
# 22 passed, 2 warning(s), 0 failed
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/route-b/verify-addon.mjs --addon /tmp/route-b-v28/opentake_engine_v28.node --workers
# 22 passed, 2 warning(s), 0 failed

# --- 2. fresh universal package from the working tree (no repo writes) ---
(cd plugins/opentake-studio-route-b && npm pack --pack-destination /tmp/fresh-pack)
# 19 files: base 17 + lib/motion-templates.js + lib/providers.js; both arch slices
node scripts/route-b/verify/verify-tarball.mjs --tarball /tmp/fresh-pack/*.tgz
# 10 passed, 1 warning(s), 0 failed (11 checks)
DSH_HOME=/tmp/routeb-dsh-home dsh plugin --profile routeb-verify add /tmp/fresh-pack/*.tgz
dsh --profile routeb-verify --dump-config | grep opentake-studio-route-b
# dependency mounted; installed arm64 addon loads (newProject version 0)

# --- 3. Host API (fake Cordis ctx, real addon/plugin/ffmpeg/Chrome) ---
node scripts/route-b/verify/verify-host-api.mjs
node scripts/route-b/verify/verify-host-api.mjs --plugin /tmp/extracted/package
# each: 25 passed, 1 warning(s), 0 failed (27 checks)
# warning: import_folder imports media but skips the Host thumbnail loop that
#          /engine/import-media uses (thumbnails appear only after sprite/thumb requests)

# --- 4. search crate ---
(cd crates/opentake-search && cargo test --locked)    # 26 unit + 2 contract tests pass
node scripts/route-b/search/probe-search.mjs          # PASS x6, visual_unavailable explicit

# --- 5. playback crate + cpal clock ---
(cd crates/opentake-playback && cargo test --locked)  # 17 engine tests pass
(cd crates/opentake-playback && cargo test --offline --features cpal-output)
# 17 engine + 1 cpal visibility pass, 1 ignored
(cd crates/opentake-playback && cargo test --offline --features cpal-output \
   --test cpal_output -- --ignored --nocapture)
# cpal clock advanced 0 -> 8704 samples at 48000 Hz ... ok
bash scripts/route-b/playback/probe.sh               # cadence/streaming demos: OK

# --- 6. export-pro crate + real encodes ---
(cd crates/opentake-export-pro && cargo test --locked)   # 26 tests pass
bash scripts/route-b/export/run-evidence.sh              # PASS: h265_10bit, h265_8bit,
#   hdr_pq_bars, hdr_pq_bars_tonemapped, duck/noduck WAVs under /tmp/opentake-export-pro
# independent checks:
#   ffprobe h265_10bit.mp4 -> hevc / Main 10 / yuv420p10le
#   ffprobe HDR file       -> bt2020 / smpte2084 (+ x265 master-display/max-cll args)
#   tone-map -> bar codes changed, PSNR finite (hdr-yuv-measure.py)
#   ducking -> voice-window mean -11.73 dB vs requested -12 dB

# --- 7. motion templates (module + Host integration) ---
node --test plugins/opentake-studio-route-b/test/motion-templates.test.mjs   # 11/11
# independent Chrome render of all 3 templates at frames 0/15 -> PNGs, report at
# /tmp/routeb-motion-render/report.json

# --- 8. providers (loopback mocks only) ---
node --test plugins/opentake-studio-route-b/test/providers.test.mjs         # 21/21

# --- 9. platform scripts ---
node scripts/route-b/platform/verify-package.mjs                           # 35 pass, 2 warn
node scripts/route-b/platform/package-matrix.mjs                           # darwin arm64/x64 OK
bash scripts/route-b/platform/build-linux.sh   ; echo $?                   # 78 (BLOCKED, 4 prereqs)
bash scripts/route-b/platform/build-windows.sh ; echo $?                   # 78 (BLOCKED, 5 prereqs)

# --- 10. reproducible all-in-one ---
bash scripts/route-b/verify/revalidate-v28.sh --clean --fresh-pack
# 18 passed, 0 failed, 1 warning (dist tarball stale)
```

## 3. Addon / ABI detail (verified)

- `crates/opentake-node` built from source at the snapshot; `Cargo.toml` uses
  `napi = { version = "2", default-features = false, features = ["napi8"] }`
  (`crates/opentake-node/Cargo.toml:14-15`). `cargo tree -e features` enables
  exactly `napi1…napi8`; no `napi9/napi10/experimental` feature
  (`crates/opentake-node/Cargo.toml:14`).
- Mach-O arm64 dylib: N-API 10 host loads it in both runtimes; symbols import only
  N-API-8-era `napi_*` functions and `_napi_register_module_v1` is exported; no
  `libnode` dependency (system frameworks only). Minimum macOS 11.0.
- Reproducibility: independent clean rebuild produced a **byte-identical** arm64
  binary to the checked-in artifact (sha256 above); the x64 cross artifact
  (`f0013376…`) matches the packaged x64 slice. `cargo build` emits one
  dead-code warning (`FreezeFrame` fields, `edit_request.rs`) and a
  `rust-objcopy` strip warning; neither affects correctness.
- x64 runtime remains **Untested**: the arm64 host has no Rosetta/x64 Node;
  `ERR_DLOPEN_FAILED` for the x64 slice on arm64 is expected and observed.
- Universal `.node` naming is `opentake_engine_v28.node` in both repo and
  package; `scripts/build-route-b-addon.sh:43` writes it and
  `plugins/opentake-studio-route-b/index.js:32` loads it. Note the addon source
  itself is unchanged from the v27 milestone (same source hashes); "v28" is the
  package/milestone label.

## 4. Host API evidence (current working tree)

`verify-host-api.mjs` executes the actual plugin Host half with the actual
addon and real ffmpeg/Chrome:

- `GET /engine/info` → `{loaded:true, addonPath: …v28.node, node/napi}`;
- `POST /engine/invoke project_new {path}` → `.opentake` bundle (`project.json`,
  `media.json`); `project_save` → bare path string (invoke contract) vs
  `/engine/save` `{path}` wrapper; `project_open` round-trips;
- `import_folder {recursive:true}` → 4 media (video/audio/image/nested image);
  **warning:** this path returns raw `engine.importMedia` output and does not run
  the Host thumbnail loop used by `/engine/import-media` (folder-imported cards
  have `thumbnail:null` until a sprite/thumbnail request fills the cache);
- `request_timeline_sprite` → 3-column × 160 px JPEG tile grid cached;
  `get_waveform` → 4000 buckets; media catalog + poster thumbnails via the legacy
  import path;
- `edit_apply addClips` (with `addLinkedAudio`) → video+linked audio tracks;
  invoke `edit_apply` returns the bare `EditResultDto` (UI refetches timeline),
  while `/engine/apply` returns `{result, timeline}`;
- `/engine/preview/frame` and `composite_frame` → PNG; playback
  `start/seek/pause/stop` + `/engine/playback/audio` → RIFF/WAVE mix;
- export: 15-frame range H.264 720p (`0.50 s`), AAC m4a mix (1.0 s),
  XMEML/EDL files; ASR loopback mock → transcript, captions clip, SRT with a
  cue; image/speech/video provider mocks → 3 imported assets;
- Motion document preview + **template** preview/publish (3-frame Chrome render
  → ffmpeg → `addClips`), static `/app/` shell + assets, storage categories.
- Not exercised: real providers, SigLIP2 visual indexing, native cpal playback
  through this Host, Windows/Linux, live browser UI.

## 5. Workstream-by-workstream review (files, not docs)

### 5.1 Search — **Partial**
- Crate `crates/opentake-search` (standalone workspace, `Cargo.toml:13`):
  26 unit + 2 `fallback_contract` tests pass; `scripts/route-b/search/probe-search.mjs`
  passes 6/6 including “image query → `visual_unavailable`, moments=0”.
- Host integration (`index.js:990-1010`) is a hardcoded gate:
  `search_model_status` reports the SigLIP2 manifest with
  `visualAvailable:false, model_not_installed`; `search_index_start` throws;
  `search_query` returns the text fallback + `visualAvailable:false`.
  **Gap:** the Host does not import the new crate (`index.js` imports only
  `lib/motion-templates.js`), so crate behaviour and Host gate can drift; the
  visual backend and ~1.53 GB assets are intentionally absent.
- Text search over names/transcripts works (Host API probe: 1 file hit).

### 5.2 Playback — **Partial**
- Tests: `crates/opentake-playback/tests/engine.rs` 17/17; cpal feature tests
  1 pass + 1 ignored; the ignored hardware probe advances the audio clock
  `0 → 8704` samples @48 kHz (documented result reproduced). Demos:
  cadence 300 frames, streaming 60 frames, both OK.
- Not integrated: docs explicitly say addon/Host hooks are future work
  (`route-b-playback.md:267,314`); the Host's `/engine/playback/*` still uses the
  JavaScript wall clock and mixed-WAV endpoint (Host API probe verifies the old
  path, not cpal). Timeline audio into the cpal callback is missing by design.
- Linux/Windows cpal and GPU-backed frames unverified.

### 5.3 Export-pro — **Partial**
- Crate tests 26/26 (`codec`, `hdr`, `ducking`, `wav`); `run-evidence.sh` passes
  all claims; independent evidence:
  - 10-bit HEVC: `profile=Main 10`, `pix_fmt=yuv420p10le`;
  - HDR signalling: `bt2020`/`smpte2084` (+ x265 `master-display`, `max-cll`),
    with the explicit “passthrough requires a future HDR compositor” decision;
  - tone-map: `scale_vt` decode-stage chain, decoded bar code values change
    (`hdr-yuv-measure.py` `changed:true`);
  - ducking: voice-window mean −11.73 dB vs requested −12 dB; my independent
    mixed-signal RMS check shows −4.5 dB as expected because the voice layer is
    not ducked (report metric is the music-bus gain).
- **Not integrated**: `route-b-export-pro.md:285` lists integration as the next
  milestone; `index.js` export path still calls `Engine.exportVideo(codec,
  quality)` with no bit-depth/HDR/ducking options.

### 5.4 Motion templates — **Verified for the current working tree**
- Module + 11 tests; independent Chrome renders of all three templates (frames
  0/15) produce valid PNGs (`/tmp/routeb-motion-render/report.json`).
- Host integration is now applied: `index.js:18` imports the library;
  `motionPreview` accepts `templateId/params` (`index.js:533-586`) and
  `motionAdd` publishes templates (`index.js:589-680`). Host API probe previews
  and publishes a 3-frame template clip successfully.
- Docs `route-b-motion-templates.md` §5 still describes the integration patch as
  pending — update it; the code now contains it. Host tool surface intentionally
  has no separate motion-template tool (the invoke/IPC path is the contract).

### 5.5 Providers — **Partial**
- `lib/providers.js`: 21 loopback-mock tests pass; ASR/chat/image/speech/video
  profiles, normalization, auth redaction, no request leaves the mock origin.
- Not integrated: the Host still uses its own inline provider functions (the
  module is not imported), and no real provider was called (documented:
  `route-b-providers.md:280-293`). Real-network status **Unknown** by design.

### 5.6 Platform — **Partial / Blocked**
- Universal macOS package is real: fresh pack 19 files, both slices, byte-equal
  to repo addons; DSH temp profile install + dump-config + installed addon load
  all pass.
- `platform/verify-package.mjs` 35 pass / 2 warnings (absolute `install_name`
  build paths in both slices; consistent with the addon finding).
- `package-matrix.mjs`: only `darwin-arm64`, `darwin-x64` are assemblable;
  linux/win32 “Not built”.
- `build-linux.sh` / `build-windows.sh` exit **78 (BLOCKED)**: missing Rust
  targets/linkers, no MSVC/Windows SDK, wgpu backend feature is Metal-only for
  this build, Docker daemon unavailable; Windows signing tooling absent.
- Signing/notarization **Missing**: local `codesign` has 0 identities; arm64
  addon is ad-hoc/linker-signed, x64 is unsigned. Templates in
  `route-b-platform.md` §7 were not executed.

### 5.7 Native UI — **Partial / Unknown**
- `ui/client.js` + 11 stub tests pass (module format, native panel key, sidebar
  registration, locale dictionaries, token-only styles, engine-info fetch,
  polling/visibility cleanup, iframe fallback).
- **Not shipped or wired**: `package.json` exports `./client` → the iframe
  `client.js`; `files` does not include `ui/**`; docs mark integration as
  Lead-owned (`route-b-native-ui.md:292`).
- Live Client Slots inspect timed out (`Slots.listSubTree` after 10 s), so the
  actual DSH page mount and browser rendering are **Unknown** from this session.

## 6. Package / install discrepancy (blocker for shipping)

The checked-in `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz`
(21:08) predates the motion-template/providers integration (index.js 21:22):

- `tar -xOf dist/…tgz package/index.js | grep -c lib/motion-templates.js` → `0`;
- the dist package has the old 17-file layout and its `package.json.files`
  lacks `lib/*.js`;
- a fresh `npm pack` from the working tree has **19** files including
  `lib/motion-templates.js` and `lib/providers.js` and passes the package and
  addon-load checks.

→ **Rebuild `dist/` with `scripts/package-route-b.sh` before any release or
“universal package verified” claim.** Also decide whether `ui/**` should be
included once the native shell is wired; it is currently excluded.

## 7. Documentation claims that are stale or unproven

`docs/architecture/route-b-verification.md` (not my file) contains stale or
un-reproduced statements against this snapshot:

| Line | Claim | Evidence |
|---|---|---|
| `:15`, `:19` | arm64/v27 binaries and universal tarball “with both v27 addons” | current artifact is **v28** (`native/*/opentake_engine_v28.node`; `scripts/build-route-b-addon.sh:43`) |
| `:37` | “host API script 44/44 against live DSH Host” | **Unknown**: no script/artifact in the repo reproduces this run; I did not reproduce a live 44/44 |
| `:102`, `:117` | “Export H.265/10-bit/HDR/ducking: not verified / missing” | export-pro now verifies the **isolated** codec/HDR/ducking slice (26 tests + evidence run); integration into Host is still missing — update wording rather than delete |
| `docs/architecture/route-b-parity.md:124,126,145` | Export/ducking rows `Missing`, J5 HDR `Unknown`, etc. | Stale vs the new standalone export-pro evidence; parity rows need a separate “isolated slice verified / not integrated” status |
| `docs/architecture/route-b-motion-templates.md` §5 | Host integration “patch to apply” | integration is already applied in `index.js:18,533,589`; move §5 to “applied” |
| `docs/architecture/route-b-native-ui.md` | native panel slice “additive and disposable” | accurate, but `ui/**` is not exported/shipped; keep status Partial until Lead integrates |

Docs that matched this verification: `route-b-playback.md` (integration not done,
cpal claims reproduced), `route-b-providers.md` (loopback-only, real network not
called), `route-b-export-pro.md` (claims and evidence reproduced),
`route-b-platform.md` (blockers/exit 78 reproduced), `route-b-search.md`
(gating semantics reproduced at the Host level).

## 8. Blockers / remaining work (ordered)

1. **Rebuild `dist/` universal tarball** from the current working tree and
   re-run `verify-tarball.mjs` + temp-profile install (fresh pack already
   proves the process).
2. **Integrate the standalone crates or record them as non-shipping**:
   search (`lib`/crate not imported; Host gate hardcoded), playback (no
   addon/Host hooks), export-pro (no 10-bit/HDR/ducking options in the Host
   export path), providers (module not imported).
3. **Native UI**: wire `ui/client.js` into `package.json` (`exports`/`files`),
   choose the Lead-owned integration option, then verify the live DSH slot
   (Client inspect timed out here).
4. **Platform**: Linux/Windows builds blocked by toolchains + wgpu backend
   feature; code signing/notarization not executed; x64 has no runtime test
   (no Rosetta).
5. **Live Host freshness**: DSH Host has v28 addon loaded, but the latest
   `index.js` integration changes require a Host reload/reinstall before live
   tools reflect them.
6. Optional verification debt: real provider calls (needs approval/keys),
   SigLIP2 assets/backend, real browser UI smoke/CDP, Windows/Linux runtime.

## 9. Reproduction scripts (mine, owned under `scripts/route-b/verify/`)

- `revalidate-v28.sh` — env audit, independent crate rebuild, smoke,
  `verify-addon --workers` in both runtimes, `--fresh-pack` npm pack, tarball
  verification/extraction, temp-`DSH_HOME` profile install, Host API probe on
  repo + extracted package. `--clean` forces crate rebuild; `--package`
  rebuilds `dist/` via the project script (writes build artifacts).
- `verify-tarball.mjs` — extracts a package in temp, checks manifest/file set
  (17 base + `lib/*.js`), both arch slices, byte equality with repo addons,
  packaged addon load, packaged plugin Host load, no Tauri/OpenTake dependency.
- `verify-host-api.mjs` — fake-Cordis Host API probe (27 checks) used in §4;
  `--plugin <dir>` runs it against an extracted package.

All scripts only read implementation files and write under the OS temp dir
(except `revalidate-v28.sh --package`, which rebuilds existing build artifacts).


---

## Lead integration addendum (2026-11-08)

- Workstream artifacts are committed in `4c0f8fb` plus `3efd09a`; the task board
  has no in-progress items.
- Final universal package: `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz`,
  21 files, both v30 slices; `scripts/route-b/platform/verify-package.mjs`
  reports **35 PASS / 2 WARN / 0 FAIL**. The two warnings are absolute build
  install names in both Mach-O slices.
- Host search now reports SigLIP as **not installed/not available** instead of
  faking success; the `opentake-search` capability crate is committed but not
  linked into the addon.
- Recursive `import_folder` now generates Host poster thumbnails for video;
  Lottie cards remain client-rendered.
- Motion template preview/publish is integrated in the Host and verified.
- Providers are wired into Host image/speech/video generation; 10-bit H.265 is
  wired into the addon/Host export path (verified Main10 yuv420p10le).
- Video stabilization, EBU R128 loudness and denoise preparation/apply are wired through the addon/Host and verified.
- Playback and HDR-tone-map/ducking remain isolated modules; their parity rows
  remain Partial.
- Windows/Linux builds and signing remain blocked by missing toolchains,
  wgpu dx12/vulkan features and signing identities.
