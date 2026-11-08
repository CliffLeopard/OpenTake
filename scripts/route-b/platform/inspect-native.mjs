#!/usr/bin/env node
/**
 * Inspect Route B native addon artifacts without executing them.
 *
 * Reports container format, architecture, size, SHA-256, minimum macOS version,
 * install name, linked libraries, code-signing status (when `codesign` exists)
 * and whether the N-API registration symbol is present.
 *
 * Usage:
 *   node scripts/route-b/platform/inspect-native.mjs [--tarball <path>]
 *       [--json] [paths...]
 *
 * With no paths it inspects `plugins/opentake-studio-route-b/native/{*,*}`.
 * A tarball is extracted to a temporary directory that is removed afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  extractTarball,
  humanBytes,
  locatePackageRoot,
  makeTempDir,
  newestTarball,
  readBinaryInfo,
  removeDir,
  run,
  sha256File,
  walkFiles,
} from './lib.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const jsonOnly = flag('--json');
const tarball = option('--tarball');
const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1] === '--tarball'));

let tempRoot = null;
let roots = positional.map((value) => path.resolve(value));
if (tarball) {
  tempRoot = makeTempDir('routeb-inspect-');
  extractTarball(path.resolve(tarball), tempRoot);
  const packageRoot = locatePackageRoot(tempRoot);
  if (packageRoot === null) {
    console.error('inspect-native: no package root in tarball');
    process.exit(2);
  }
  roots = [path.join(packageRoot, 'native')];
}
if (roots.length === 0) {
  const pluginNative = path.join(REPO_ROOT, 'plugins/opentake-studio-route-b/native');
  if (fs.existsSync(pluginNative)) roots = [pluginNative];
}
if (roots.length === 0) {
  console.error('inspect-native: pass paths, --tarball, or run from the repository root');
  process.exit(2);
}

const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  if (fs.statSync(root).isFile()) files.push(root);
  else files.push(...walkFiles(root).filter((file) => file.endsWith('.node')));
}

function codeSignature(filePath) {
  if (process.platform !== 'darwin') return null;
  const result = run('codesign', ['-dv', '--verbose=2', filePath]);
  // codesign writes to stderr.
  const text = `${result.stdout}\n${result.stderr}`;
  if (/not signed at all/.test(text)) return { status: 'unsigned', detail: 'not signed at all' };
  if (/Signature=adhoc/.test(text) || /flags=0x2?\(adhoc/.test(text) || /adhoc/.test(text)) {
    return { status: 'adhoc', detail: 'ad-hoc signed' };
  }
  const authority = /Authority=([^\n]+)/.exec(text)?.[1] ?? null;
  if (authority) return { status: 'signed', detail: authority };
  return { status: 'unknown', detail: text.trim().split('\n')[0] ?? '' };
}

function napiRegistrationSymbol(filePath) {
  const strings = run('strings', ['-a', filePath]);
  if (strings.status !== 0) return null;
  return /napi_register_module_v1/.test(strings.stdout) ? 'napi_register_module_v1' : 'missing';
}

const records = files.map((filePath) => {
  const info = readBinaryInfo(filePath);
  return {
    path: filePath,
    relative: path.relative(process.cwd(), filePath),
    bytes: info.size,
    sha256: info.sha256,
    format: info.format,
    arch: info.arch,
    bits: info.bits ?? null,
    minOs: info.minOs ?? null,
    installName: info.installName ?? null,
    dylibs: info.dylibs ?? [],
    signature: codeSignature(filePath),
    napiRegister: napiRegistrationSymbol(filePath),
  };
});

if (!jsonOnly) {
  for (const record of records) {
    const display = record.relative.startsWith('..') ? record.path : record.relative;
    console.log(`\n${display}`);
    console.log(`  format/arch  ${record.format}/${record.arch}${record.bits ? ` (${record.bits}-bit)` : ''}`);
    console.log(`  size/sha256  ${humanBytes(record.bytes)} · ${record.sha256}`);
    if (record.minOs) console.log(`  min OS       macOS ${record.minOs}`);
    if (record.installName) console.log(`  install name ${record.installName}`);
    if (record.dylibs.length > 0) console.log(`  linked       ${record.dylibs.join(', ')}`);
    if (record.signature) console.log(`  signature    ${record.signature.status} (${record.signature.detail})`);
    console.log(`  napi symbol  ${record.napiRegister ?? 'unknown'}`);
  }
  console.log(`\ninspect-native: ${records.length} binary(ies)`);
} else {
  console.log(JSON.stringify({ roots, binaries: records }, null, 2));
}

if (tempRoot !== null) removeDir(tempRoot);
process.exit(records.length === 0 ? 1 : 0);
