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
  check('package contains the expected file set', () => {
    const expected = [
      'README.md', 'client.js', 'cordis.patch.yml', 'index.js', 'package.json',
      'native/darwin-arm64/opentake_engine_v28.node',
      'native/darwin-x64/opentake_engine_v28.node',
      'web/index.html', 'web/tauri-shim.js',
    ];
    for (const file of expected) assert.ok(files.includes(file), `missing ${file}`);
    // Host-side modules (motion-templates, providers, ...) are packed via
    // `lib/*.js`; they are additive to the original 17-file bundle layout.
    const library = files.filter((file) => /^lib\/[A-Za-z0-9._-]+\.js$/.test(file));
    const unexpected = files.filter(
      (file) => !expected.includes(file) && !library.includes(file) && !file.startsWith('web/'),
    );
    assert.deepEqual(unexpected, [], `unexpected package entries: ${unexpected.join(',')}`);
    assert.equal(files.length, 17 + library.length, `file count: ${files.length}`);
    assert.ok(files.every((file) => !file.startsWith('node_modules/') && !file.endsWith('.map')));
    return `${files.length} files${library.length > 0 ? ` (modules: ${library.join(', ')})` : ''}`;
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  check('package.json is the Route B bundle manifest', () => {
    assert.equal(pkg.name, '@opentake/studio-route-b');
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.deepEqual(pkg.exports, { '.': './index.js', './client': './client.js' });
  });
  check('cordis patch mounts the bundle id', () => {
    const patch = fs.readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id:\s*opentake-studio-route-b/);
    assert.match(patch, /name:\s*'@opentake\/studio-route-b'/);
  });

  const archOf = (file) => execFileSync('file', [file], { encoding: 'utf8' });
  const arm64 = path.join(packageDir, 'native', 'darwin-arm64', 'opentake_engine_v28.node');
  const x64 = path.join(packageDir, 'native', 'darwin-x64', 'opentake_engine_v28.node');
  check('both macOS addon slices are present with the right architecture', () => {
    assert.match(archOf(arm64), /Mach-O 64-bit dynamically linked shared library arm64/);
    assert.match(archOf(x64), /Mach-O 64-bit executable x86_64|Mach-O 64-bit dynamically linked shared library x86_64/);
    const repoArm = path.join('plugins/opentake-studio-route-b/native/darwin-arm64', 'opentake_engine_v28.node');
    const repoX64 = path.join('plugins/opentake-studio-route-b/native/darwin-x64', 'opentake_engine_v28.node');
    for (const [packed, repo] of [[arm64, repoArm], [x64, repoX64]]) {
      if (fs.existsSync(repo)) {
        const packedBytes = fs.readFileSync(packed);
        const repoBytes = fs.readFileSync(repo);
        assert.equal(packedBytes.length, repoBytes.length, `${path.basename(path.dirname(packed))} size differs from repo`);
        assert.ok(packedBytes.equals(repoBytes), `${path.basename(path.dirname(packed))} bytes differ from repo`);
      }
    }
    return 'arm64 + x64';
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

  const addonForHost = path.join(packageDir, 'native', `${process.platform}-${process.arch}`, 'opentake_engine_v28.node');

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

  const addonBytes = fs.readFileSync(arm64);
  warn('unpacked size', `${addonBytes.length} bytes arm64 addon; tarball ${fs.statSync(tarball).size} bytes`);
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
