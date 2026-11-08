#!/usr/bin/env node
/**
 * HDR expansion verification: audio mixdown and transformed/multiple layers.
 *
 * The v40 supported subset rejected audio and non-identity transforms. This
 * verifier checks the follow-up expansion:
 *   - HDR10 export with an audio track produces HDR video + an AAC audio stream;
 *   - a transformed/opacity HDR video layer exports (linear affine compositing);
 *   - two overlapping HDR video layers export together;
 *   - SDR source is still refused (never mislabelled HDR).
 *
 * Must run against an addon built from the expanded source.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-hdr-expansion.mjs \
 *     [--addon PATH] [--hdr FILE] [--sdr FILE] [--audio FILE] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {
  addon: '/tmp/opentake_expanded.node',
  hdr: '/tmp/route-b-hdr10/hdr10_true.mp4',
  sdr: '/tmp/route-b-hdr10/hdr10_sdr_fallback.mp4',
  audio: '/tmp/ostudio-media/music.wav',
  outDir: path.join(os.tmpdir(), 'route-b-hdr-expansion'),
  json: false,
};
for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2];
  if (arg === '--addon') args.addon = path.resolve(process.argv[++index + 2]);
  else if (arg === '--hdr') args.hdr = path.resolve(process.argv[++index + 2]);
  else if (arg === '--sdr') args.sdr = path.resolve(process.argv[++index + 2]);
  else if (arg === '--audio') args.audio = path.resolve(process.argv[++index + 2]);
  else if (arg === '--out-dir') args.outDir = path.resolve(process.argv[++index + 2]);
  else if (arg === '--json') args.json = true;
}
function fail(code, message) {
  if (args.json) console.log(JSON.stringify({ pass: false, code, message }, null, 2));
  else console.error(`verify-hdr-expansion: ${message}`);
  process.exit(code);
}
for (const [label, file] of [['addon', args.addon], ['HDR source', args.hdr], ['SDR source', args.sdr], ['audio', args.audio]]) {
  if (!fs.existsSync(file)) fail(2, `${label} not found: ${file}`);
}
fs.mkdirSync(args.outDir, { recursive: true });
const { Engine } = createRequire(import.meta.url)(args.addon);

function probe(file) {
  const output = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(output);
}
function videoStream(probeResult) { return probeResult.streams.find((stream) => stream.codec_type === 'video'); }
function audioStream(probeResult) { return probeResult.streams.find((stream) => stream.codec_type === 'audio'); }
function assertHdr(stream, label) {
  const ok = stream
    && stream.codec_name === 'hevc'
    && /Main 10/i.test(stream.profile ?? '')
    && /10(le|be)$/.test(stream.pix_fmt ?? '')
    && stream.color_primaries === 'bt2020'
    && stream.color_transfer === 'smpte2084'
    && stream.color_space === 'bt2020nc';
  if (!ok) fail(1, `${label}: wrong HDR tags ${JSON.stringify(stream)}`);
}
function addVideo(engine, mediaId, trackIndex, extra = {}) {
  engine.apply(JSON.stringify({
    type: 'addClips',
    entries: [{
      mediaRef: mediaId, mediaType: 'video', sourceClipType: 'video', trackIndex,
      startFrame: 0, durationFrames: 10, trimStartFrame: 0, trimEndFrame: 0,
      hasAudio: false, addLinkedAudio: false, ...extra,
    }],
  }));
}

// --- A. HDR video + audio track ------------------------------------------
const audioEngine = new Engine();
audioEngine.newProject();
const hdrCatalog = JSON.parse(audioEngine.importMedia([args.hdr]));
const hdrMedia = hdrCatalog.items[0];
audioEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const audioCatalog = JSON.parse(audioEngine.importMedia([args.audio]));
const audioMedia = audioCatalog.items.find((item) => item.type === 'audio' && item.path === args.audio)
  ?? audioCatalog.items.find((item) => item.type === 'audio');
addVideo(audioEngine, hdrMedia.id, 0);
// Empty tracks are pruned when a clip is added, so insert the audio track after
// the video clip exists.
audioEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'audio' }));
const audioTimeline = JSON.parse(audioEngine.getTimeline()).timeline;
const audioTrackIndex = audioTimeline.tracks.findIndex((track) => track.type === 'audio');
audioEngine.apply(JSON.stringify({
  type: 'addClips',
  entries: [{
    mediaRef: audioMedia.id, mediaType: 'audio', sourceClipType: 'audio', trackIndex: audioTrackIndex,
    startFrame: 0, durationFrames: 10, trimStartFrame: 0, trimEndFrame: 0, hasAudio: true, addLinkedAudio: false,
  }],
}));
const audioOut = path.join(args.outDir, 'hdr10_with_audio.mp4');
let audioSummary;
try {
  audioSummary = JSON.parse(audioEngine.exportVideo(audioOut, 'h265', '720p', null, false, true));
} catch (error) {
  fail(1, `HDR10+audio export failed: ${error.message}`);
}
if (audioSummary.hdr10 !== true || audioSummary.hasAudio !== true) fail(1, `HDR+audio summary wrong: ${JSON.stringify(audioSummary)}`);
const audioProbe = probe(audioOut);
assertHdr(videoStream(audioProbe), 'HDR+audio video');
const audio = audioStream(audioProbe);
if (!audio || !['aac', 'mp4a'].includes(audio.codec_name)) fail(1, `HDR+audio has no AAC audio stream: ${JSON.stringify(audio)}`);

// --- B. transformed + two overlapping HDR layers --------------------------
const layerEngine = new Engine();
layerEngine.newProject();
const layerCatalog = JSON.parse(layerEngine.importMedia([args.hdr]));
const layerMedia = layerCatalog.items[0];
layerEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
addVideo(layerEngine, layerMedia.id, 0, {
  transform: { centerX: 0.3, centerY: 0.5, width: 0.5, height: 1.0, rotation: 5, flipHorizontal: false, flipVertical: false },
});
// Insert the second video track after the first clip so it is not pruned.
layerEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
const layerSecondTrack = JSON.parse(layerEngine.getTimeline()).timeline.tracks
  .map((track, index) => ({ track, index }))
  .filter(({ track }) => track.type === 'video').at(-1).index;
addVideo(layerEngine, layerMedia.id, layerSecondTrack, { opacity: 0.5 });
const layerTimeline = JSON.parse(layerEngine.getTimeline()).timeline;
const layerCount = layerTimeline.tracks.reduce((count, track) => count + track.clips.length, 0);
if (layerCount !== 2) fail(1, `expected 2 layers, got ${layerCount}`);
const layerOut = path.join(args.outDir, 'hdr10_two_layers.mp4');
let layerSummary;
try {
  layerSummary = JSON.parse(layerEngine.exportVideo(layerOut, 'h265', '720p', null, false, true));
} catch (error) {
  fail(1, `transformed/two-layer HDR export failed: ${error.message}`);
}
if (layerSummary.hdr10 !== true) fail(1, 'two-layer export did not report hdr10');
assertHdr(videoStream(probe(layerOut)), 'two-layer HDR');

// --- C. SDR regression: still rejected -----------------------------------
const sdrEngine = new Engine();
sdrEngine.newProject();
const sdrCatalog = JSON.parse(sdrEngine.importMedia([args.sdr]));
const sdrMedia = sdrCatalog.items[0];
sdrEngine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' }));
addVideo(sdrEngine, sdrMedia.id, 0);
let sdrRejected = null;
try {
  sdrEngine.exportVideo(path.join(args.outDir, 'sdr_false_hdr.mp4'), 'h265', '720p', null, false, true);
} catch (error) { sdrRejected = error.message; }
if (!sdrRejected || !/requires HDR sources/i.test(sdrRejected)) fail(1, `SDR source was not rejected: ${sdrRejected ?? 'exported'}`);

const result = {
  pass: true,
  addon: args.addon,
  audio: { output: audioOut, summary: audioSummary, video: videoStream(audioProbe), audio: audio },
  layers: { output: layerOut, summary: layerSummary, layers: layerCount, video: videoStream(probe(layerOut)) },
  sdrRejected,
};
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`addon: ${args.addon}`);
  console.log(`audio: ${audio.codec_name} + ${result.audio.video.profile}/${result.audio.video.pix_fmt} ${result.audio.video.color_transfer}`);
  console.log(`layers: ${layerCount} transformed/opacity HDR layers -> ${result.layers.video.profile}/${result.layers.video.pix_fmt}`);
  console.log(`SDR refused: ${sdrRejected}`);
  console.log('verify-hdr-expansion: PASS');
}
process.exit(0);
