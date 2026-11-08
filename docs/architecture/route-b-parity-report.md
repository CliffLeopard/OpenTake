# Route B — independent verification of the authorized phases

| | |
|---|---|
| Status | **Independent verification of the current working tree; per-item status below, not a full-parity claim** |
| Branch / commit | `feat/dsh-rust-engine` @ `7e95554` + an uncommitted authorized-phase worktree (see snapshot) |
| Snapshot | 2026-11-08 22:38 local |
| Addon | `opentake_engine_v38.node`; arm64 sha256 `4870f85409d09ec5b4c58c6915b9df7173b39e0e5a8737cc1e1827ded78c7a8a` (43.2 MiB, ORT), x64 `21f2fd2a…` (17.8 MiB, **no ORT**) |
| Package | `dist/…darwin-universal.tgz` 21,515,725 B, 21 files; both packaged addons byte-equal the repo files; `verify-tarball` 10/11 |
| Environment | macOS 27.2 arm64 · Node 26.13.0 (N-API 10) · DSH Electron Node 24.21.0 (N-API 10) · rustc 1.99.1 · ffmpeg 9.0.2 · Chrome · no Rosetta, 0 codesigning identities, no `pwsh` |
| Model | `~/.dsh/opentake/models/siglip2-base-patch16-256-v2` — **complete and pinned-SHA verified** (see §2.2) |
| Worktree | dirty: `crates/opentake-node/*` (search APIs, `ort-backend`), `crates/opentake-render/*` (HDR reference path, wgpu features), `crates/opentake-export-pro/*` (HDR10), `.github/workflows/route-b-platform.yml`, `plugins/opentake-studio-route-b/native-editor/**`, `web/src/native/**`, new platform/signing scripts, `docs/architecture/route-b-hdr.md` |
| Verifier scripts | `scripts/route-b/verify/{revalidate-v28.sh,verify-tarball.mjs,verify-host-api.mjs,verify-search-model.mjs,verify-real-search.mjs,verify-hdr10.mjs,verify-native-ui.mjs,verify-ci-signing.mjs}` |

Method: commands below were run against the working tree above; statuses cite
results or file:line evidence, never docs alone. No implementation file was
edited and nothing was committed.

