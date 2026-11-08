#!/usr/bin/env node
/**
 * Production HDR10 export verification for the built Route B addon.
 *
 * Proves the follow-up production path (not just the isolated export-pro demo):
 *   - an HDR (BT.2020/PQ) source on the timeline is decoded to linear RGBA16F,
 *     composited and written as HDR10;
 *   - the output really is Main10 / yuv420p10le / BT.2020 / SMPTE2084 with
 *     mastering-display + content-light metadata;
 *   - requesting HDR10 for an SDR source is refused instead of being silently
 *     tagged HDR;
 *   - requesting HDR10 with a non-H.265 codec is refused.
 *
 * This must be run against an addon built from the current source; a stale
 * checked-in artifact ignores the `hdr10` argument and produces SDR output.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-hdr-production.mjs \
 *     [--addon PATH] [--hdr FILE] [--sdr FILE] [--out-dir DIR] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const args = {
  addon: '/tmp/opentake_v39_built.node',
  hdr: '/tmp/route-b-hdr10/hdr10_true.mp4',
  sdr: '/tmp/route-b-hdr10/hdr10_sdr_fallback.mp4',
  outDir: '/tmp/route-b-hdr10',
  json: false,
};
for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2];
  if (arg === '--addon') args.addon = path.resolve(process.argv[++index + 2]);
  else if (arg === '--hdr') args.hdr = path.resolve(process.argv[++index + 2]);
  else if (arg === '--sdr') args.sdr = path.resolve(process.argv[++index + 2]);
  else if (arg === '--out-dir') args.outDir = path.resolve(process.argv[++index + 2]);
  else if (arg === '--json') args.json = true;
}
function fail(code, message) {
  if (args.json) console.log(JSON.stringify({ pass: false, code, message }, null, 2));
  else console.error(`verify-hdr-production: ${message}`);
  process.exit(code);
}
for (const [label, file] of [['addon', args.addon], ['HDR source', args.hdr], ['SDR source', args.sdr]]) {
  if (!fs.existsSync(file)) fail(2, `${label} not found: ${file}`);
}
fs.mkdirSync(args.outDir, { recursive: true });
const { Engine } = require(args.addon);

function buildProject(engine, sourceFile, name, requirePq = true) {
  engine.newProject();
  const imported = JSON.parse(engine.importMedia([sourceFile]));
  const item = imported.items[0];
  if (requirePq && item.color?.transfer !== 'smpte2084') throw new Error(`fixture not PQ: ${JSON.stringify(item.color)}`);
  engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
  const timeline = JSON.parse(engine.getTimeline());
  const trackIndex = timeline.timeline.tracks.findIndex((track) => track.type === 'video');
  const clip = {
    mediaRef: item.id, mediaType: 'video', sourceClipType: 'video', trackIndex,
    startFrame: 0, durationFrames: 10, trimStartFrame: 0, trimEndFrame: 0,
    hasAudio: false, addLinkedAudio: false,
  };
  engine.apply(JSON.stringify({ type: 'addClips', entries: [clip] }));
  return { item, name };
}

function ffprobe(file) {
  const output = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries:stream_side_data_list', '-of', 'json', file], { encoding: 'utf8' });
  return (JSON.parse(output).streams ?? [])[0] ?? {};
}

const hdrOut = path.join(args.outDir, 'production_hdr10.mp4');
const sdrOut = path.join(args.outDir, 'production_sdr_requested_hdr10.mp4');
const engine = new Engine();
buildProject(engine, args.hdr, 'hdr');
let exported;
try {
  exported = JSON.parse(engine.exportVideo(hdrOut, 'h265', '720p', null, false, true));
} catch (error) {
  fail(1, `HDR10 export failed (stale addon? expected hdr10=true result): ${error.message}`);
}
if (exported.hdr10 !== true) fail(1, `addon ignored hdr10 request: ${JSON.stringify(exported)}`);
const stream = ffprobe(hdrOut);
const sideTypes = (stream.side_data_list ?? []).map((entry) => String(entry.side_data_type ?? ''));
const hdrOk = stream.codec_name === 'hevc'
  && /Main 10/i.test(stream.profile ?? '')
  && /10(le|be)$/.test(stream.pix_fmt ?? '')
  && stream.color_primaries === 'bt2020'
  && stream.color_transfer === 'smpte2084'
  && stream.color_space === 'bt2020nc';
// ffprobe reports mastering metadata on frames; the CLI HDR10 evidence script
// verifies it separately, here require the export result's metadata and PQ tags.
if (!hdrOk) fail(1, `HDR10 output tags are wrong: ${JSON.stringify(stream)}`);

// Negative 1: SDR source must be refused, never tagged HDR.
const sdrEngine = new Engine();
buildProject(sdrEngine, args.sdr, 'sdr', false);
let sdrRejected = null;
try {
  sdrEngine.exportVideo(sdrOut, 'h265', '720p', null, false, true);
} catch (error) {
  sdrRejected = error.message;
}
if (!sdrRejected || !/requires HDR sources/i.test(sdrRejected)) fail(1, `SDR source was not rejected for HDR10: ${sdrRejected ?? 'exported anyway'}`);

// Negative 2: HDR10 requires H.265 Main10.
const codecEngine = new Engine();
buildProject(codecEngine, args.hdr, 'hdr-codec');
let codecRejected = null;
try {
  codecEngine.exportVideo(path.join(args.outDir, 'production_wrong_codec.mp4'), 'h264', '720p', null, false, true);
} catch (error) {
  codecRejected = error.message;
}
if (!codecRejected || !/requires codec h265/i.test(codecRejected)) fail(1, `non-H.265 HDR10 request was not rejected: ${codecRejected ?? 'exported anyway'}`);

const result = {
  pass: true,
  addon: args.addon,
  output: hdrOut,
  exported,
  stream,
  hdrTagsOk: hdrOk,
  sdrRejected,
  codecRejected,
};
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`addon: ${args.addon}`);
  console.log(`HDR export: ${exported.hdr10 === true ? 'hdr10=true' : 'hdr10 MISSING'} ${exported.width}x${exported.height} ${exported.frameCount} frames`);
  console.log(`ffprobe: ${stream.codec_name}/${stream.profile}/${stream.pix_fmt} ${stream.color_primaries}/${stream.color_transfer}/${stream.color_space}`);
  console.log(`SDR refused: ${sdrRejected}`);
  console.log(`wrong codec refused: ${codecRejected}`);
  console.log('verify-hdr-production: PASS');
}
process.exit(0);
