# Route B platform: Linux/Windows builds and package verification

> Status: draft · partial verification · branch `feat/dsh-rust-engine` · recorded 2026-11-08
>
> This page records the cross-platform build prerequisites for the Route B native addon, the checks
> that were actually executed, and what was **not** completed. macOS arm64 is the only target with
> runtime evidence; macOS x64 was built and statically inspected but could not run (no Rosetta);
> Windows/Linux were not built — this host lacks the toolchains/SDKs/signing credentials, and the
> scripts report that with exit 78. Static inspection is not written up as runtime success, and no
> Windows/Linux result is fabricated.
>
> Related: [route-b-packaging.md](route-b-packaging.md) (earlier packaging notes) ·
> [route-b-media-map.md](route-b-media-map.md) (platform runtime dependencies) ·
> [route-b-parity.md](route-b-parity.md) (U8: cross-platform gap) ·
> [route-b.md](route-b.md) (architecture and milestones)

## 1. New scripts (this deliverable)

| File | Purpose |
|---|---|
| [`verify-package.mjs`](../../scripts/route-b/platform/verify-package.mjs) | Verify a tarball: extract, manifest, web assets, both native binaries, N-API level, and current-platform addon load + newProject/apply/undo/getTimeline smoke |
| [`inspect-native.mjs`](../../scripts/route-b/platform/inspect-native.mjs) | Static `.node` inspection: container/arch/size/SHA-256/minOS/install name/linked libraries/codesign status/N-API symbol (does not execute) |
| [`abi-compat.mjs`](../../scripts/route-b/platform/abi-compat.mjs) | Compare the Host's N-API level with the addon's `napi8` build; load and exercise the minimal Engine contract when the architecture matches; SKIP cross-arch binaries |
| [`package-matrix.mjs`](../../scripts/route-b/platform/package-matrix.mjs) | Scan `native/*` and the bundle manifest; report assemblable tarball names, missing platforms and manifest-coverage problems |
| [`env-audit.mjs`](../../scripts/route-b/platform/env-audit.mjs) | Read-only audit of host/Rust targets/cross linkers/Docker/signing identities/package tooling |
| [`build-linux.sh`](../../scripts/route-b/platform/build-linux.sh) | Linux build preflight; builds only when the target, linker, wgpu backend, etc. genuinely exist and `ROUTE_B_ATTEMPT=1`; otherwise exits 78 with exact blockers |
| [`build-windows.sh`](../../scripts/route-b/platform/build-windows.sh) | Windows build preflight; checks MSVC/mingw, Rust target and Authenticode tooling; exits 78 when blocked |
| [`run-all.sh`](../../scripts/route-b/platform/run-all.sh) | Runs the checks above plus both build preflights (78 from a preflight is expected here; the aggregate still reports check failures) |
| [`lib.mjs`](../../scripts/route-b/platform/lib.mjs) | Read-only helpers: tar extraction, Mach-O/ELF/PE header parsing, SHA-256, manifest `files` matching |

Constraints: these scripts do not modify source, the root `Cargo.toml`, the existing build scripts or
the DSH profile. They read artifacts and write only to a caller-provided temporary directory.

## 2. Artifact under test

- File: `dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz`
- Size: 11.5 MiB compressed, 17 entries after extraction
- SHA-256: `350e103304f64f457254cc7f6ef8f942237d42f21f53f95b3bea95823d343253`
- Built: 2026-11-08 21:08 on this machine

Package layout:

```
package/
├── package.json                    @opentake/studio-route-b@0.1.0 (private)
├── index.js                        Host half (77.1 KiB)
├── client.js                       DSH client shell (2.8 KiB)
├── cordis.patch.yml                inserts the opentake-studio-route-b row
├── README.md
├── web/
│   ├── index.html                  references tauri-shim.js + hashed app JS/CSS
│   ├── tauri-shim.js               ~8.0 KiB
│   └── assets/index-DeeYDWaC.js    1.5 MiB
│       assets/index-Cv9Zqe2A.css   28.7 KiB
│       ...                         Tauri API/shim chunks
└── native/
    ├── darwin-arm64/opentake_engine_v28.node   16.6 MiB
    └── darwin-x64/opentake_engine_v28.node     17.1 MiB
```

`package.json` declares `dsh.bundle.patch`, `dsh.client.platform: "web"`, `exports["./client"]`, and
its `files` list covers all 17 extracted files (checked by `verify-package.mjs`).