## 1. Authorized-phase matrix

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | v38 addon build / ABI / load | **Verified (functional)** / **Partial (byte-repro)** | smoke OK; `verify-addon --workers` **22 passed, 2 warnings, 0 failed** in Node 26 and DSH Node 24; N-API 8 chain, no libnode. Clean build produced `e1cf52f0…` vs checked-in `4870f854…` (worktree was being rebuilt concurrently; re-compare after freeze). Consolidated run: **18 passed, 0 failed, 1 skipped (hash drift), 1 warning (repo-path dlopen)**. |
| 2 | Package + DSH profile install | **Verified**, one feature-parity blocker | `verify-tarball` 10/11; fresh `npm pack` 21 files; temp-`DSH_HOME` `dsh plugin add` + `--dump-config` + installed addon load PASS; packaged plugin Host half loads **31 tools**. Blocker: x64 addon lacks ORT (see §3.2). |
| 3 | Host API (v38, current tree) | **Verified**, one warning | `verify-host-api.mjs --plugin <temp copy>`: **29 passed, 1 warning, 0 failed (31 checks)** — native cpal playback + multipart PNG stream, JPEG preview, denoise/loudness/stabilization bridges, 10-bit H.265 with correct SDR tags, ducking RMS drop, Motion template publish, static `/app/`. Warning: Host search gate is stale after the model install. |
| 4 | SigLIP2 visual search | **Verified at the addon level** / **Partial in the Host** | Model complete: all three canonical files match pinned SHA-256 and receipts parse (`verify-search-model` exit 0). Workstream real-inference test **4/4** and my independent `verify-real-search` **PASS**: text `red` → `red-video:0.1321`, image red frame → `red-video:0.9999` > `blue-video:0.9559` via `ort-native`. The Host plugin still returns `installed:false/model_not_installed` (hardcoded gate, `index.js:1015-1035`) — stale integration, reported as a warning. x64 addon has no ORT. |
| 5 | HDR10 linear compositor + export | **Verified isolated path only** | `hdr10-evidence.sh` PASS; true output HEVC **Main 10 / yuv420p10le / BT.2020 / SMPTE2084 / bt2020nc** with **mastering-display + content-light** side data; SDR fallback BT.709 without HDR metadata; a 10-bit SDR file re-tagged PQ **without mastering metadata** is classified `false-hdr` and rejected. Production wgpu compositor/addon export remain SDR (`crates/opentake-render/src/hdr.rs`, `route-b-hdr.md`). HDR hardware display Unknown. |
| 6 | Native React editor body | **Partial** | Prototype + Node tests **9/9**, shell stub tests **11/11**, Chrome harness mounts a real React body (56,727-byte screenshot; needs `--allow-file-access-from-files`). Not wired into the default client (`ui/client.js` still hosts the iframe editor); live DSH Client mount **Unknown**. |
| 7 | Windows/Linux CI + signing prep | **Partial / Unknown** | Workflow has 5 platform jobs; YAML + pinned action SHAs + scripts validate; wgpu readiness macOS/Windows/Linux **READY**; signing gated on dispatch+secrets. Locally: `sign-macos.sh` **SKIP** (0 identities), Linux/Windows preflights **exit 78**, no `pwsh` for `sign-windows.ps1`. No CI run, no Windows/Linux binary, no signing/notarization. |
| 8 | Native playback integration | **Verified on macOS arm64** | Host API: cpal clock active (`/engine/playback/audio` → 409 `native-audio`), multipart PNG stream works, pause/stop; cpal hardware probe advances the clock. Other platforms untested. |
| 9 | 10-bit export / ducking / media bridges | **Verified on macOS arm64** | H.265 `bitDepth 10` → Main 10/yuv420p10le; SDR tags (not HDR, no mastering side data); ducking export RMS `0.1214 → 0.0906`; JPEG preview; denoise/loudness/stabilization JSON; ASR/captions; Motion doc+template publish. |
| 10 | Providers layer | **Partial (module+Host wiring, mocks only)** | `lib/providers.js` imported by Host (`index.js:19`); 21 loopback-mock tests pass; Host API provider mocks import assets. No real provider call (no keys/network); real behavior Unknown. |

## 2. Evidence and exact commands

### 2.1 Consolidated run
```bash
bash scripts/route-b/verify/revalidate-v28.sh --fresh-pack
# PASS environment — HEAD 7e95554, Node 26.13.0 napi 10, DSH 24.21.0 napi 10
# WARN addon dlopen from the repo path is killed in this shell (SIGKILL; temp copies load)
# PASS cargo build -p opentake-node --release --locked — 12 s
# SKIP built addon matches checked-in arm64 artifact — built e1cf52f0…, repo 4870f854…
# PASS smoke + verify-addon --workers — 22 passed, 2 warning(s), 0 failed (both runtimes)
# PASS fresh npm pack — 21 entries; tarball verification 10/11; extraction 21 files
# PASS dsh plugin add (temp DSH_HOME); dump-config; installed addon loads
# PASS Host API probe (repo plugin, temp copy) — 29 passed, 1 warning, 0 failed (31 checks)
# PASS Host API probe (extracted package) — 29 passed, 1 warning, 0 failed (31 checks)
# Result: 18 passed, 0 failed, 1 skipped, 1 warning
```

### 2.2 SigLIP2 model — size alone is not proof
Pins agree between `crates/opentake-media/src/search/config.rs` and
`scripts/route-b/search/model-assets.mjs`; full SHA-256 was recomputed:

| installed file | bytes | expected SHA-256 | observed |
|---|---|---|---|
| `image_encoder.onnx` | 371,992,072 | `f5cb1672…aa7a` | **SHA matches** |
| `text_encoder.onnx` | 1,129,469,657 | `d3de4a6b…aaef` | **SHA matches** |
| `tokenizer/tokenizer.json` | 34,363,039 | `cb9140fa…8322` | **SHA matches** |
| receipts | `manifest.json`, `spec.json` | — | both present and parse; receipt hashes equal pins |

