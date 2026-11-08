/**
 * Shared helpers for Route B cross-platform artifact inspection.
 *
 * These utilities are read-only: they parse package tarballs and native
 * binaries, hash files, and resolve the layout expected by
 * `scripts/package-route-b.sh`. Nothing here writes outside a caller-provided
 * temporary directory.
 *
 * No third-party dependencies; Node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, so the scripts work from any current directory. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Supported native directory names, matching scripts/build-route-b-addon.sh. */
export const NATIVE_TARGETS = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', format: 'macho', binary: 'Mach-O' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', format: 'macho', binary: 'Mach-O' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', format: 'elf', binary: 'ELF' },
  'linux-x64': { platform: 'linux', arch: 'x64', format: 'elf', binary: 'ELF' },
  'win32-arm64': { platform: 'win32', arch: 'arm64', format: 'pe', binary: 'PE' },
  'win32-x64': { platform: 'win32', arch: 'x64', format: 'pe', binary: 'PE' },
};

export const MACOS_MIN_OS = '11.0';

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  visit(root);
  return out;
}

export function newestTarball(distDir = 'dist') {
  if (!fs.existsSync(distDir)) return null;
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(distDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

/** Extract a tarball with the system `tar` (present on macOS, Linux, and Windows 10+). */
export function extractTarball(tarball, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destination], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw new Error(`tar failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`tar exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return destination;
}

/** Locate the npm pack package root (`package/`, or a flat directory). */
export function locatePackageRoot(extractDir) {
  const direct = path.join(extractDir, 'package');
  if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  if (fs.existsSync(path.join(extractDir, 'package.json'))) return extractDir;
  const entries = fs.existsSync(extractDir)
    ? fs.readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  for (const entry of entries) {
    const candidate = path.join(extractDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readUInt32BE(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

const MACHO_CPU = {
  0x0000000c: 'arm',
  0x0100000c: 'arm64',
  0x00000007: 'x86',
  0x01000007: 'x64',
  0x01000012: 'ppc64',
};

const ELF_MACHINE = {
  0x03: 'x86',
  0x3e: 'x64',
  0x28: 'arm',
  0xb7: 'arm64',
  0x08: 'mips',
};

const PE_MACHINE = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x01c4: 'arm',
};

function parseMachO(buffer) {
  const magicLE = readUInt32LE(buffer, 0);
  const magicBE = readUInt32BE(buffer, 0);
  // Thin 64-bit little-endian Mach-O.
  if (magicLE === 0xfeedfacf) {
    const cpuType = readUInt32LE(buffer, 4);
    const fileType = readUInt32LE(buffer, 12);
    const ncmds = readUInt32LE(buffer, 16);
    let offset = 32;
    let minOs = null;
    let installName = null;
    const dylibs = [];
    for (let index = 0; index < ncmds && offset + 8 <= buffer.length; index += 1) {
      const cmd = readUInt32LE(buffer, offset);
      const cmdsize = readUInt32LE(buffer, offset + 4);
      if (cmdsize < 8 || offset + cmdsize > buffer.length) break;
      if (cmd === 0x32 /* LC_BUILD_VERSION */) {
        minOs = `${readUInt32LE(buffer, offset + 12) >> 16}.${(readUInt32LE(buffer, offset + 12) >> 8) & 0xff}`;
      } else if (cmd === 0x24 /* LC_VERSION_MIN_MACOSX */) {
        minOs = `${readUInt32LE(buffer, offset + 8) >> 16}.${(readUInt32LE(buffer, offset + 8) >> 8) & 0xff}`;
      } else if (cmd === 0x0d /* LC_ID_DYLIB */) {
        const nameOffset = readUInt32LE(buffer, offset + 8);
        installName = buffer
          .subarray(offset + nameOffset, offset + cmdsize)
          .toString('utf8')
          .replace(/\0.*$/, '');
      } else if (cmd === 0x0c /* LC_LOAD_DYLIB */) {
        const nameOffset = readUInt32LE(buffer, offset + 8);
        dylibs.push(
          buffer
            .subarray(offset + nameOffset, offset + cmdsize)
            .toString('utf8')
            .replace(/\0.*$/, ''),
        );
      }
      offset += cmdsize;
    }
    return {
      format: 'macho',
      arch: MACHO_CPU[cpuType] ?? `cpu-0x${cpuType.toString(16)}`,
      bits: 64,
      fileType,
      minOs,
      installName,
      dylibs,
    };
  }
  // Fat Mach-O (universal).
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const count = readUInt32BE(buffer, 4);
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * 20;
      if (base + 20 > buffer.length) break;
      const cpuType = readUInt32BE(buffer, base);
      architectures.push(MACHO_CPU[cpuType] ?? `cpu-0x${cpuType.toString(16)}`);
    }
    return { format: 'macho-fat', arch: architectures.join('+'), bits: 64, architectures };
  }
  return null;
}

function parseElf(buffer) {
  if (buffer.subarray(0, 4).toString('binary') !== '\x7fELF') return null;
  const elfClass = buffer[4];
  const little = buffer[5] === 1;
  const machine = little ? readUInt16LE(buffer, 18) : buffer.readUInt16BE(18);
  return {
    format: 'elf',
    arch: ELF_MACHINE[machine] ?? `machine-0x${machine.toString(16)}`,
    bits: elfClass === 2 ? 64 : 32,
  };
}

function parsePe(buffer) {
  if (buffer.subarray(0, 2).toString('ascii') !== 'MZ') return null;
  const peOffset = readUInt32LE(buffer, 0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') return null;
  const machine = readUInt16LE(buffer, peOffset + 4);
  return {
    format: 'pe',
    arch: PE_MACHINE[machine] ?? `machine-0x${machine.toString('16')}`,
    bits: buffer.readUInt16LE(peOffset + 24) === 0x20b ? 64 : 32,
  };
}

/**
 * Parse a native shared library's container format and architecture without
 * executing it. Returns `{ format:'unknown', arch:'unknown' }` for anything
 * unrecognized rather than guessing.
 */
export function readBinaryInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  const info = parseMachO(buffer) ?? parseElf(buffer) ?? parsePe(buffer) ?? { format: 'unknown', arch: 'unknown' };
  return {
    ...info,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** Spawn a command and return { status, stdout, stderr, error } without throwing. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

export function commandExists(command) {
  return run('sh', ['-c', `command -v ${command}`], { timeout: 10_000 }).status === 0;
}

/** Expected native directories for a package name like `...-darwin-universal.tgz`. */
export function expectedNativeDirs(tarballName) {
  const match = /-(darwin|linux|win32)-(universal|arm64|x64)\.tgz$/.exec(tarballName);
  if (!match) return null;
  const [, platform, arch] = match;
  if (arch === 'universal') {
    return Object.entries(NATIVE_TARGETS)
      .filter(([, target]) => target.platform === platform)
      .map(([name]) => name)
      .sort();
  }
  const name = `${platform}-${arch}`;
  return NATIVE_TARGETS[name] ? [name] : null;
}

/**
 * Parse local script/link references from `web/index.html` and map URLs under
 * the plugin app base to files under `web/`.
 */
export function parseWebReferences(indexHtml, webRoot, baseUrl = '/opentake-studio-route-b/app/') {
  const refs = [];
  const pattern = /<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(indexHtml)) !== null) {
    const url = match[1];
    if (url.startsWith('data:') || url.startsWith('http:') || url.startsWith('https:')) continue;
    const clean = url.split('?')[0].split('#')[0];
    const relative = clean.startsWith(baseUrl) ? clean.slice(baseUrl.length) : clean.replace(/^\/+/, '');
    refs.push({ url, relative, absolute: path.join(webRoot, relative) });
  }
  return refs;
}

/** Does a package `files` entry cover a package-relative path? Supports the globs used in package.json. */
export function filesEntryCovers(pattern, relative) {
  if (pattern === relative) return true;
  if (pattern === 'web/**') return relative === 'web' || relative.startsWith('web/');
  if (pattern === 'native/*/*.node') return /^native\/[^/]+\/[^/]+\.node$/.test(relative);
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relative === prefix || relative.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith('*.')) {
    const extension = pattern.slice(1);
    return relative.endsWith(extension) && !relative.includes('/');
  }
  return false;
}

/** Create and return a unique temporary directory; caller removes it. */
export function makeTempDir(prefix = 'routeb-platform-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
