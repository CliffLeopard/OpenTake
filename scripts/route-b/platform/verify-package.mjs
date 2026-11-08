#!/usr/bin/env node
/**
 * Verify a Route B package tarball before it is installed or shipped.
 *
 * Checks the package manifest and layout, every bundled native binary's
 * container format/architecture, the web app entry and its referenced assets,
 * the Tauri shim contract, the N-API level of the running Host, and — when the
 * current platform's addon is present — loads the engine and performs a small
 * project/edit/undo round-trip.
 *
 * Usage:
 *   node scripts/route-b/platform/verify-package.mjs [--tarball <path>]
 *       [--json] [--keep] [--no-load] [--dist <dir>]
 *
 * Exit codes: 0 = all checks passed; 1 = at least one check failed;
 *             2 = usage/artifact error (for example no tarball found).
 *
 * The script extracts into a throwaway directory and removes it unless --keep
 * is passed. It never installs, signs or executes package code other than the
 * current platform's addon (which is the same engine the DSH Host loads).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  NATIVE_TARGETS,
  REPO_ROOT,
  filesEntryCovers,
  expectedNativeDirs,
  extractTarball,
  humanBytes,
  locatePackageRoot,
  makeTempDir,
  newestTarball,
  parseWebReferences,
  readBinaryInfo,
  removeDir,
  sha256File,
  walkFiles,
} from './lib.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);

const jsonOnly = flag('--json');
const keep = flag('--keep');
const noLoad = flag('--no-load');
const distDir = path.resolve(option('--dist') ?? path.join(REPO_ROOT, 'dist'));
const tarball = path.resolve(option('--tarball') ?? newestTarball(distDir) ?? '');

const checks = [];
function record(name, status, detail) {
  checks.push({ name, status, detail });
  if (!jsonOnly) {
    const line = `${status}  ${name}${detail ? ` — ${detail}` : ''}`;
    console.log(line);
  }
}
function pass(name, detail) {
  record(name, 'PASS', detail);
}
function warn(name, detail) {
  record(name, 'WARN', detail);
}
function fail(name, detail) {
  record(name, 'FAIL', detail);
}

if (!tarball || !fs.existsSync(tarball)) {
  console.error(`verify-package: no tarball found (looked for ${tarball || `${distDir}/*.tgz`})`);
  process.exit(2);
}

const tarballName = path.basename(tarball);
const tarballInfo = {
  path: tarball,
  name: tarballName,
  bytes: fs.statSync(tarball).size,
  sha256: sha256File(tarball),
};
pass('tarball exists', `${tarballName} · ${humanBytes(tarballInfo.bytes)} · sha256 ${tarballInfo.sha256.slice(0, 16)}…`);

const tempRoot = makeTempDir();
let packageRoot = null;
const loaded = { attempted: false, ok: false };

try {
  try {
    extractTarball(tarball, tempRoot);
  } catch (error) {
    fail('extract tarball', error.message);
    throw error;
  }
  pass('extract tarball', `${walkFiles(tempRoot).length} entries`);

  packageRoot = locatePackageRoot(tempRoot);
  if (packageRoot === null) {
    fail('locate package root', 'no package.json found');
    throw new Error('package root not found');
  }
  pass('locate package root', path.relative(tempRoot, packageRoot) || '.');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    pass('package.json parses', `${manifest.name}@${manifest.version}`);
  } catch (error) {
    fail('package.json parses', error.message);
    throw error;
  }

  // --- Manifest contract -------------------------------------------------
  const expectName = '@opentake/studio-route-b';
  if (manifest.name === expectName) pass('manifest name', manifest.name);
  else fail('manifest name', `expected ${expectName}, got ${manifest.name}`);
  if (manifest.version) pass('manifest version', manifest.version);
  else fail('manifest version', 'missing version');
  if (manifest.private === true) pass('manifest private', 'true (local bundle, not published)');
  else warn('manifest private', 'not true; this bundle is intended to stay private');
  if (manifest.type === 'module') pass('manifest module type', 'module');
  else fail('manifest module type', `expected "module", got ${manifest.type}`);

  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch === 'string' && fs.existsSync(path.join(packageRoot, patch))) {
    pass('bundle patch declared', patch);
  } else {
    fail('bundle patch declared', `missing or absent: ${JSON.stringify(patch)}`);
  }
  if (manifest?.dsh?.client?.platform === 'web') pass('client platform', 'web');
  else fail('client platform', `expected "web", got ${JSON.stringify(manifest?.dsh?.client?.platform)}`);
  const clientExport = manifest?.exports?.['./client'];
  if (typeof clientExport === 'string' && fs.existsSync(path.join(packageRoot, clientExport))) {
    pass('client export resolves', clientExport);
  } else {
    fail('client export resolves', `missing or absent: ${JSON.stringify(clientExport)}`);
  }

  // --- Required runtime files -------------------------------------------
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md']) {
    if (fs.existsSync(path.join(packageRoot, required))) pass(`entry file ${required}`, humanBytes(fs.statSync(path.join(packageRoot, required)).size));
    else fail(`entry file ${required}`, 'missing');
  }
  const patchText = fs.existsSync(path.join(packageRoot, 'cordis.patch.yml'))
    ? fs.readFileSync(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')
    : '';
  if (patchText.includes(expectName) && patchText.includes('opentake-studio-route-b')) {
    pass('patch inserts the bundle row', 'package name + row id present');
  } else {
    fail('patch inserts the bundle row', 'expected package name and opentake-studio-route-b row id');
  }

  // --- Web app assets ----------------------------------------------------
  const webRoot = path.join(packageRoot, 'web');
  const indexHtmlPath = path.join(webRoot, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    pass('web index.html', humanBytes(Buffer.byteLength(indexHtml)));

    const refs = parseWebReferences(indexHtml, webRoot);
    if (refs.length === 0) {
      fail('web index references', 'no local script/link references found');
    }
    for (const ref of refs) {
      if (fs.existsSync(ref.absolute) && fs.statSync(ref.absolute).size > 0) {
        pass(`web asset ${ref.relative}`, humanBytes(fs.statSync(ref.absolute).size));
      } else {
        fail(`web asset ${ref.relative}`, `referenced by index.html but missing/empty (${ref.url})`);
      }
    }
    const shimRef = refs.find((ref) => ref.relative.endsWith('tauri-shim.js'));
    if (shimRef) pass('shim is loaded before the app entry', shimRef.relative);
    else fail('shim is loaded before the app entry', 'tauri-shim.js is not referenced from index.html');

    const shimPath = path.join(webRoot, 'tauri-shim.js');
    if (fs.existsSync(shimPath)) {
      const shim = fs.readFileSync(shimPath, 'utf8');
      const markers = [
        ['__TAURI_INTERNALS__', 'Tauri internals global'],
        ['engine/invoke', '/engine/invoke dispatch'],
        ['convertFileSrc', 'asset conversion'],
      ];
      for (const [marker, label] of markers) {
        if (shim.includes(marker)) pass(`shim contract: ${label}`, marker);
        else fail(`shim contract: ${label}`, `missing ${marker}`);
      }
      pass('shim size', humanBytes(Buffer.byteLength(shim)));
    } else {
      fail('web/tauri-shim.js', 'missing');
    }
  } else {
    fail('web index.html', 'missing (package has no web app entry)');
  }

  // --- Native binaries ---------------------------------------------------
  const nativeRoot = path.join(packageRoot, 'native');
  const binaryRecords = [];
  if (!fs.existsSync(nativeRoot)) {
    fail('native directory', 'missing');
  } else {
    for (const dir of fs.readdirSync(nativeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const nativeDir = path.join(nativeRoot, dir.name);
      const binaries = fs.readdirSync(nativeDir).filter((name) => name.endsWith('.node'));
      if (binaries.length === 0) {
        fail(`native ${dir.name}`, 'no .node binary');
        continue;
      }
      for (const name of binaries) {
        const binaryPath = path.join(nativeDir, name);
        const info = readBinaryInfo(binaryPath);
        binaryRecords.push({ dir: dir.name, name, path: binaryPath, ...info });
        const expected = NATIVE_TARGETS[dir.name];
        const formatOk = expected ? info.format === expected.format : true;
        const archOk = expected ? info.arch === expected.arch : true;
        if (formatOk && archOk) {
          pass(`native ${dir.name}/${name}`, `${info.format}/${info.arch}, ${humanBytes(info.size)}, sha256 ${info.sha256.slice(0, 16)}…`);
        } else {
          fail(
            `native ${dir.name}/${name}`,
            `expected ${expected?.format}/${expected?.arch}, got ${info.format}/${info.arch}`,
          );
        }
        if (info.minOs) pass(`native ${dir.name} min OS`, `macOS ${info.minOs}`);
        if (info.installName) warn(`native ${dir.name} install name`, info.installName);
      }
    }
  }

  const expectedDirs = expectedNativeDirs(tarballName);
  if (expectedDirs === null) {
    warn('expected native dirs', `cannot infer platform targets from ${tarballName}`);
  } else {
    const actualDirs = fs.existsSync(nativeRoot)
      ? fs.readdirSync(nativeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [];
    for (const expectedDir of expectedDirs) {
      if (actualDirs.includes(expectedDir)) pass(`expected native dir ${expectedDir}`, 'present');
      else fail(`expected native dir ${expectedDir}`, `tarball name implies it; missing (found: ${actualDirs.join(', ') || 'none'})`);
    }
    for (const actualDir of actualDirs) {
      if (!expectedDirs.includes(actualDir)) warn(`extra native dir ${actualDir}`, 'not implied by the tarball name');
    }
  }

  // --- N-API ABI and current-platform load ------------------------------
  const napi = Number(process.versions.napi);
  if (Number.isFinite(napi) && napi >= 8) pass('Host N-API level', `N-API ${napi} (addon requires N-API 8)`);
  else fail('Host N-API level', `N-API ${process.versions.napi} is below the napi8 requirement`);
  pass('Host runtime', `Node ${process.versions.node} · ${process.platform}/${process.arch}`);

  if (!noLoad) {
    const hostDir = `${process.platform}-${process.arch}`;
    const hostRecord = binaryRecords.find((record) => record.dir === hostDir);
    if (!hostRecord) {
      warn('current-platform addon', `no native/${hostDir} in this package; load check skipped`);
    } else if (hostRecord.format !== NATIVE_TARGETS[hostDir]?.format) {
      warn('current-platform addon', `unexpected container ${hostRecord.format}; load check skipped`);
    } else {
      loaded.attempted = true;
      try {
        const addon = require(hostRecord.path);
        if (typeof addon.Engine !== 'function') throw new Error('module does not export Engine');
        const engine = new addon.Engine();
        const created = JSON.parse(engine.newProject());
        if (created?.timeline?.tracks?.length !== 0) throw new Error('new project is not empty');
        const applied = JSON.parse(
          engine.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 24, width: 1280, height: 720 })),
        );
        if (applied?.result?.changed !== true) throw new Error('apply(setTimelineSettings) did not report a change');
        if (applied?.timeline?.timeline?.fps !== 24) throw new Error('apply did not set fps=24');
        const undone = JSON.parse(engine.undo());
        if (undone?.timeline?.fps !== 30) throw new Error('undo did not restore fps=30');
        const timeline = JSON.parse(engine.getTimeline());
        if (!Array.isArray(timeline?.timeline?.tracks)) throw new Error('getTimeline returned no tracks array');
        loaded.ok = true;
        pass(
          'current-platform addon loads and edits',
          `${hostRecord.dir}/${hostRecord.name} · newProject/apply/undo/getTimeline OK`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail('current-platform addon loads and edits', message);
      }
    }
  } else {
    warn('current-platform addon load', 'skipped by --no-load');
  }

  // --- `files` coverage --------------------------------------------------
  const filesEntries = Array.isArray(manifest.files) ? manifest.files : [];
  if (filesEntries.length > 0) {
    const extracted = walkFiles(packageRoot).map((file) => path.relative(packageRoot, file).split(path.sep).join('/'));
    const uncovered = extracted.filter((relative) => {
      if (relative === 'package.json') return false;
      return !filesEntries.some((pattern) => filesEntryCovers(pattern, relative));
    });
    if (uncovered.length === 0) pass('manifest files coverage', `${extracted.length} package files covered`);
    else warn('manifest files coverage', `${uncovered.length} extracted file(s) not covered by files: ${uncovered.slice(0, 5).join(', ')}`);
  } else {
    warn('manifest files coverage', 'package.json has no files list (npm would include everything)');
  }
} catch (error) {
  if (!checks.some((check) => check.status === 'FAIL')) {
    fail('verification aborted', error instanceof Error ? error.message : String(error));
  }
} finally {
  if (packageRoot !== null && !keep) removeDir(tempRoot);
}

const failures = checks.filter((check) => check.status === 'FAIL');
const warnings = checks.filter((check) => check.status === 'WARN');
const summary = {
  tarball: tarballInfo,
  packageRoot: packageRoot ? path.relative(tempRoot, packageRoot) : null,
  host: { node: process.versions.node, napi: process.versions.napi, platform: process.platform, arch: process.arch },
  loaded,
  checks,
  counts: { pass: checks.length - failures.length - warnings.length, warn: warnings.length, fail: failures.length },
  ok: failures.length === 0,
  tempDir: keep ? tempRoot : null,
};

if (jsonOnly) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('');
  console.log(
    `verify-package: ${summary.counts.pass} passed, ${summary.counts.warn} warnings, ${summary.counts.fail} failed` +
      (keep ? ` · extracted at ${tempRoot}` : ''),
  );
}

process.exit(failures.length === 0 ? 0 : 1);