`node scripts/route-b/verify/verify-search-model.mjs` → **exit 0 / complete**.
Canonical layout (not raw `onnx/` files) and receipts are in place.

Real inference:
```bash
node --test scripts/route-b/search/real-inference.test.mjs     # 4/4 pass (~94 s)
node scripts/route-b/verify/verify-real-search.mjs --addon <temp-copy>/opentake_engine_v38.node
# PASS: installed=true visualAvailable=true backend=ort-native; indexed 2
# text "red": red-video:0.1321
# image red frame: red-video:0.9999, blue-video:0.9559
```
Host-level search is **not** wired yet: `search_model_status` still returns
`installed:false, model_not_installed` in `plugins/opentake-studio-route-b/index.js:1015-1035`,
which `verify-host-api.mjs` surfaces as the warning "Host search gate is stale after
the model install". This is a real integration gap, not a model failure.

### 2.3 HDR10
```bash
bash scripts/route-b/export/hdr10-evidence.sh   # PASS → /tmp/route-b-hdr10
node scripts/route-b/verify/verify-hdr10.mjs /tmp/route-b-hdr10/hdr10_true.mp4
# PASS hdr10 — hevc Main 10 yuv420p10le bt2020/smpte2084/bt2020nc; mastering=true contentLight=true
node scripts/route-b/verify/verify-hdr10.mjs --expect sdr /tmp/route-b-hdr10/hdr10_sdr_fallback.mp4
# PASS sdr — hevc Main 10 yuv420p10le bt709/bt709/bt709; mastering=false
node scripts/route-b/verify/verify-hdr10.mjs --expect not-hdr /tmp/route-b-hdr10/retag_false_hdr.mp4
# PASS (rejected): kind=false-hdr — HDR tags without mastering-display metadata
```
`ffprobe -show_frames` on the true file reports Mastering display metadata
(BT.2020, 1000-nit peak) and Content light level metadata (1000/400); the SDR
fallback has neither. The linear compositor is a reference RGBA16F path, not the
shipped wgpu compositor; addon/Host export currently offer 10-bit H.265 SDR only.

### 2.4 Native editor
```bash
node --test plugins/opentake-studio-route-b/native-editor/test/native-editor.test.mjs   # 9/9
node --test plugins/opentake-studio-route-b/test/ui-mount.test.mjs                       # 11/11
node scripts/route-b/verify/verify-native-ui.mjs --chrome
# PASS ... native-editor browser harness mounts in Chrome — 56727 byte screenshot
```
The default DSH shell still embeds the iframe editor; the prototype is additive
(README states it is not wired) and the live DSH mount is Unknown.

### 2.5 CI / signing
```bash
bash scripts/route-b/platform/validate-workflows.sh   # YAML OK + scripts OK
node scripts/route-b/platform/check-wgpu-features.mjs  # macOS/Windows/Linux READY
bash scripts/route-b/platform/sign-macos.sh            # SKIP (no Apple secrets)
bash scripts/route-b/platform/build-linux.sh           # BLOCKED exit 78
bash scripts/route-b/platform/build-windows.sh         # BLOCKED exit 78
node scripts/route-b/verify/verify-ci-signing.mjs      # 8 PASS, 1 WARN (no pwsh)
```
Jobs: macOS arm64 (macos-14), macOS x64 runtime (macos-13), macOS universal,
Windows x64 (`windows_ready`), Linux x64 (`linux_ready`); Apple secrets wired but
sign/notarize only for `workflow_dispatch && sign == true`.

### 2.6 Host API (v38 features)
From a temp plugin copy (see §3.3): `verify-host-api.mjs` **29 passed, 1 warning,
0 failed (31 checks)** — project/import/sprites/media, native cpal playback + stream,
JPEG/PNG preview, denoise/loudness/stabilization, 10-bit H.265 (not falsely HDR),
H.264 range export, AAC + ducking export, XMEML/EDL, search text fallback (with
stale-gate warning), ASR/captions/SRT, provider mocks, Motion document+template,
save/reopen, static `/app/`, storage.

## 3. Findings that affect a parity claim

