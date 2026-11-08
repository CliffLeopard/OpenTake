# Route B platform: CI, Windows/Linux builds and signing preparation

> 状态：draft · partial verification · 分支 `feat/dsh-rust-engine` · 记录日期 2026-11-08
>
> This page records the Route B cross-platform build prerequisites, the CI workflow and signing
> preparation added for task-69, the checks that actually ran on this host, and what remains blocked
> by missing runners/SDKs/signing credentials. macOS arm64 has runtime evidence; macOS x64 and
> Windows/Linux do not (no Rosetta here, no Windows/Linux runners, no signing identities). Nothing in
> this page is fabricated runtime or signing evidence: pending items are marked pending.
>
> Related: [route-b-packaging.md](route-b-packaging.md) · [route-b-media-map.md](route-b-media-map.md)
> §7 · [route-b-parity.md](route-b-parity.md) U8 · [route-b.md](route-b.md) ·
> [CI workflow](../../.github/workflows/route-b-platform.yml)

## 1. Deliverables

### Platform scripts (`scripts/route-b/platform/`)

| File | Purpose |
|---|---|
| [`verify-package.mjs`](../../scripts/route-b/platform/verify-package.mjs) | Extract a tarball, validate manifest/patch/web assets, check every native binary's container/arch, N-API level, and load the current-platform addon + newProject/apply/undo/getTimeline |
| [`check-wgpu-features.mjs`](../../scripts/route-b/platform/check-wgpu-features.mjs) | CI preflight/documentation source for the per-platform wgpu backend features; `--github-output` feeds job readiness |
| [`inspect-native.mjs`](../../scripts/route-b/platform/inspect-native.mjs) | Static `.node` inspection (format/arch/SHA-256/minOS/install name/linked libs/codesign/N-API symbol) |
| [`abi-compat.mjs`](../../scripts/route-b/platform/abi-compat.mjs) | Host N-API vs addon `napi8`; registration symbol; minimal Engine contract (load) with `--no-load` for suites where `verify-package.mjs` already loads it; cross-arch SKIP |
| [`package-matrix.mjs`](../../scripts/route-b/platform/package-matrix.mjs) | Assemblable tarball names, missing platforms, manifest coverage |
| [`package-from-native.sh`](../../scripts/route-b/platform/package-from-native.sh) | Pack from the native binaries already present (no rebuild), so signing happens between build and pack |
| [`build-web.sh`](../../scripts/route-b/platform/build-web.sh) | Vite build with the Route B base, re-attach `tauri-shim.js`, inject the shim reference; `--check` validates prerequisites without writing |
| [`sign-macos.sh`](../../scripts/route-b/platform/sign-macos.sh) | Developer ID signing for both addons + optional `.pkg` notarization; `SKIP` without secrets, `--require` → exit 78 |
| [`sign-windows.ps1`](../../scripts/route-b/platform/sign-windows.ps1) | Authenticode signing template for Windows runners; `SKIP`/`-Require` semantics |
| [`validate-workflows.sh`](../../scripts/route-b/platform/validate-workflows.sh) | Ruby YAML parse + pinned-action-SHA check + `node --check`/`bash -n` on platform scripts |
| [`env-audit.mjs`](../../scripts/route-b/platform/env-audit.mjs) | Host/Rust-target/cross-linker/Docker/signing-identity audit |
| [`build-linux.sh`](../../scripts/route-b/platform/build-linux.sh), [`build-windows.sh`](../../scripts/route-b/platform/build-windows.sh) | Local build preflights; exit 78 with exact blockers when toolchains are absent |
| [`run-all.sh`](../../scripts/route-b/platform/run-all.sh) | Runs every check executable on this host + both build preflights |
| [`lib.mjs`](../../scripts/route-b/platform/lib.mjs) | Tar extraction, Mach-O/ELF/PE parsing, SHA-256, manifest helpers |

### CI

[`.github/workflows/route-b-platform.yml`](../../.github/workflows/route-b-platform.yml) — build/verify
macOS arm64, macOS x64, macOS universal packaging, Windows x64, Linux x64, with diagnostics and
optional signing (see §6). Not triggered on every push: pull requests that touch Route B paths and
manual `workflow_dispatch`.

