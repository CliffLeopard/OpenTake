#!/usr/bin/env node
/**
 * Route B addon verification — independent Node-API contract/ABI probe.
 *
 * Loads the built `opentake-node` shared library as a `.node` addon and checks
 * the Engine contract that the DSH Route B plugin relies on: exported surface,
 * snapshot/result JSON shapes, apply(EditRequest) behavior, error behavior,
 * atomicity, persistence, compatibility read-only mode, multiple instances,
 * worker_threads parallelism and (optionally) GC/lifetime and plugin loading
 * from a symlinked plugin directory.
 *
 * Usage:
 *   node scripts/route-b/verify-addon.mjs --addon <path/to/opentake_engine.node>
 *       [--json] [--workers] [--gc-loop] [--plugin <plugin-dir>] [--no-security-probe]
 *
 * Exit code 0 = all checks passed (warnings are reported but do not fail);
 * 1 = at least one check failed. Temp dirs are removed on exit.
 *
 * This script does not modify the addon or the plugin; it only reads the
 * addon and writes throwaway projects under the OS temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const addonArg = option('--addon');
const pluginArg = option('--plugin');
const wantWorkers = flag('--workers');
const wantGc = flag('--gc-loop');
const securityProbe = !flag('--no-security-probe');
const jsonOnly = flag('--json');

if (!addonArg) {
  console.error('usage: node scripts/route-b/verify-addon.mjs --addon <opentake_engine.node> [--workers] [--gc-loop] [--plugin <dir>] [--json]');
  process.exit(2);
}
const addonPath = path.resolve(addonArg);

const checks = [];
function check(name, fn, detail) {
  try {
    const value = fn();
    checks.push({ name, status: 'PASS', detail: detail ?? (value === undefined ? '' : String(value)) });
    if (!jsonOnly) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: 'FAIL', detail: message });
    if (!jsonOnly) console.log(`FAIL  ${name} — ${message}`);
    return false;
  }
}
async function checkAsync(name, fn, detail) {
  try {
    const value = await fn();
    checks.push({ name, status: 'PASS', detail: detail ?? (value === undefined ? '' : String(value)) });
    if (!jsonOnly) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
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
function note(name, detail) {
  checks.push({ name, status: 'NOTE', detail });
  if (!jsonOnly) console.log(`NOTE  ${name} — ${detail}`);
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const expectKeys = (value, keys, label) => {
  assert.ok(isRecord(value), `${label} must be an object`);
  for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${label} missing key ${key}`);
};
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'route-b-verify-'));

const REQUIRED_METHODS = [
  'newProject', 'newProjectAt', 'openProject', 'saveProject', 'getTimeline',
  'apply', 'undo', 'redo', 'canUndo', 'canRedo', 'mediaList', 'importMedia',
  'relinkMedia', 'createMediaProxy', 'removeMediaProxy', 'captureFrameToMedia',
  'exportTimeline', 'exportSubtitles', 'toggleFavorite', 'libraryList',
  'libraryFavorite', 'libraryUnfavorite', 'libraryCategorize', 'libraryRename',
  'libraryDelete', 'libraryImportToProject', 'exportAudio', 'audioMixWav',
  'thumbnail', 'waveform', 'compositeFrame', 'exportBegin', 'exportStep',
  'exportFinish', 'exportCancel', 'exportVideo',
];
const SNAPSHOT_KEYS = ['timeline', 'projectEpoch', 'version', 'projectPath', 'compatibilityReadOnly', 'compatibilityBlockers'];
const TIMELINE_KEYS = ['fps', 'width', 'height', 'settingsConfigured', 'tracks'];
const TRACK_KEYS = ['id', 'type', 'muted', 'hidden', 'syncLocked', 'clips'];
const CLIP_KEYS = [
  'id', 'mediaRef', 'mediaType', 'sourceClipType', 'startFrame', 'durationFrames',
  'trimStartFrame', 'trimEndFrame', 'speed', 'volume', 'fadeInFrames', 'fadeOutFrames',
  'fadeInInterpolation', 'fadeOutInterpolation', 'opacity', 'transform', 'crop',
];
const EDIT_RESULT_KEYS = ['changed', 'actionName', 'affectedClipIds', 'timelineVersion', 'summary'];

console.log(`route-b addon: ${addonPath}`);
console.log(`runtime: node ${process.versions.node}, napi ${process.versions.napi}, electron ${process.versions.electron ?? '-'}, ${process.platform}/${process.arch}`);

let native;
let Engine;
try {
  native = require(addonPath);
  Engine = native.Engine;
  check('addon loads and exports an Engine constructor', () => assert.equal(typeof Engine, 'function'));
} catch (error) {
  console.error(`FAIL  addon could not be loaded: ${error.message}`);
  process.exit(1);
}

check('runtime exposes Node-API 8 or newer', () => {
  const napi = Number(process.versions.napi);
  assert.ok(Number.isInteger(napi) && napi >= 8, `process.versions.napi=${process.versions.napi}`);
  return `napi=${napi}`;
});

const prototype = Object.getOwnPropertyNames(Engine.prototype).filter((name) => name !== 'constructor');
check('Engine exposes the full Route B method surface', () => {
  const missing = REQUIRED_METHODS.filter((name) => typeof Engine.prototype[name] !== 'function');
  assert.deepEqual(missing, [], `missing methods: ${missing.join(', ')}`);
  return `${REQUIRED_METHODS.length} methods`;
});
check('Engine constructor takes no required arguments', () => {
  const engine = new Engine();
  assert.ok(engine instanceof Engine);
});

// ---------------------------------------------------------------------------
// Project lifecycle / snapshot shapes
// ---------------------------------------------------------------------------
const engine = new Engine();
let baseSnapshot;
check('newProject returns a camelCase TimelineSnapshotDto', () => {
  baseSnapshot = JSON.parse(engine.newProject());
  expectKeys(baseSnapshot, SNAPSHOT_KEYS, 'snapshot');
  expectKeys(baseSnapshot.timeline, TIMELINE_KEYS, 'snapshot.timeline');
  assert.equal(baseSnapshot.version, 0);
  assert.equal(baseSnapshot.projectPath, null);
  assert.equal(baseSnapshot.compatibilityReadOnly, false);
  assert.deepEqual(baseSnapshot.compatibilityBlockers, []);
  assert.equal(baseSnapshot.timeline.fps, 30);
  assert.equal(baseSnapshot.timeline.width, 1920);
  assert.equal(baseSnapshot.timeline.height, 1080);
  assert.equal(baseSnapshot.timeline.settingsConfigured, false);
  assert.deepEqual(baseSnapshot.timeline.tracks, []);
  return `version=${baseSnapshot.version} projectEpoch=${baseSnapshot.projectEpoch}`;
});
check('getTimeline returns the same snapshot shape and version', () => {
  const snapshot = JSON.parse(engine.getTimeline());
  expectKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
  assert.equal(snapshot.version, baseSnapshot.version);
  assert.equal(JSON.stringify(snapshot.timeline), JSON.stringify(baseSnapshot.timeline));
});

// ---------------------------------------------------------------------------
// apply(EditRequest)
// ---------------------------------------------------------------------------
const APPLY_SETTINGS = {
  type: 'setTimelineSettings', fps: 24, width: 1280, height: 720,
};
check('apply(setTimelineSettings) returns { result, timeline }', () => {
  const response = JSON.parse(engine.apply(JSON.stringify(APPLY_SETTINGS)));
  expectKeys(response, ['result', 'timeline'], 'apply response');
  expectKeys(response.result, EDIT_RESULT_KEYS, 'apply.result');
  expectKeys(response.timeline, SNAPSHOT_KEYS, 'apply.timeline');
  assert.equal(response.result.changed, true);
  assert.equal(typeof response.result.actionName, 'string');
  assert.ok(Array.isArray(response.result.affectedClipIds));
  assert.equal(response.timeline.timeline.fps, 24);
  assert.equal(response.timeline.version, 1);
  assert.equal(engine.canUndo(), true);
  assert.equal(engine.canRedo(), false);
  return `version=${response.timeline.version} action=${response.result.actionName}`;
});
check('apply(insertTrack) adds a typed track with the documented shape', () => {
  const response = JSON.parse(engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video', at: 0 })));
  const track = response.timeline.timeline.tracks.at(-1);
  expectKeys(track, TRACK_KEYS, 'track');
  assert.equal(track.type, 'video');
  assert.ok(Array.isArray(track.clips));
  assert.equal(typeof track.muted, 'boolean');
  assert.equal(typeof track.hidden, 'boolean');
  assert.equal(typeof track.syncLocked, 'boolean');
  return `track id=${track.id}`;
});
check('apply(addTextsAutoTrack) creates a text clip with the documented shape', () => {
  const response = JSON.parse(engine.apply(JSON.stringify({
    type: 'addTextsAutoTrack',
    entries: [{
      startFrame: 0,
      durationFrames: 30,
      content: 'verify-addon',
      textStyle: {},
      transform: { centerX: 0.5, centerY: 0.5 },
    }],
  })));
  const clip = response.timeline.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.textContent === 'verify-addon');
  assert.ok(clip, 'text clip not found in snapshot');
  expectKeys(clip, CLIP_KEYS, 'clip');
  assert.equal(clip.mediaType, 'text');
  assert.equal(clip.sourceClipType, 'text');
  assert.equal(clip.startFrame, 0);
  assert.equal(clip.durationFrames, 30);
  assert.equal(clip.speed, 1);
  assert.equal(clip.volume, 1);
  expectKeys(clip.transform, ['centerX', 'centerY', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical'], 'clip.transform');
  expectKeys(clip.crop, ['left', 'top', 'right', 'bottom'], 'clip.crop');
  return `clip id=${clip.id}`;
});
check('apply is atomic: a rejected batch leaves version and timeline unchanged', () => {
  const before = JSON.parse(engine.getTimeline());
  assert.throws(() => engine.apply(JSON.stringify({
    type: 'addTextsAutoTrack',
    entries: [
      { startFrame: 0, durationFrames: 30, content: 'valid', textStyle: {}, transform: { centerX: 0.5, centerY: 0.5 } },
      { startFrame: 40, durationFrames: 0, content: 'invalid', textStyle: {}, transform: { centerX: 0.5, centerY: 0.5 } },
    ],
  })), (error) => /durationFrames/.test(error.message));
  const after = JSON.parse(engine.getTimeline());
  assert.equal(after.version, before.version);
  assert.deepEqual(after.timeline.tracks, before.timeline.tracks);
});
check('apply rejects malformed JSON, unknown commands and unknown fields', () => {
  assert.throws(() => engine.apply('{not json'), (error) => error instanceof Error && /invalid edit request/.test(error.message));
  assert.throws(() => engine.apply(JSON.stringify({ type: 'noSuchCommand' })), (error) => /unknown variant/.test(error.message));
  assert.throws(() => engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video', at: 0, extra: 1 })), (error) => /unknown field `extra`/.test(error.message));
});
check('apply rejects JavaScript values that are not strings', () => {
  assert.throws(() => engine.apply(42), (error) => error instanceof Error && /String/.test(error.message));
  assert.throws(() => engine.openProject(42), (error) => error instanceof Error && /String/.test(error.message));
});

// ---------------------------------------------------------------------------
// Undo / redo and version semantics
// ---------------------------------------------------------------------------
check('undo/redo return snapshots and move the document version', () => {
  const history = new Engine();
  history.newProject();
  history.apply(JSON.stringify(APPLY_SETTINGS));
  const undone = JSON.parse(history.undo());
  expectKeys(undone, SNAPSHOT_KEYS, 'undo snapshot');
  assert.equal(undone.timeline.fps, 30);
  assert.equal(history.canRedo(), true);
  const redone = JSON.parse(history.redo());
  assert.equal(redone.timeline.fps, 24);
  note('version semantics', JSON.stringify({
    newProject: 0,
    afterOneApply: 1,
    afterUndo: undone.version,
    afterRedo: redone.version,
    note: 'version increments on apply AND undo/redo; open/newProjectAt reset it to 0',
  }));
});
check('undo/redo on empty history are safe no-ops', () => {
  const fresh = new Engine();
  fresh.newProject();
  assert.equal(fresh.canUndo(), false);
  assert.equal(fresh.canRedo(), false);
  const undone = JSON.parse(fresh.undo());
  assert.equal(undone.version, 0);
  assert.equal(fresh.canRedo(), false);
  const redone = JSON.parse(fresh.redo());
  assert.equal(redone.version, 0);
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------
const bundle = path.join(tempRoot, 'roundtrip.opentake');
let savedPath;
check('newProjectAt persists a .opentake bundle and returns projectPath', () => {
  savedPath = null;
  const created = JSON.parse(engine.newProjectAt(bundle));
  expectKeys(created, SNAPSHOT_KEYS, 'newProjectAt snapshot');
  assert.equal(created.projectPath, bundle);
  assert.equal(created.version, 0);
  assert.ok(fs.existsSync(path.join(bundle, 'project.json')));
  assert.ok(fs.existsSync(path.join(bundle, 'media.json')));
  savedPath = bundle;
  return `files=${fs.readdirSync(bundle).sort().join(',')}`;
});
check('edits save into the bundle and reopen in a fresh Engine', () => {
  engine.apply(JSON.stringify(APPLY_SETTINGS));
  engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video', at: 0 }));
  engine.apply(JSON.stringify({
    type: 'addTextsAutoTrack',
    entries: [{ startFrame: 0, durationFrames: 30, content: 'persisted', textStyle: {}, transform: { centerX: 0.5, centerY: 0.5 } }],
  }));
  const saved = engine.saveProject(bundle);
  assert.equal(saved, bundle);
  assert.equal(engine.saveProject(null), bundle);
  const reopened = JSON.parse(new Engine().openProject(bundle));
  assert.equal(reopened.projectPath, bundle);
  assert.equal(reopened.version, 0, 'reopening resets the snapshot version');
  assert.equal(reopened.timeline.fps, 24);
  assert.equal(reopened.timeline.tracks.length, 2);
  const clips = reopened.timeline.tracks.flatMap((track) => track.clips);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].textContent, 'persisted');
});
check('openProject accepts a relative path but stores it verbatim', () => {
  const previousCwd = process.cwd();
  process.chdir(tempRoot);
  try {
    const reopened = JSON.parse(new Engine().openProject('roundtrip.opentake'));
    note('relative projectPath', `snapshot.projectPath=${JSON.stringify(reopened.projectPath)} (not canonicalized; callers should pass absolute paths)`);
    assert.equal(reopened.timeline.fps, 24);
  } finally {
    process.chdir(previousCwd);
  }
});

// ---------------------------------------------------------------------------
// Compatibility read-only mode
// ---------------------------------------------------------------------------
check('unknown persisted fields enable compatibility read-only mode', () => {
  const compatBundle = path.join(tempRoot, 'compat.opentake');
  engine.newProjectAt(compatBundle);
  const projectFile = path.join(compatBundle, 'project.json');
  const projectJson = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  projectJson.futureFeature = { hello: 'world' };
  fs.writeFileSync(projectFile, JSON.stringify(projectJson));
  const compatEngine = new Engine();
  const snapshot = JSON.parse(compatEngine.openProject(compatBundle));
  assert.equal(snapshot.compatibilityReadOnly, true);
  assert.ok(snapshot.compatibilityBlockers.some((entry) => entry.includes('futureFeature')), JSON.stringify(snapshot.compatibilityBlockers));
  assert.throws(
    () => compatEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' })),
    (error) => /compatibility read-only/.test(error.message),
  );
  return snapshot.compatibilityBlockers.join(',');
});

// ---------------------------------------------------------------------------
// Observed behavior that the contract/docs should pin down
// ---------------------------------------------------------------------------
check('newProjectAt on an existing bundle overwrites it (data-loss hazard)', () => {
  const existing = path.join(tempRoot, 'existing.opentake');
  const first = new Engine();
  first.newProjectAt(existing);
  first.apply(JSON.stringify({ type: 'insertTrack', kind: 'video', at: 0 }));
  first.saveProject(existing);
  const beforeFile = JSON.parse(fs.readFileSync(path.join(existing, 'project.json'), 'utf8'));
  assert.equal(beforeFile.tracks.length, 1);
  const overwritten = JSON.parse(new Engine().newProjectAt(existing));
  const afterFile = JSON.parse(fs.readFileSync(path.join(existing, 'project.json'), 'utf8'));
  assert.equal(overwritten.timeline.tracks.length, 0);
  assert.equal(afterFile.tracks.length, 0);
  warn('newProjectAt overwrites an existing project bundle without a guard', `tracks ${beforeFile.tracks.length} -> ${afterFile.tracks.length} at ${existing}`);
  warn('plugin /engine/invoke project_new {path} reaches the same overwrite path', 'plugin index.js invokeCore "project_new" -> Engine.newProjectAt(path)');
});
check('a no-op apply reports changed=false and keeps the version', () => {
  const fresh = new Engine();
  fresh.newProject();
  fresh.apply(JSON.stringify(APPLY_SETTINGS));
  const versionBefore = JSON.parse(fresh.getTimeline()).version;
  const noop = JSON.parse(fresh.apply(JSON.stringify(APPLY_SETTINGS)));
  assert.equal(noop.result.changed, false);
  assert.equal(noop.timeline.version, versionBefore);
  return `changed=false keeps version ${versionBefore}`;
});

// ---------------------------------------------------------------------------
// Isolation / concurrency
// ---------------------------------------------------------------------------
check('multiple Engine instances are independent', () => {
  const left = new Engine();
  const right = new Engine();
  left.newProject();
  right.newProject();
  left.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 24, width: 640, height: 360 }));
  right.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 60, width: 1280, height: 720 }));
  assert.equal(JSON.parse(left.getTimeline()).timeline.fps, 24);
  assert.equal(JSON.parse(right.getTimeline()).timeline.fps, 60);
  return 'two instances hold independent document state';
});

if (wantWorkers) {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { Engine } = require(workerData.addon);
    const engine = new Engine();
    const created = JSON.parse(engine.newProject());
    engine.apply(JSON.stringify({ type: 'setTimelineSettings', fps: workerData.fps, width: 640, height: 360 }));
    const snapshot = JSON.parse(engine.getTimeline());
    parentPort.postMessage({ fps: snapshot.timeline.fps, version: snapshot.version, created: created.version });
  `;
  const workerPromise = (fps) => new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { addon: addonPath, fps } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with ${code}`)); });
  });
  await (async () => {
    try {
      const results = await Promise.all([22, 24, 26, 30].map(workerPromise));
      check('worker_threads can load the addon concurrently', () => {
        assert.deepEqual(results.map((result) => result.fps), [22, 24, 26, 30]);
        for (const result of results) {
          assert.equal(result.version, 1);
          assert.equal(result.created, 0);
        }
        return `${results.length} workers`;
      });
    } catch (error) {
      check('worker_threads can load the addon concurrently', () => { throw error; });
    }
  })();
}

if (wantGc) {
  if (typeof global.gc !== 'function') {
    warn('GC/lifetime check skipped', 'run node with --expose-gc to enable the engine churn check');
  } else {
    await checkAsync('repeated Engine create/use/drop does not grow memory unboundedly', async () => {
      global.gc();
      const before = process.memoryUsage();
      for (let index = 0; index < 150; index += 1) {
        const churn = new Engine();
        churn.newProject();
        churn.apply(JSON.stringify(APPLY_SETTINGS));
        churn.getTimeline();
        for (let clip = 0; clip < 5; clip += 1) {
          churn.apply(JSON.stringify({
            type: 'addTextsAutoTrack',
            entries: [{ startFrame: clip * 30, durationFrames: 30, content: `churn ${clip}`, textStyle: {}, transform: { centerX: 0.5, centerY: 0.5 } }],
          }));
        }
      }
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 25));
      global.gc();
      const after = process.memoryUsage();
      const rssDeltaMb = (after.rss - before.rss) / 1048576;
      const externalDeltaMb = (after.external - before.external) / 1048576;
      assert.ok(rssDeltaMb < 256, `RSS grew ${rssDeltaMb.toFixed(1)} MiB over 150 engines`);
      return `rss ${rssDeltaMb.toFixed(1)} MiB, external ${externalDeltaMb.toFixed(1)} MiB`;
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin integration: load the addon from a (optionally symlinked) plugin dir
// ---------------------------------------------------------------------------
if (pluginArg) {
  const pluginDir = path.resolve(pluginArg);
  const pluginEntry = path.join(pluginDir, 'index.js');
  check('plugin index.js exists', () => assert.ok(fs.existsSync(pluginEntry), pluginEntry));
  let pluginModule;
  try {
    pluginModule = await import(pathToFileURL(pluginEntry).href);
  } catch (error) {
    check('plugin module imports', () => { throw error; });
  }
  if (pluginModule) {
    check('plugin exports the Route B contract', () => {
      assert.equal(pluginModule.name, 'opentake-studio-route-b');
      assert.deepEqual(pluginModule.inject, ['tools', 'webServer', 'connection']);
      assert.equal(typeof pluginModule.apply, 'function');
    });
    const tools = new Map();
    const routes = [];
    const cleanups = [];
    const ctx = {
      get(name) {
        return name === 'tools'
          ? { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } }
          : undefined;
      },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; },
      webServer: { register(options) { routes.push(options); return () => {}; } },
    };
    Object.defineProperty(ctx, 'connection', { value: { requestRejection() { return undefined; } } });
    class FakeResponse extends Writable {
      constructor() { super(); this.statusCode = 200; this.headers = {}; this.chunks = []; }
      setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; }
      _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
    }
    async function pluginRequest(method, url) {
      const req = Readable.from([]);
      req.method = method;
      req.url = url;
      req.headers = {};
      const res = new FakeResponse();
      const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
      await routes[0].handler(req, res);
      await finished;
      return { status: res.statusCode, bytes: Buffer.concat(res.chunks) };
    }
    let info = null;
    await (async () => {
      try {
        pluginModule.apply(ctx);
        check('plugin registers tools and one prefix route', () => {
          assert.ok(tools.size >= 20, `only ${tools.size} tools registered`);
          assert.equal(routes.length, 1);
          assert.equal(routes[0].kind, 'prefix');
          assert.equal(routes[0].path, '/opentake-studio-route-b');
          return `${tools.size} tools`;
        });
        const response = await pluginRequest('GET', '/opentake-studio-route-b/engine/info');
        info = JSON.parse(response.bytes.toString('utf8'));
        check('plugin loads this addon from its native path', () => {
          assert.equal(response.status, 200);
          assert.equal(info.loaded, true, info.loadError ?? 'engine not loaded');
          assert.equal(info.loadError, null);
          assert.equal(info.node, process.versions.node);
          assert.equal(info.napi, process.versions.napi);
          note('plugin addonPath', info.addonPath);
        });
        const timeline = await pluginRequest('GET', '/opentake-studio-route-b/engine/timeline');
        check('plugin engine routes answer JSON snapshots', () => {
          assert.equal(timeline.status, 200);
          const snapshot = JSON.parse(timeline.bytes.toString('utf8'));
          expectKeys(snapshot, SNAPSHOT_KEYS, 'plugin snapshot');
        });
        if (securityProbe) {
          const secret = path.join(tempRoot, 'asset-secret.txt');
          fs.writeFileSync(secret, 'ROUTE-B-ASSET-PROBE');
          const asset = await pluginRequest('GET', `/opentake-studio-route-b/engine/asset?path=${encodeURIComponent(secret)}`);
          if (asset.status === 200 && asset.bytes.toString('utf8') === 'ROUTE-B-ASSET-PROBE') {
            warn('plugin /engine/asset reads any absolute path', 'same-origin authenticated page can read arbitrary local files (verified with a temp secret file)');
          } else {
            note('plugin /engine/asset did not serve the probe file', `status ${asset.status}`);
          }
        }
      } catch (error) {
        check('plugin integration probe', () => { throw error; });
      } finally {
        for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
fs.rmSync(tempRoot, { recursive: true, force: true });
const failed = checks.filter((entry) => entry.status === 'FAIL');
const warned = checks.filter((entry) => entry.status === 'WARN');
const summary = {
  addon: addonPath,
  runtime: { node: process.versions.node, napi: process.versions.napi, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch },
  passed: checks.filter((entry) => entry.status === 'PASS').length,
  warnings: warned.length,
  failed: failed.length,
  checks,
};
if (jsonOnly) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n${summary.passed} passed, ${summary.warnings} warning(s), ${summary.failed} failed`);
}
process.exit(failed.length > 0 ? 1 : 0);