## 3. Checks executed and their results

Environment: macOS Darwin arm64 host · Node 26.13.0 / N-API 10 · rustc 1.99.1 · Xcode SDK 27.2 ·
no Rosetta.

| Command | Result |
|---|---|
| `node scripts/route-b/platform/verify-package.mjs` | **35 PASS · 2 WARN · 0 FAIL**, exit 0 |
| `node scripts/route-b/platform/abi-compat.mjs` | **OK**: Host N-API 10 ≥ 8; arm64 addon architecture matches; `napi_register_module_v1` present; `newProject/apply/undo/getTimeline` pass |
| `node scripts/route-b/platform/inspect-native.mjs --tarball …` | 2 binaries; arm64 is Mach-O with ad-hoc signature; x64 is Mach-O and **unsigned**; both minOS 11.0, only system frameworks linked |
| `node scripts/route-b/platform/package-matrix.mjs --check` | **OK**: `opentake-studio-route-b-0.1.0-darwin-universal.tgz` is assemblable; linux/win32 not built |
| `./scripts/route-b/platform/build-linux.sh` | **exit 78 (BLOCKED)**, 4 missing prerequisites; no build attempted |
| `./scripts/route-b/platform/build-windows.sh` | **exit 78 (BLOCKED)**, 5 missing prerequisites; no build attempted |
| `./scripts/route-b/platform/run-all.sh` | exit 0 (checks passed; both preflights 78 as expected) |

Both `verify-package.mjs` warnings are install names: each binary embeds the build machine's absolute
path in `LC_ID_DYLIB`:

- arm64: `/Users/cliffleopard/Develop/.../target/release/deps/libopentake_node.dylib`
- x64: `/Users/cliffleopard/Develop/.../target/x86_64-apple-darwin/release/deps/libopentake_node.dylib`

This does not break Node loading (it is the library ID, not a runtime dependency), but it leaks the
build path and hurts reproducibility. Before shipping, set `-install_name @rpath/opentake_engine.node`
or strip it.

### 3.1 Native binary static results

| Target | Format/arch | Size | SHA-256 | minOS | Signature | N-API symbol |
|---|---|---|---|---|---|---|
| darwin-arm64 | Mach-O / arm64 | 16.6 MiB (17,360,376 B) | `66de5f82…e13eada1` | 11.0 | ad-hoc (linker-signed) | `napi_register_module_v1` |
| darwin-x64 | Mach-O / x64 | 17.1 MiB (17,916,160 B) | `f0013376…f22f116763` | 11.0 | **unsigned** | `napi_register_module_v1` |

Both link only system libraries/frameworks (QuartzCore, Metal, CoreGraphics, CoreFoundation,
libSystem, libobjc, libiconv) — no `/opt/homebrew` or third-party dylib dependency. This matches the
boundary that ffmpeg/ffprobe are CLI children and libav is not linked into the addon.

### 3.2 ABI and runtime load

- Host: Node 26.13.0, N-API 10; the addon is built with the `napi8` feature
  (`crates/opentake-node/Cargo.toml`).
- Both `abi-compat.mjs` and `verify-package.mjs` actually `require()` the arm64 addon and complete
  newProject → `setTimelineSettings` apply → undo → getTimeline. They agree.
- The x64 addon cannot run here: `arch -x86_64 /usr/bin/true` fails, so Rosetta is absent. x64
  therefore has build + header evidence only, **no runtime evidence**.

## 4. Platform matrix: actual status and blockers

| Target | Runtime prerequisites | Current status | Exact blockers |
|---|---|---|---|
| macOS arm64 | Xcode CLT/SDK, Rust target, Metal | **built + runtime verified (this task)** | — |
| macOS x64 | Same (x86_64-apple-darwin target) | **built, static checks pass, not run** | No Rosetta; no `arch -x86_64` compatibility run |
| Windows x64 | Windows + VS Build Tools/MSVC + Windows SDK (or xwin/llvm-mingw cross), Rust target, ffmpeg.exe/ffprobe.exe, Authenticode certificate | **not built** | (1) `x86_64-pc-windows-msvc` target not installed; (2) no MSVC/mingw linker and this host is not Windows; (3) `opentake-render` enables only `wgsl+metal`, Windows needs the dx12 backend feature (source change outside this task); (4) no `signtool`, no certificate; (5) Docker daemon unreachable |
| Linux x64 | Linux host/CI, build-essential + cross linker, Vulkan/GLES, Rust target, ffmpeg | **not built** | (1) `x86_64-unknown-linux-gnu` target not installed; (2) no Linux cross linker; (3) `opentake-render` needs vulkan/gles features (source change); (4) Docker daemon unreachable |
| Linux arm64 / Windows arm64 | As above plus the matching target | **not attempted** | Same toolchain/backend blockers as x64; scripts default to x64 and accept `ROUTE_B_LINUX_TARGET` / `ROUTE_B_WINDOWS_TARGET` |

