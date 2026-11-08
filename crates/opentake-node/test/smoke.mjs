// Node-API smoke test for the Route B engine addon.
// Usage: node crates/opentake-node/test/smoke.mjs [path/to/opentake_engine.node]
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const addon =
  process.argv[2] ??
  path.join(root, 'plugins/opentake-studio-route-b/native', `${process.platform}-${process.arch}`, 'opentake_engine_v28.node');
const { Engine } = createRequire(import.meta.url)(addon);
const engine = new Engine();
const created = JSON.parse(engine.newProject());
assert.equal(created.version, 0);
assert.equal(created.timeline.tracks.length, 0);

const applied = JSON.parse(engine.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 24, width: 1280, height: 720 })));
assert.equal(applied.result.changed, true);
assert.equal(applied.timeline.timeline.fps, 24);

const undone = JSON.parse(engine.undo());
assert.equal(undone.timeline.fps, 30);
assert.equal(engine.canRedo(), true);
const redone = JSON.parse(engine.redo());
assert.equal(redone.timeline.fps, 24);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opentake-routeb-smoke-'));
const projectPath = path.join(tempRoot, 'demo.opentake');
const saved = JSON.parse(engine.newProjectAt(projectPath));
assert.equal(saved.projectPath, projectPath);
assert.ok(fs.existsSync(path.join(projectPath, 'project.json')));
const reopened = new Engine();
const opened = JSON.parse(reopened.openProject(projectPath));
assert.equal(opened.projectPath, projectPath);
assert.equal(opened.timeline.fps, 30);
fs.rmSync(tempRoot, { recursive: true, force: true });

const media = JSON.parse(engine.mediaList());
assert.ok(Array.isArray(media.items));
assert.ok(Array.isArray(media.folders));
console.log('route-b addon smoke: ok');