### 3.1 Build reproducibility drift
Clean build of the moving worktree → `e1cf52f0…`; checked-in arm64 → `4870f854…`.
The phase features (ORT search, HDR modules, addon bindings) were still being
built concurrently at snapshot time, so byte equality is only meaningful after the
worktree freezes and the artifact is rebuilt from the final source. The script
reports SKIP instead of claiming a match.

### 3.2 Universal package mixes ORT and non-ORT slices
arm64 is 43.2 MiB and imports CoreML/Metal (ORT); x64 is 17.8 MiB and does not.
The universal tarball packages both, so search capability would differ by
architecture. x64 needs a same-feature rebuild (local cross-build or CI) before a
universal search claim; no Rosetta here to run it.

### 3.3 Repo-path dlopen is SIGKILLed in this shell
Loading the repo-path addon directly kills the process (`Killed: 9`) in Node 26 and
DSH Node 24; copies under `$HOME`/`$TMPDIR` load, and the packaged/extracted addon
loads. The verifier therefore probes from a temp plugin copy and records a WARN.
This is an environment limitation of this shell, not evidence the package is
broken; a live Host restart path that dlopens the repo file still needs checking.

### 3.4 HDR / native UI / search claim boundaries
- True HDR10 is isolated to the reference linear compositor + `export-pro` writer;
  the production wgpu compositor, shared `ExportPreset`, addon and Host export
  remain SDR. Do not claim HDR10 delivery yet.
- The native editor body is a bounded prototype; the default panel still hosts the
  iframe editor. Live DSH mount unknown.
- SigLIP2 inference is real in the addon and model files are pinned/verified, but
  the Host still hardcodes "model not installed"; real search is not reachable
  through Host tools until that gate is replaced.

## 4. Stale or misleading docs
- `docs/architecture/route-b-verification.md`: still names v27 addons and “no
  HDR/ducking contract”; superseded by v38 isolated HDR evidence and Host 10-bit/
  ducking integration — update or retire.
- The previous revision of this report (v28) is superseded by this snapshot.
- `route-b-search.md` now documents the real addon capability and matches the
  verification; the Host gate is the stale part.
- `route-b-hdr.md`, `route-b-platform.md`, `route-b-native-ui.md`,
  `native-editor/README.md` correctly limit their claims to what was verified.

## 5. Blockers / pending
1. **Host search integration** — replace the hardcoded `search_model_status`/
   `search_index_*`/`search_query` gate with `searchConfigure` + addon calls, and
   add a Host-level real text/image search test; model is ready.
2. **x64 ORT parity** — rebuild darwin-x64 with the same features (or document
   arm64-only search) before calling the universal package feature-complete.
3. **Final reproducible addon artifact** — after the worktree freezes, clean
   rebuild and compare SHA-256 with the checked-in artifact.
4. **HDR production integration** — migrate the wgpu compositor/ExportPreset or
   explicitly keep HDR10 out of scope; current claim is isolated-path only.
5. **Native editor wiring** — move the prototype into the default shell, then
   verify the live DSH Client mount.
6. **CI/signing/runtime** — needs GitHub runners, Apple/Windows credentials and a
   non-arm64 host; currently static/prepared only, nothing external executed.
7. **Real providers** — still loopback mocks only; Unknown by design.

## 6. Verifier scripts (owned under `scripts/route-b/verify/`)
- `revalidate-v28.sh` — version-autodetecting end-to-end run (env, clean build,
  smoke/verify-addon, fresh pack, tarball/extract, temp-DSH install, Host API on
  temp plugin copy + extracted package; records the repo-path dlopen WARN).
- `verify-tarball.mjs` — version-agnostic package/slice/host-load checks.
- `verify-host-api.mjs` — 31-check Host API probe including v38 features.
- `verify-search-model.mjs` — pinned sizes + full SHA-256 + canonical layout +
  receipts; partial files never count as installed.
- `verify-real-search.mjs` — real SigLIP2 text/image Moment ranking on a complete
  model + addon.
- `verify-hdr10.mjs` — independent HDR10 classifier; rejects false-HDR tags.
- `verify-native-ui.mjs` — client/package/UI tests + optional Chrome mount.
- `verify-ci-signing.mjs` — CI workflow static validation, wgpu readiness, signing
  dry-runs and explicit pending external resources.