`build-linux.sh` and `build-windows.sh` exit 78 on preflight failure and do not build.
`ROUTE_B_ATTEMPT=1` only invokes the existing `scripts/build-route-b-addon.sh` (or a
`ROUTE_B_DOCKER_IMAGE` container build) when the prerequisites are genuinely present. This machine
did **not** install Rust targets, start Docker, or create signing certificates to manufacture results.

## 5. Toolchain requirements by platform

| Platform | Build requirements | Runtime requirements | Notes |
|---|---|---|---|
| macOS arm64/x64 | Xcode Command Line Tools + SDK (27.2 here), `rustup` targets (aarch64/x86_64-apple-darwin), cargo; Developer ID certificate for distribution | macOS 11+, system ffmpeg/ffprobe, Metal | Native arm64 build; x64 cross-build works, runtime needs an x64 runner/machine |
| Windows x64 | Windows host + Visual Studio Build Tools (MSVC + Windows SDK) or `cargo-xwin`/llvm-mingw; `x86_64-pc-windows-msvc` target; **wgpu dx12 feature must be added first** | Windows 10/11, bundled or PATH ffmpeg/ffprobe, D3D12 | Cross-building from macOS is unsupported and unverified |
| Linux x64/arm64 | Linux host/CI; build-essential, pkg-config, fonts; matching Rust target; **wgpu vulkan/gles features must be added first**; ffmpeg/ffprobe | Linux with a glibc floor, system ffmpeg, Vulkan or software rendering | Headless CI needs llvmpipe/swiftshader or must skip GPU paths |

Fonts: text rasterization uses cosmic-text/fontdb scanning system fonts; minimal Linux containers
need fonts installed. Motion uses headless Chrome (outside the addon); Windows needs a Chrome/Edge
path, Linux needs `google-chrome*`/`chromium`. These details agree with
[route-b-media-map.md](route-b-media-map.md) §7.

## 6. Recommended CI matrix

| Job | Runner | Steps |
|---|---|---|
| `macos-arm64` | `macos-14`/`macos-15` | Build web (`pnpm --dir web build --base=…`) → `./scripts/build-route-b-addon.sh` → `./scripts/package-route-b.sh` → `node scripts/route-b/platform/verify-package.mjs` → `abi-compat.mjs` → sign/notarize (secrets) → upload tarball |
| `macos-x64` | `macos-13` | Same, with `ROUTE_B_TARGET=x86_64-apple-darwin`; use an x64 runner so the x64 addon actually executes — do not rely on a cross-build alone |
| `windows-x64` | `windows-2022` | Install Rust MSVC + ffmpeg; add the dx12 feature to `opentake-render` first; `cargo build -p opentake-node --release`; `verify-package.mjs`; `signtool` sign (certificate secret) |
| `linux-x64` | `ubuntu-22.04` | Install Rust + build-essential + ffmpeg + Vulkan/fonts; add vulkan/gles features first; build/package/verify; accept software rendering or skip GPU E2E when no GPU runner |

Each job should upload `verify-package.mjs --json`, the tarball and `inspect-native.mjs` output; run
`codesign --verify` on macOS and `signtool verify /pa` on Windows; publish `SHA256SUMS` on Linux.
Cross-platform acceptance cannot be extrapolated from macOS results (parity matrix U8).

## 7. Signing/notarization command templates (not executed)

`security find-identity -v -p codesigning` reports **0 valid identities**; `xcrun notarytool` exists
but no credentials are configured. The commands below are templates only — this task signed or
notarized nothing.

### macOS (Developer ID + notarization)

