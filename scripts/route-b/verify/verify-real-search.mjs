#!/usr/bin/env node
/**
 * Real SigLIP2 text/image search verification for the Route B addon.
 *
 * Requires a complete, checksum-verified model install (see
 * verify-search-model.mjs) and a loadable addon path. It creates deterministic
 * red/blue fixtures, indexes them through the addon API, then checks that a text
 * query and an image query both rank the matching fixture above the distractor.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-real-search.mjs \
 *     [--addon PATH] [--models-dir DIR] [--cache-dir DIR] [--json]
 *
 * Exit codes: 0 verified; 2 model/addon not ready (logs why); 1 search failed.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const args = {
  addon: process.env.OPENTAKE_ADDON ?? path.join(os.tmpdir(), 'route-b-plugin-copy', 'native', 'darwin-arm64', 'opentake_engine_v38.node'),
  modelsDir: path.join(os.homedir(), '.dsh', 'opentake', 'models'),
  cacheDir: path.join(os.tmpdir(), 'route-b-search-cache-verify'),
  json: false,
};
for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2];
  if (arg === '--addon') args.addon = path.resolve(process.argv[++index + 2]);
  else if (arg === '--models-dir') args.modelsDir = path.resolve(process.argv[++index + 2]);
  else if (arg === '--cache-dir') args.cacheDir = path.resolve(process.argv[++index + 2]);
  else if (arg === '--json') args.json = true;
}
function fail(code, message) {
  if (args.json) console.log(JSON.stringify({ pass: false, code, message }, null, 2));
  else console.error(`verify-real-search: ${message}`);
  process.exit(code);
}
if (!fs.existsSync(args.addon)) fail(2, `addon not found: ${args.addon}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'route-b-search-verify-'));
const media = path.join(work, 'media');
fs.mkdirSync(media);
const run = (command, argv) => execFileSync(command, argv, { stdio: 'pipe' });
run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2', '-pix_fmt', 'yuv420p', path.join(media, 'red.mp4')]);
run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', path.join(media, 'blue.mp4')]);
const redFrame = path.join(work, 'red-frame.png');
run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(media, 'red.mp4'), '-frames:v', '1', redFrame]);

let Engine;
try {
  ({ Engine } = require(args.addon));
} catch (error) {
  fail(2, `addon load failed: ${error.message}`);
}
const engine = new Engine();
let capability;
try {
  capability = JSON.parse(engine.searchConfigure(args.modelsDir, args.cacheDir));
} catch (error) {
  fail(2, `searchConfigure failed: ${error.message}`);
}
if (capability.installed !== true || capability.visualAvailable !== true) {
  fail(2, `model not installed/ready: ${JSON.stringify(capability)}`);
}

const assets = [
  { id: 'red-video', path: path.join(media, 'red.mp4'), kind: 'video', durationSecs: 2 },
  { id: 'blue-video', path: path.join(media, 'blue.mp4'), kind: 'video', durationSecs: 2 },
];
const assetsJson = JSON.stringify(assets);
const status = JSON.parse(engine.searchIndexStart(assetsJson));
if (status.visualAvailable !== true || status.indexed !== assets.length) {
  fail(1, `indexing failed: ${JSON.stringify(status)}`);
}

const text = JSON.parse(engine.searchQuery('red', assetsJson, 30));
const image = JSON.parse(engine.searchQueryImage(fs.readFileSync(redFrame).toString('base64'), assetsJson, 30));
const top = (moments) => moments[0] ?? null;
const rank = (moments) => moments.map((moment) => `${moment.mediaId}:${Number(moment.score).toFixed(4)}`);
const textTop = top(text.moments ?? []);
const imageTop = top(image.moments ?? []);
const pass = text.visualAvailable === true && image.visualAvailable === true && textTop?.mediaId === 'red-video' && imageTop?.mediaId === 'red-video';
const result = {
  pass,
  backend: capability.backend,
  model: capability.model,
  modelInstalled: capability.installed,
  indexed: status.indexed,
  text: { query: 'red', moments: rank(text.moments ?? []), visualAvailable: text.visualAvailable, error: text.visualError ?? null },
  image: { query: 'red-frame.png', moments: rank(image.moments ?? []), visualAvailable: image.visualAvailable, error: image.visualError ?? null },
  cacheDir: args.cacheDir,
};
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`search capability: ${capability.backend} ${capability.model} installed=${capability.installed} visual=${capability.visualAvailable}`);
  console.log(`indexed: ${status.indexed}/${status.indexable}`);
  console.log(`text "red": ${result.text.moments.join(' | ') || '(none)'}`);
  console.log(`image red frame: ${result.image.moments.join(' | ') || '(none)'}`);
  console.log(pass ? 'verify-real-search: PASS (red fixture ranks first for text and image queries)' : 'verify-real-search: FAIL');
}
process.exit(pass ? 0 : 1);
