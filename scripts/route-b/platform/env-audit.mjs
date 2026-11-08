#!/usr/bin/env node
/**
 * Audit the host toolchains available for Route B cross-platform builds.
 *
 * Prints (or emits as JSON) the host OS/arch, Node, Rust toolchain and installed
 * targets, cross-compilation tooling, container runtimes, code-signing identity
 * availability, and package tooling. This is evidence for
 * `docs/architecture/route-b-platform.md`; it does not build anything.
 *
 * Usage: node scripts/route-b/platform/env-audit.mjs [--json]
 */
import os from 'node:os';

import { commandExists, run } from './lib.mjs';

const jsonOnly = process.argv.slice(2).includes('--json');

function firstLine(text) {
  return text.trim().split('\n')[0] ?? '';
}

function rustInfo() {
  const result = run('sh', ['-c', 'source "$HOME/.cargo/env" 2>/dev/null; rustc -vV'], { timeout: 20_000 });
  if (result.status !== 0) return { available: false };
  const text = result.stdout;
  const version = /^rustc (\S+)/m.exec(text)?.[1] ?? null;
  const host = /^host: (\S+)/m.exec(text)?.[1] ?? null;
  return { available: true, version, host };
}

function rustTargets() {
  const result = run('sh', ['-c', 'source "$HOME/.cargo/env" 2>/dev/null; rustup target list --installed'], { timeout: 20_000 });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function dockerInfo() {
  if (!commandExists('docker')) return { command: false };
  const info = run('docker', ['info', '--format', '{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}'], { timeout: 15_000 });
  const available = info.status === 0 && info.stdout.trim().length > 0;
  const images = available
    ? run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 15_000 }).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return { command: true, daemon: available, detail: available ? info.stdout.trim() : firstLine(info.stderr) || 'daemon unavailable', images };
}

function signingInfo() {
  const codesign = commandExists('codesign');
  const security = commandExists('security');
  let identities = [];
  if (security) {
    const result = run('security', ['find-identity', '-v', '-p', 'codesigning'], { timeout: 20_000 });
    if (result.status === 0) {
      identities = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+\)/.test(line) || /valid identities found/.test(line));
    }
  }
  const notarytool = run('xcrun', ['notarytool', '--help'], { timeout: 15_000 }).status === 0;
  return { codesign, security, identities, notarytool };
}

const host = {
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
  node: process.versions.node,
  napi: process.versions.napi,
};

const toolchains = {
  rust: rustInfo(),
  targets: rustTargets(),
  docker: dockerInfo(),
  podman: commandExists('podman'),
  zig: commandExists('zig'),
  cross: commandExists('cross'),
  cargoZigbuild: commandExists('cargo-zigbuild'),
  xcodeSdk: commandExists('xcrun') ? run('xcrun', ['--show-sdk-version'], { timeout: 10_000 }).stdout.trim() || null : null,
  linkers: {
    clang: commandExists('clang'),
    lld: commandExists('lld'),
    linuxGcc: commandExists('x86_64-linux-gnu-gcc') || commandExists('x86_64-unknown-linux-gnu-gcc'),
    mingw: commandExists('x86_64-w64-mingw32-gcc'),
    llvmMingw: commandExists('x86_64-w64-mingw32-clang'),
  },
  signing: signingInfo(),
  packageTools: { npm: commandExists('npm'), pnpm: commandExists('pnpm'), tar: commandExists('tar') },
};

const audit = { host, toolchains, generatedAt: new Date().toISOString() };

if (jsonOnly) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  const t = toolchains;
  console.log('Route B platform environment audit');
  console.log(`  host          ${host.platform}/${host.arch} (${host.release})`);
  console.log(`  node/n-api    ${host.node} / N-API ${host.napi}`);
  console.log(`  rust          ${t.rust.available ? `${t.rust.version} (${t.rust.host})` : 'MISSING'}`);
  console.log(`  rust targets  ${t.targets.length ? t.targets.join(', ') : 'none'}`);
  console.log(`  xcode sdk     ${t.xcodeSdk ?? 'n/a'}`);
  console.log(`  docker        ${t.docker.command ? (t.docker.daemon ? `daemon ${t.docker.detail}` : `CLI present; ${t.docker.detail}`) : 'MISSING'}`);
  if (t.docker.images?.length) console.log(`  docker images ${t.docker.images.join(', ')}`);
  console.log(`  podman        ${t.podman ? 'present' : 'MISSING'}`);
  console.log(`  zig/cross     ${t.zig ? 'zig' : 'no zig'} · ${t.cross ? 'cross' : 'no cross'} · ${t.cargoZigbuild ? 'cargo-zigbuild' : 'no cargo-zigbuild'}`);
  console.log(
    `  linkers       clang=${t.linkers.clang} lld=${t.linkers.lld} linux-gcc=${t.linkers.linuxGcc} mingw=${t.linkers.mingw}`,
  );
  console.log(`  codesign      ${t.signing.codesign ? 'present' : 'MISSING'} · identities: ${t.signing.identities.length ? t.signing.identities.join(' | ') : '0 valid'}`);
  console.log(`  notarytool    ${t.signing.notarytool ? 'present' : 'MISSING'}`);
  console.log(`  package tools npm=${t.packageTools.npm} pnpm=${t.packageTools.pnpm} tar=${t.packageTools.tar}`);
}
