#!/usr/bin/env node
/**
 * Report the Route B package matrix that this checkout can currently assemble.
 *
 * Scans `plugins/opentake-studio-route-b/native/*` and the bundle manifest,
 * validates the layout the packaging script relies on, and prints the tarball
 * name each platform group would produce. It never builds or packages anything.
 *
 * Usage:
 *   node scripts/route-b/platform/package-matrix.mjs [--json] [--check]
 *
 * `--check` exits non-zero when a locally present native binary or a required
 * manifest entry is invalid. Missing platforms (Windows/Linux here) are
 * reported as NOT BUILT, not as failures.
 */
import fs from 'node:fs';
import path from 'node:path';

import { NATIVE_TARGETS, REPO_ROOT, humanBytes, readBinaryInfo } from './lib.mjs';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const checkMode = args.includes('--check');

const pluginDir = path.join(REPO_ROOT, 'plugins/opentake-studio-route-b');
const packagePath = path.join(pluginDir, 'package.json');
const problems = [];
const warnings = [];

if (!fs.existsSync(packagePath)) {
  console.error(`package-matrix: ${packagePath} not found; run from the repository root`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = manifest.version ?? '0.0.0';

if (manifest.name !== '@opentake/studio-route-b') problems.push(`unexpected package name ${manifest.name}`);
if (manifest.private !== true) warnings.push('package is not private; the bundle is intended for local install');
if (manifest?.dsh?.bundle?.patch && !fs.existsSync(path.join(pluginDir, manifest.dsh.bundle.patch))) {
  problems.push(`bundle patch missing: ${manifest.dsh.bundle.patch}`);
}
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md']) {
  if (!fs.existsSync(path.join(pluginDir, required))) problems.push(`missing required file ${required}`);
}
for (const pattern of ['web/**', 'native/*/*.node']) {
  if (!Array.isArray(manifest.files) || !manifest.files.includes(pattern)) {
    problems.push(`package.json files is missing ${pattern}`);
  }
}

const nativeRoot = path.join(pluginDir, 'native');
const targets = [];
if (!fs.existsSync(nativeRoot)) {
  problems.push('native/ directory is missing (no platform build has been placed)');
} else {
  for (const entry of fs.readdirSync(nativeRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const expected = NATIVE_TARGETS[entry.name];
    const dir = path.join(nativeRoot, entry.name);
    const binaries = fs.readdirSync(dir).filter((name) => name.endsWith('.node'));
    if (!expected) {
      problems.push(`native/${entry.name}: not a recognised platform directory`);
      continue;
    }
    if (binaries.length === 0) {
      problems.push(`native/${entry.name}: no .node binary`);
      continue;
    }
    for (const name of binaries) {
      const binaryPath = path.join(dir, name);
      const info = readBinaryInfo(binaryPath);
      const valid = info.format === expected.format && info.arch === expected.arch;
      if (!valid) problems.push(`native/${entry.name}/${name}: expected ${expected.format}/${expected.arch}, got ${info.format}/${info.arch}`);
      targets.push({
        directory: entry.name,
        platform: expected.platform,
        arch: expected.arch,
        binary: name,
        format: info.format,
        detectedArch: info.arch,
        bytes: info.size,
        sha256: info.sha256,
        valid,
      });
    }
  }
}

// Group by platform: more than one arch in a platform group packages as "-universal".
const groups = new Map();
for (const target of targets) {
  if (!groups.has(target.platform)) groups.set(target.platform, []);
  groups.get(target.platform).push(target);
}
const packages = [];
for (const [platform, groupTargets] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const archs = [...new Set(groupTargets.map((target) => target.arch))].sort();
  const archLabel = archs.length > 1 ? 'universal' : archs[0];
  packages.push({
    platform,
    archs,
    tarball: `opentake-studio-route-b-${version}-${platform}-${archLabel}.tgz`,
    targets: groupTargets.map((target) => target.directory),
  });
}

const supportedPlatforms = [...new Set(Object.values(NATIVE_TARGETS).map((target) => target.platform))];
const missingPlatforms = supportedPlatforms.filter((platform) => !groups.has(platform));

if (!jsonOnly) {
  console.log(`Route B package matrix — @opentake/studio-route-b@${version}`);
  console.log(`plugin: ${pluginDir}`);
  console.log('');
  if (targets.length === 0) {
    console.log('  (no native binaries present)');
  } else {
    for (const target of targets) {
      const status = target.valid ? 'OK' : 'INVALID';
      console.log(
        `  ${target.directory.padEnd(14)} ${status.padEnd(8)} ${target.format}/${target.detectedArch} · ${humanBytes(target.bytes)} · ${target.binary}`,
      );
    }
  }
  console.log('');
  console.log('Assemblable packages:');
  if (packages.length === 0) console.log('  none');
  for (const bundle of packages) console.log(`  ${bundle.tarball}  (native: ${bundle.targets.join(', ')})`);
  if (missingPlatforms.length > 0) console.log(`Not built: ${missingPlatforms.join(', ')}`);
  if (warnings.length > 0) {
    console.log('');
    for (const warning of warnings) console.log(`WARN  ${warning}`);
  }
  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.log(`FAIL  ${problem}`);
  }
  console.log('');
  console.log(`package-matrix: ${problems.length === 0 ? 'OK' : 'FAILED'}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
} else {
  console.log(
    JSON.stringify(
      { package: { name: manifest.name, version }, pluginDir, targets, packages, missingPlatforms, problems, warnings, ok: problems.length === 0 },
      null,
      2,
    ),
  );
}

process.exit(checkMode && problems.length > 0 ? 1 : problems.length > 0 ? 1 : 0);
