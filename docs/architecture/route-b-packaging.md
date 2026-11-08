# Route B packaging

Platform-specific packages are tarballs containing the DSH plugin plus the
Node-API engine binary for that platform. A package is **not** portable across
OS/arch: the `.node` file is a native Mach-O/ELF/PE image.

## Build a package (current platform)

```bash
./scripts/package-route-b.sh
# -> dist/opentake-studio-route-b-<version>-<os>-<arch>.tgz
```

The script builds `crates/opentake-node`, copies the addon into
`plugins/opentake-studio-route-b/native/<os>-<arch>/`, and runs `npm pack`.
The tarball includes `index.js`, `client.js`, `web/**`, and the native binary.

Requires: Rust stable + platform C toolchain, Node 20+, pnpm only for rebuilding
the web UI. The checked-in `web/` is the built React app.

## Install in DSH

Install the tarball as a DSH plugin bundle (same flow as the local folder).
The plugin serves its own React app from `/opentake-studio-route-b/app/`.

## Platform matrix (not yet built/tested)

| Target | Engine needs | Status |
|---|---|---|
| macOS arm64 | Metal/wgpu, system ffmpeg | built + tested |
| macOS x64 | Metal/wgpu, system ffmpeg | not built |
| Windows x64 | D3D12/wgpu, bundled ffmpeg expected | not built |
| Linux x64 | Vulkan/wgpu, system ffmpeg | not built |

## ABI and signing

- N-API 8; DSH's Electron Node 24 loaded the addon with N-API 10.
- Addon is ad-hoc/linker-signed on macOS. Shipping outside the dev machine
  requires Developer ID signing + notarization for the `.node` **and** the DSH
  distribution, or an installer that signs the plugin payload.
- Windows requires an Authenticode signature; Linux packaging policy is TBD.
- The native binary is gitignored; packages are built per platform.

## Open items

- CI matrix for Rust + web build and addon smoke test.
- macOS x64/Windows/Linux builds and GPU/ffmpeg runtime verification.
- Code signing/notarization and updater story for plugin binaries.