## 2. wgpu platform backend features (applied by media-dev)

The render crate is **not edited by this task**. media-dev applied the target-specific change in
`crates/opentake-render/Cargo.toml` on 2026-11-08 (while it was editing the crate for the HDR10
phase), and Lead confirmed the exact form:

```toml
[dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl"] }

[target.'cfg(target_os = "macos")'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "metal"] }

[target.'cfg(target_os = "windows")'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "dx12"] }

[target.'cfg(any(target_os = "linux", target_os = "android"))'.dependencies]
wgpu = { version = "23", default-features = false, features = ["wgsl", "vulkan-portability", "angle"] }
```

- wgpu 23 names its Linux backends **`vulkan-portability`** (Vulkan) and **`angle`** (the wgpu-core
  `gles` feature); `vulkan`/`gles` are only accepted by the preflight as future aliases.
- `check-wgpu-features.mjs` reads this file, reports per-platform readiness, and fails the preflight
  when a required backend is missing. Current output: **macOS READY, Windows READY, Linux READY**
  (`node scripts/route-b/platform/check-wgpu-features.mjs` → exit 0). Lead also reported macOS
  `cargo check` passing.
- The workflow gates Windows/Linux jobs on these readiness outputs; if the feature set regresses, the
  jobs are skipped and `cross-platform-pending` records it rather than producing a false green build.

## 3. Artifacts under test

### 3.1 Earlier universal tarball (previous task, now stale)

`dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz` — sha256
`350e103304f64f457254cc7f6ef8f942237d42f21f53f95b3bea95823d343253`, 11.5 MiB, 17 entries, containing
the older `opentake_engine_v28.node` pair. It predates the current v38 addon and later plugin changes
(`ui/`, `lib/*`); it is kept only as historical evidence and **should not be shipped**.

### 3.2 Fresh local macOS arm64 package (this task)

`dist/opentake-studio-route-b-0.1.0-darwin-arm64.tgz` — sha256
`5ba8b696a52cdc81ce3b8e67aec5a012772a4401fcf21fbfbfcf8e82f7227c8a`, 14.4 MiB, 20 entries, with
`native/darwin-arm64/opentake_engine_v38.node` (43.2 MiB). The universal packaging path was also
exercised locally (`…-darwin-universal.tgz`, 21 MiB, sha256 `4bfb8a50c787606ffbf8bf34f7dc3584d5028303d9e420620d1ac33df1370df5`, 21 entries, **35 PASS · 2 WARN · 0 FAIL**),
but its x64 binary is the pre-existing 17.8 MiB build from before this task; it was **not** rebuilt
because `ort-sys` cannot be cross-built from this arm64 host (§5.4). CI assembles the supported
universal package from natively built arm64 + x64 addon artifacts (§6).

## 4. Local validation (2026-11-08)

Environment: macOS Darwin arm64 · Node 26.13.0 / N-API 10 · rustc 1.99.1 (aarch64-apple-darwin) ·
Xcode SDK 27.2 · no Rosetta · no codesigning identities.