```bash
# 1) Sign each .node with hardened runtime and a timestamp
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: <Team Name> (<TEAMID>)" \
  plugins/opentake-studio-route-b/native/darwin-arm64/opentake_engine_v28.node
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: <Team Name> (<TEAMID>)" \
  plugins/opentake-studio-route-b/native/darwin-x64/opentake_engine_v28.node

# 2) Verify before packaging
codesign --verify --strict --verbose=2 plugins/opentake-studio-route-b/native/darwin-*/opentake_engine_v28.node

# 3) Package the signed payload (zip or pkg), then notarize and staple
ditto -c -k --keepParent plugins/opentake-studio-route-b \
  dist/opentake-studio-route-b-signed.zip
xcrun notarytool submit dist/opentake-studio-route-b-signed.zip \
  --keychain-profile "<notarytool-profile>" --wait
xcrun stapler staple dist/opentake-studio-route-b-signed.zip

# 4) Gatekeeper check
spctl -a -vv -t install dist/opentake-studio-route-b-signed.zip
```

Caveat: the addon is ultimately loaded by DSH (Electron). The DSH distribution must also be
signed/notarized; with hardened runtime/library validation, loading a `.node` signed by the same or a
different team may be rejected. This has **not** been verified against a signed DSH build. The
existing [route-b-packaging.md](route-b-packaging.md) already requires signing/notarizing the `.node`
and DSH together, or an installer that signs the plugin payload.

### Windows (Authenticode)

```cmd
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /f <certificate.pfx> /p <password> ^
  plugins\opentake-studio-route-b\native\win32-x64\opentake_engine_v28.node
signtool verify /pa /v plugins\opentake-studio-route-b\native\win32-x64\opentake_engine_v28.node
```

Windows was not built, `signtool` is absent and no certificate exists; the template was not executed.

### Linux

Linux has no single mandatory binary-signing mechanism. Recommended: publish `SHA256SUMS` and an
optional detached GPG signature (`gpg --detach-sign --armor SHA256SUMS`); distro package signing
(deb/rpm/AppImage) is a separate policy decision. No Linux artifact exists yet.

## 8. Issues found in this run

1. **x64 addon is unsigned; arm64 is only ad-hoc signed.** That is the real state of the current
   universal tarball and is not distributable. Both architectures need Developer ID signing and
   notarization before release.
2. **Both `.node` files embed an absolute build-machine install name.** Recommend
   `-install_name @rpath/opentake_engine.node` (or a link-arg equivalent) and strip before packaging;
   it does not affect loading today but hurts reproducibility and leaks paths.
3. **No x64 runtime evidence.** No Rosetta on this machine; only an x64 macOS runner or machine can
   supply it.
4. **Windows/Linux lack not just toolchains but wgpu backend features.** `opentake-render` currently
   builds `wgpu` with `features = ["wgsl", "metal"]`; until `dx12`/`vulkan`/`gles` are added, even a
   correctly provisioned CI job fails. That is a source prerequisite outside this task's write scope.
5. **Docker is unavailable.** The CLI exists but the daemon socket does not
   (`dial unix /var/run/docker.sock`), so no containerized Linux build was attempted; pulling images
   was not assumed to be possible.
6. **Signing credentials are missing.** Zero codesigning identities, no notarytool profile, no
   Windows certificate; every signing/notarization command remains a template.

## 9. Reproduction commands

```bash
# Read-only environment audit
node scripts/route-b/platform/env-audit.mjs

# Package verification (defaults to the newest dist/*.tgz; --json for machine-readable output)
node scripts/route-b/platform/verify-package.mjs
node scripts/route-b/platform/verify-package.mjs --tarball dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz --json

# Native static inspection / ABI
node scripts/route-b/platform/inspect-native.mjs plugins/opentake-studio-route-b/native/darwin-arm64/
node scripts/route-b/platform/inspect-native.mjs --tarball dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz
node scripts/route-b/platform/abi-compat.mjs

# Package matrix and the whole check set
node scripts/route-b/platform/package-matrix.mjs --check
./scripts/route-b/platform/run-all.sh

# Platform build preflights (expected exit 78 on this host)
./scripts/route-b/platform/build-linux.sh
./scripts/route-b/platform/build-windows.sh
```

## 10. Conclusion

- The only target with “executed” evidence remains **macOS arm64**; the x64 half of the universal
  package has build and static evidence, no runtime evidence.
- **Windows/Linux were not built or run.** The blockers are missing SDKs/cross linkers, missing wgpu
  backend features and missing signing tools/certificates — not “verified but unknown”.
- The new scripts make those gaps repeatable: `verify-package.mjs` passing means the package layout
  and the current platform's ABI work, **not** cross-platform parity. Cross-platform conclusions must
  come from `verify-package.mjs` plus a runtime E2E on the corresponding runner.
