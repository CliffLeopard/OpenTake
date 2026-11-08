#!/usr/bin/env node
/**
 * Route B package verification — extracts a Route B plugin tarball and checks
 * its contents, both architecture addon slices, and that the packaged plugin +
 * current-platform addon load and answer an Engine call.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-tarball.mjs [--tarball <path>] [--json]
 *
 * Default tarball: dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz
 * Exit code 0 = all checks passed; 1 = failures. Nothing in the repo is written:
 * the tarball is extracted under the OS temp dir and removed afterwards.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const jsonOnly = args.includes('--json');
const tarball = path.resolve(option('--tarball') ?? 'dist/opentake-studio-route-b-0.1.0-darwin-universal.tgz');
const checks = [];
function check(name, fn) {
  try {
    const value = fn();
    checks.push({ name, status: 'PASS', detail: value === undefined ? '' : String(value) });
    if (!jsonOnly) console.log(`PASS  ${name}${value === undefined ? '' : ` — ${value}`}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: 'FAIL', detail: message });
    if (!jsonOnly) console.log(`FAIL  ${name} — ${message}`);
    return false;
  }
}
function warn(name, detail) {
  checks.push({ name, status: 'WARN', detail });
  if (!jsonOnly) console.log(`WARN  ${name} — ${detail}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'route-b-pkg-'));
const extractDir = path.join(work, 'extract');
fs.mkdirSync(extractDir);
let packageDir = null;
try {
  check('tarball exists', () => {
    assert.ok(fs.statSync(tarball).isFile());
    return `${fs.statSync(tarball).size} bytes`;
  });
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir]);
  packageDir = path.join(extractDir, 'package');
  check('tarball extracts to package/', () => {
    assert.ok(fs.statSync(packageDir).isDirectory());
  });

  const files = [];
  for (const entry of fs.readdirSync(packageDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(path.relative(packageDir, path.join(entry.parentPath ?? entry.path, entry.name)));
  }
  const nativeFiles = files.filter((file) => /^native\/[^/]+\/opentake_engine_v\d+\.node$/.test(file));
  const addonVersions = [...new Set(nativeFiles.map((file) => file.match(/opentake_engine_v(\d+)\.node/)[1]))];
  const currentPrefix = `native/${process.platform}-${process.arch}/`;
  const currentNative = nativeFiles.find((file) => file.startsWith(currentPrefix));
  const CURRENT_ADDON_NAME = currentNative ? path.basename(currentNative) : null;
  const ADDON_NAME = CURRENT_ADDON_NAME ?? (addonVersions.length === 1 ? `opentake_engine_v${addonVersions[0]}.node` : null);
  const repoEntry = fs.readFileSync(path.join('plugins/opentake-studio-route-b', 'index.js'), 'utf8');
  const repoAddonMatch = repoEntry.match(/opentake_engine_v(\d+)\.node/);
  const REPO_ADDON_NAME = repoAddonMatch ? `opentake_engine_v${repoAddonMatch[1]}.node` : null;
  check('package contains the expected file set', () => {
    const required = ['README.md', 'client.js', 'cordis.patch.yml', 'index.js', 'package.json', 'web/index.html', 'web/tauri-shim.js', 'web/native-editor/native-editor.js', 'ui/client.js', 'lib/motion-templates.js', 'lib/providers.js', 'lib/search/install-model.mjs', 'lib/search/model-assets.mjs'];
    for (const file of required) assert.ok(files.includes(file), `missing ${file}`);
    assert.ok(CURRENT_ADDON_NAME, `missing current-platform addon (${currentPrefix})`);
    assert.equal(addonVersions.length, 1, `mixed addon versions across slices: ${addonVersions.join(',')}`);
    if (process.env.REQUIRE_UNIVERSAL === '1') {
      assert.ok(nativeFiles.some((file) => file.startsWith('native/darwin-arm64/')), 'missing arm64 addon');
      assert.ok(nativeFiles.some((file) => file.startsWith('native/darwin-x64/')), 'missing x64 addon');
    }
    // Additive workstream files: lib/*.js, ui/**, web/** and native slices.
    const unexpected = files.filter((file) => {
      if (required.includes(file)) return false;
      if (file === 'README.md' || file === 'client.js' || file === 'cordis.patch.yml' || file === 'index.js' || file === 'package.json') return false;
      if (file.startsWith('web/') || file.startsWith('ui/') || file.startsWith('native/')) return false;
      if (/^lib\/.*\.(js|mjs)$/.test(file)) return false;
      return true;
    });
    assert.deepEqual(unexpected, [], `unexpected package entries: ${unexpected.join(',')}`);
    assert.ok(files.every((file) => !file.startsWith('node_modules/') && !file.endsWith('.map')));
    return `${files.length} files; addon ${CURRENT_ADDON_NAME}`;
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  check('package.json is the Route B bundle manifest', () => {
    assert.equal(pkg.name, '@opentake/studio-route-b');
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.deepEqual(pkg.exports, { '.': './index.js', './client': './ui/client.js' });
    assert.ok(pkg.files.includes('ui/**'), 'package files must ship ui/** for the native shell');
    assert.ok(pkg.files.includes('lib/motion-templates.js'));
    assert.ok(pkg.files.includes('lib/providers.js'));
    assert.ok(pkg.files.includes('lib/search/install-model.mjs'));
    assert.ok(pkg.files.includes('lib/search/model-assets.mjs'));
  });
  check('cordis patch mounts the bundle id', () => {
    const patch = fs.readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id:\s*opentake-studio-route-b/);
    assert.match(patch, /name:\s*'@opentake\/studio-route-b'/);
  });

  check('package entry references the packaged addon version', () => {
    const entry = fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8');
    assert.match(entry, new RegExp(String(CURRENT_ADDON_NAME).replace('.', '\\.')));
    assert.ok(entry.includes('lib/search/install-model.mjs'), 'package index does not import the packaged search installer');
    return ADDON_NAME;
  });

  const archOf = (file) => execFileSync('file', [file], { encoding: 'utf8' });
  check('package addon matches the repo plugin entry version', () => {
    assert.ok(REPO_ADDON_NAME, 'cannot read the repo plugin addon version');
    assert.equal(CURRENT_ADDON_NAME, REPO_ADDON_NAME, `package current-platform addon ${CURRENT_ADDON_NAME} != repo entry ${REPO_ADDON_NAME}`);
    return `${CURRENT_ADDON_NAME} == plugins/opentake-studio-route-b/index.js`;
  });

  const currentAddon = path.join(packageDir, currentPrefix, CURRENT_ADDON_NAME);
  check('addon slice(s) match the packaged architecture and repo bytes', () => {
    assert.match(archOf(currentAddon), /Mach-O 64-bit (dynamically linked shared library|executable)/);
    const pairs = [[currentAddon, path.join('plugins/opentake-studio-route-b', currentPrefix, CURRENT_ADDON_NAME)]];
    if (process.env.REQUIRE_UNIVERSAL === '1') {
      const arm64File = nativeFiles.find((file) => file.startsWith('native/darwin-arm64/'));
      const x64File = nativeFiles.find((file) => file.startsWith('native/darwin-x64/'));
      assert.ok(arm64File && x64File, 'universal package is missing a macOS slice');
      const arm64 = path.join(packageDir, arm64File);
      const x64 = path.join(packageDir, x64File);
      assert.match(archOf(arm64), /Mach-O 64-bit dynamically linked shared library arm64/);
      assert.match(archOf(x64), /Mach-O 64-bit executable x86_64|Mach-O 64-bit dynamically linked shared library x86_64/);
      pairs.push([arm64, path.join('plugins/opentake-studio-route-b', arm64File)]);
      pairs.push([x64, path.join('plugins/opentake-studio-route-b', x64File)]);
    }
    for (const [packed, repo] of pairs) {
      assert.ok(fs.existsSync(packed), `packaged addon missing: ${packed}`);
      if (process.env.ALLOW_BUILT_ADDON === '1') continue;
      assert.ok(fs.existsSync(repo), `repo has no equivalent addon for ${path.basename(packed)} (${repo}); package is stale or mixed-version`);
      const packedBytes = fs.readFileSync(packed);
      const repoBytes = fs.readFileSync(repo);
      assert.equal(packedBytes.length, repoBytes.length, `${path.basename(path.dirname(packed))} size differs from repo`);
      assert.ok(packedBytes.equals(repoBytes), `${path.basename(path.dirname(packed))} bytes differ from repo`);
    }
    return nativeFiles.map((file) => path.basename(path.dirname(file))).join(', ');
  });

  check('web assets referenced by index.html are packaged', () => {
    const html = fs.readFileSync(path.join(packageDir, 'web', 'index.html'), 'utf8');
    assert.match(html, /<div id="root">/);
    const assets = [...html.matchAll(/\/app\/assets\/([A-Za-z0-9._-]+)/g)].map((match) => match[1]);
    assert.ok(assets.length > 0, 'no assets referenced');
    for (const asset of assets) {
      assert.ok(files.includes(`web/assets/${asset}`), `missing web/assets/${asset}`);
    }
    assert.ok(files.includes('web/tauri-shim.js'));
    return `${assets.length} asset reference(s)`;
  });

  const addonForHost = path.join(packageDir, 'native', `${process.platform}-${process.arch}`, CURRENT_ADDON_NAME);

  // Load the packaged addon through a child Node process so this script itself
  // stays free of native module state.
  check('packaged addon smoke passes in a child Node process', () => {
    const script = `
      const { Engine } = require(${JSON.stringify(addonForHost)});
      const engine = new Engine();
      const created = JSON.parse(engine.newProject());
      if (created.version !== 0) throw new Error('bad newProject version');
      engine.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 24, width: 640, height: 360 }));
      const after = JSON.parse(engine.getTimeline());
      if (after.timeline.fps !== 24) throw new Error('apply did not change fps');
      console.log(JSON.stringify({ node: process.versions.node, napi: process.versions.napi, fps: after.timeline.fps }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.fps, 24);
    return `node ${result.node} napi ${result.napi}`;
  });

  // Packaged plugin Host half loads the packaged addon from its own tree.
  const FakeResponse = class extends Writable {
    constructor() { super(); this.statusCode = 200; this.headers = {}; this.chunks = []; }
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; }
    _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  };
  const pluginModule = await import(pathToFileURL(path.join(packageDir, 'index.js')).href);
  const tools = new Map();
  const routes = [];
  const cleanups = [];
  const ctx = {
    get: (service) => service === 'tools' ? { register(d) { tools.set(d.name, d); return () => {}; } } : undefined,
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; },
    webServer: { register(options) { routes.push(options); return () => {}; } },
  };
  Object.defineProperty(ctx, 'connection', { value: { requestRejection() { return undefined; } } });
  pluginModule.apply(ctx);
  const response = await (async () => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/opentake-studio-route-b/engine/info';
    req.headers = {};
    const res = new FakeResponse();
    const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
    await routes[0].handler(req, res);
    await finished;
    return { status: res.statusCode, json: JSON.parse(Buffer.concat(res.chunks).toString('utf8')) };
  })();
  check('packaged plugin Host half loads the packaged addon', () => {
    assert.equal(response.status, 200);
    assert.equal(response.json.loaded, true, response.json.loadError ?? 'not loaded');
    assert.equal(fs.realpathSync(response.json.addonPath), fs.realpathSync(addonForHost));
    assert.ok(tools.size >= 28, `tools=${tools.size}`);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, '/opentake-studio-route-b');
    return `${tools.size} tools, node ${response.json.node}, napi ${response.json.napi}`;
  });
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }

  check('package has no OpenTake/Tauri runtime dependency', () => {
    const source = fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8') + fs.readFileSync(path.join(packageDir, 'web', 'tauri-shim.js'), 'utf8');
    // The bundled tauri-shim emulates window.__TAURI_INTERNALS__ (comment-only
    // mention of @tauri-apps/api) but must not import a Tauri package or point
    // at an installed OpenTake binary.
    assert.doesNotMatch(source, /(?:require|import)\s*\(?\s*['"]@tauri-apps|\/Applications\/OpenTake|OpenTake\.app|external_mcp/);
    assert.equal(pkg.dependencies, undefined);
    return 'no app/bridge dependency';
  });

  const addonBytes = fs.readFileSync(currentAddon);
  warn('unpacked size', `${addonBytes.length} bytes current addon; tarball ${fs.statSync(tarball).size} bytes`);
} catch (error) {
  checks.push({ name: 'package harness', status: 'FAIL', detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  if (!jsonOnly) console.log(`FAIL  package harness — ${error instanceof Error ? error.message : error}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter((entry) => entry.status === 'FAIL');
const summary = {
  tarball,
  runtime: { node: process.versions.node, napi: process.versions.napi, platform: process.platform, arch: process.arch },
  passed: checks.filter((entry) => entry.status === 'PASS').length,
  warnings: checks.filter((entry) => entry.status === 'WARN').length,
  failed: failed.length,
  checks,
};
if (jsonOnly) console.log(JSON.stringify(summary, null, 2));
else console.log(`\n${summary.passed} passed, ${summary.warnings} warning(s), ${summary.failed} failed (${checks.length} checks)`);
process.exit(failed.length > 0 ? 1 : 0);