| Command | Result |
|---|---|
| `node scripts/route-b/platform/check-wgpu-features.mjs` | **OK** — macos/windows/linux READY, exit 0 |
| `./scripts/route-b/platform/validate-workflows.sh` | **OK** — workflow YAML parses, all `uses:` pinned to 40-hex SHAs, scripts syntax-check |
| `./scripts/route-b/platform/build-web.sh --check` | **OK** — prerequisites only; no generated tree written |
| `./scripts/build-route-b-addon.sh` (arm64) | **PASS**, wrote `opentake_engine_v38.node` (~38 s); one `block v0.1.6` future-incompat warning |
| `ROUTE_B_TARGET=x86_64-apple-darwin ./scripts/build-route-b-addon.sh` | **FAIL (environment)** — `ort-sys@2.0.0-rc.11` has no prebuilt ONNX Runtime for `x86_64-apple-darwin` from this host; see §5.4 |
| `./scripts/route-b/platform/package-from-native.sh` | **PASS** — arm64-only `…-darwin-arm64.tgz` (14.4 MiB, 20 entries) and universal `…-darwin-universal.tgz` (21 MiB, 21 entries; x64 binary pre-existing, not rebuilt) |
| `node scripts/route-b/platform/verify-package.mjs` | **32 PASS · 1 WARN · 0 FAIL** for the arm64 tarball; **35 PASS · 2 WARN · 0 FAIL** for the universal tarball (WARNs: absolute install names in both `LC_ID_DYLIB`s) |
| `node scripts/route-b/platform/abi-compat.mjs` | **OK** — N-API 10 ≥ 8, architecture/registration checks pass. The local suite uses `--no-load` because `verify-package.mjs` already loads the addon and exercises edit/undo (avoiding two loads of the 43.2 MiB v38 binary in one run); standalone invocation still supports the load check. |
| `./scripts/route-b/platform/sign-macos.sh` | **SKIP** (no `APPLE_CERTIFICATE_P12_BASE64`); unsigned fallback, exit 0 |
| `./scripts/route-b/platform/run-all.sh` | **PASS** — all checks ran; both build preflights 78 as expected (aggregate exit 0) |
| `./scripts/route-b/platform/build-linux.sh` / `build-windows.sh` | **78** — toolchain blockers only; the wgpu backend preflight inside them now passes (media-dev's change) |

Not run locally: Windows/Linux builds, any code signing/notarization, x64 runtime (no Rosetta).
Those are pending external runners/credentials, not “unknown results”.

## 5. Platform matrix: actual status and blockers

| Target | Current status | Exact blocker / next step |
|---|---|---|
| macOS arm64 | **built + runtime verified locally** (v38, this task) | — |
| macOS x64 | built earlier, static checks only; **cross-build now blocked** | No Rosetta for runtime; from this arm64 host `ort-sys` cannot cross-link x86_64 (use a native x64 macOS runner — the `macos-x64` job) |
| macOS universal | assembles in CI from arm64 + x64 addon artifacts | Locally blocked until an x64 addon is produced natively |
| Windows x64 | **CI job prepared; not run** | Needs a Windows runner (MSVC + Windows SDK, `rustup target x86_64-pc-windows-msvc`) and optional Authenticode cert; local host has no MSVC/link.exe/signtool |
| Linux x64 | **CI job prepared; not run** | Needs a Linux runner (build-essential/pkg-config, Vulkan/GLES libs, ffmpeg, fonts); local host has no Linux cross linker and Docker daemon is unavailable |
| Linux arm64 / Windows arm64 | not configured | The workflow currently covers x64; add matrix entries once x64 is green |

The big source-level blocker from the previous record (wgpu `wgsl+metal` only) is **resolved** by
media-dev's change (§2); the remaining blockers are external runners and credentials.

## 6. CI workflow and release matrix

`.github/workflows/route-b-platform.yml`:

- **Triggers:** `pull_request` on Route B paths; `workflow_dispatch` with inputs `sign` (default
  false) and `enforce_cross_platform` (default false). No push/tag trigger, so it cannot publish.
- **Permissions:** `contents: read` only. `concurrency` cancels superseded runs.
- **All third-party actions pinned to full commit SHAs** (validated by `validate-workflows.sh`).

| Job | Runner | What it does | Signing |
|---|---|---|---|
| `preflight` | ubuntu-latest | wgpu readiness → job outputs; YAML/script validation; readiness summary | — |
| `macos-arm64` | macos-14 | build web, build arm64 addon, optional sign, pack arm64 tarball, verify/inspect/ABI, upload tarball + `route-b-addon-darwin-arm64` | optional |
| `macos-x64` | macos-13 | build web, build x64 addon natively (runtime evidence), optional sign, pack x64 tarball, verify/ABI, upload tarball + `route-b-addon-darwin-x64` | optional |
| `macos-universal` | macos-14 | download both addon artifacts, build web, optional sign/notarize, pack **universal** tarball, verify, upload | optional |
| `windows-x64` | windows-2022 | build web/addon (MSVC), optional Authenticode sign, pack, verify, upload | optional |
| `linux-x64` | ubuntu-22.04 | apt deps (ffmpeg/Vulkan/fonts), build web/addon, pack, verify, upload | unsigned (Linux has no CI signing step) |
| `cross-platform-pending` | ubuntu-latest | annotates skipped Windows/Linux jobs; fails only when dispatch sets `enforce_cross_platform=true` | — |

Signing steps are gated by `github.event_name == 'workflow_dispatch' && inputs.sign == true` **and**
the relevant secret being non-empty; pull requests never receive secrets and always produce unsigned
CI artifacts. These jobs cannot be executed from this host; their first real run is pending a push /
dispatch to GitHub.

### 6.1 Release matrix

| Artifact | Producer the job | Signature | Intended use |
|---|---|---|---|
| `opentake-studio-route-b-<ver>-darwin-universal.tgz` | `macos-universal` | Developer ID addons; notarized `.pkg` when `sign=true` | Release |
| `…-darwin-arm64.tgz` / `…-darwin-x64.tgz` | mac arch jobs | Developer ID when `sign=true` | Release per-arch, or CI evidence |
| `…-win32-x64.tgz` | `windows-x64` | Authenticode when `sign=true` | Release only when signed |
| `…-linux-x64.tgz` | `linux-x64` | Unsigned (no Linux CI signing policy) | Internal/evaluation until a signing policy exists |
| Any tarball from a run without secrets | all | **Unsigned** | Internal/dev only — not for distribution |

### 6.2 Required secrets

| Secret | Used by | Required | Notes |
|---|---|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | mac jobs | for signed builds | Developer ID Application cert+key, base64 of `.p12` |
| `APPLE_CERTIFICATE_P12_PASSWORD` | mac jobs | for signed builds | `.p12` password |
| `APPLE_KEYCHAIN_PASSWORD` | mac jobs | for signed builds | temporary CI keychain password |
| `APPLE_SIGNING_IDENTITY` | mac jobs | optional | exact identity; otherwise discovered from the keychain |
| `APPLE_INSTALLER_IDENTITY` | `macos-universal` | for notarized pkg | Developer ID Installer identity (`productsign`) |
| `APPLE_NOTARY_PROFILE` | `macos-universal` | preferred for notarization | pre-provisioned `notarytool` keychain profile |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | `macos-universal` | alternative notarization | used when no `APPLE_NOTARY_PROFILE` |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | `windows-x64` | for signed builds | Authenticode `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | `windows-x64` | for signed builds | `.pfx` password |
| `WINDOWS_TIMESTAMP_URL` | `windows-x64` | optional | defaults to `http://timestamp.digicert.com` |

Store secrets in GitHub protected environments/branches; never in the repository. No secrets or
signing identities exist on this machine (`security find-identity` → 0), so every signing/notarization
path here is unexecuted.

### 6.3 Unsigned fallback scope (macOS-only for release)

- A `workflow_dispatch` run with `sign=false`, or any run where secrets are absent, still builds,
  packages and verifies macOS artifacts. Those are **unsigned/internal/dev artifacts** — they are not
  notarized, not Gatekeeper-friendly, and must not be published.
- Windows/Linux unsigned tarballs are **CI evidence only**; there is no unsigned release fallback for
  those platforms.
- There is no unsigned fallback for a public mac release either; the fallback scope is limited to
  internal evaluation and debugging.

## 7. Signing/notarization scripts (templates; not executed)

Local status: `security find-identity -v -p codesigning` → **0 valid identities**; no notarytool
profile; no Windows certificate/signtool. The scripts below are implemented but have not been run.

### macOS — `scripts/route-b/platform/sign-macos.sh`

Imports `APPLE_CERTIFICATE_P12_BASE64` into a temporary keychain, discovers the Developer ID
Application identity, signs every `native/*/*.node` with hardened runtime + timestamp, verifies each
signature, and optionally builds a `.pkg`, signs it with `APPLE_INSTALLER_IDENTITY`, submits to
`notarytool`, staples and runs `spctl`. Without secrets it prints `SKIP` (unsigned fallback) and exits
0; `--require` exits 78.

```bash
# Template only — requires the secrets above and a real Developer ID identity.
./scripts/route-b/platform/sign-macos.sh --require --notarize
```

Caveat: DSH itself (Electron) must also be signed/notarized; hardened-runtime library validation may
reject a differently-signed `.node`. This is unverified against a signed DSH build; see
[route-b-packaging.md](route-b-packaging.md).

### Windows — `scripts/route-b/platform/sign-windows.ps1`

Decodes `WINDOWS_CERTIFICATE_PFX_BASE64`, locates `signtool.exe` (PATH or Windows Kits), signs each
`native/*/*.node` with SHA-256 + timestamp, and verifies with `signtool verify /pa`. Without secrets it
prints `SKIP`; `-Require` exits 78. Not executed or locally validated (no PowerShell/Windows host).

```powershell
# Template only — requires a Windows runner and an Authenticode certificate.
./scripts/route-b/platform/sign-windows.ps1 -Require
```

### Linux

No CI signing step: Linux has no single mandatory binary-signing mechanism. Recommended release
practice is `SHA256SUMS` plus an optional GPG detached signature; distro package signing policy is
TBD. No Linux artifact exists yet.

## 8. Issues found

1. **x64 cross-build is now blocked by `ort-sys`** on arm64 hosts: `ort does not provide prebuilt
   binaries for the target x86_64-apple-darwin`. CI builds x64 natively on `macos-13` and assembles
   the universal package from both native artifacts instead of cross-building. Local universal
   packaging is therefore not reproducible on this host.
2. **The earlier universal tarball is stale** (v28 addons, pre-`ui/`/`lib/` changes) and must not be
   shipped; the fresh local arm64 tarball is v38. CI's `macos-universal` job is the supported producer.
3. **x64 addon is unsigned and both addons embed absolute build-machine install names.** Signing
   fixes the former; the install name should become `@rpath/...` or be stripped.
4. **No Windows/Linux build or runtime evidence exists yet.** CI jobs are prepared but have never run;
   treat them as pending external runners.
5. **No signing/notarization has been executed.** Zero local identities, no notarytool profile, no
   Windows certificate; the scripts are templates and the unsigned fallback is internal-only.
6. **`macos-13` runner availability** is assumed for the x64 job; if GitHub has retired it, switch to
   a self-hosted x64 macOS runner. This is unverified here.
7. **CI signing is opt-in via dispatch.** There is no tag-driven release job; publishing remains out of
   scope.
8. **The v38 addon is much larger than the v28 spike (43.2 MiB).** The local suite therefore runs
   `abi-compat.mjs --no-load` after `verify-package.mjs` to avoid loading the addon twice; CI does the
   same. This is a local/CI tuning choice, not an ABI result.

## 9. Reproduction commands

```bash
# Local checks that can run on this host
node scripts/route-b/platform/check-wgpu-features.mjs
node scripts/route-b/platform/validate-workflows.sh
./scripts/route-b/platform/build-web.sh --check
./scripts/route-b/platform/env-audit.mjs
node scripts/route-b/platform/package-matrix.mjs --check

# macOS arm64 build + package + verification (arm64-only package)
./scripts/build-route-b-addon.sh
./scripts/route-b/platform/package-from-native.sh
node scripts/route-b/platform/verify-package.mjs
node scripts/route-b/platform/abi-compat.mjs
node scripts/route-b/platform/inspect-native.mjs

# Signing smoke (skips without secrets)
./scripts/route-b/platform/sign-macos.sh

# Everything above plus the absence-reporting build preflights
./scripts/route-b/platform/run-all.sh
```

## 10. Conclusion and pending external resources

- **Local (macOS arm64):** wgpu preflight ready for all platforms; arm64 v38 addon builds and loads;
  arm64 tarball packages and passes verify/ABI; CI YAML/scripts validate. **32/1/0** on
  `verify-package.mjs` for the fresh arm64 tarball.
- **Pending external resources:** GitHub macOS x64 runner (and availability of `macos-13`), Windows
  runner with MSVC/Windows SDK, Linux runner with Vulkan/GLES + ffmpeg, Apple Developer ID
  certificate/notarization credentials, Windows Authenticode certificate. Without them, Windows/Linux
  runtime and any signing/notarization remain **pending**, not verified.
- **Not claimed:** Windows/Linux builds, x64 runtime behavior, signed/notarized artifacts, or a Green
  cross-platform CI run.
