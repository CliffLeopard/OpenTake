#!/usr/bin/env node
/**
 * Route B Host API verification — runs the real Route B DSH plugin Host half
 * against the real `opentake-node` addon through a fake Cordis context.
 *
 * This exercises the same HTTP routes and native tools the DSH Host exposes,
 * without booting DSH: project lifecycle, recursive folder import, media
 * catalog/thumbnails, waveform/sprite caches, timeline placement, preview,
 * playback endpoints, H.264/AAC/audio-only export, interchange/subtitle
 * export, text search, ASR + captions, provider generation (local mocks) and
 * Motion Studio preview (local Chrome).
 *
 * Usage:
 *   node scripts/route-b/verify/verify-host-api.mjs [--plugin <plugin-dir>] [--json]
 *
 * Exit code 0 = all checks passed; 1 = failures. Warnings do not fail.
 * All files are written under the OS temp dir and removed on exit.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
const pluginDir = path.resolve(option('--plugin') ?? path.join(process.cwd(), 'plugins/opentake-studio-route-b'));
const PREFIX = '/opentake-studio-route-b';
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
async function checkAsync(name, fn) {
  try {
    const value = await fn();
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'route-b-host-api-'));
const mockServers = [];
const cleanups = [];

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
  }
  setHeader(key, value) {
    this.headers[String(key).toLowerCase()] = value;
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

const pluginModule = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href);
const tools = new Map();
const routes = [];
const ctx = {
  get(service) {
    return service === 'tools'
      ? { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } }
      : undefined;
  },
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  webServer: {
    register(options) {
      routes.push(options);
      return () => {};
    },
  },
};
Object.defineProperty(ctx, 'connection', { value: { requestRejection() { return undefined; } } });
pluginModule.apply(ctx);
const route = routes[0];

async function request(method, url, { body, headers = {}, timeoutMs = 120_000 } = {}) {
  const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  const res = new FakeResponse();
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method} ${url}`)), timeoutMs);
    res.once('finish', () => { clearTimeout(timer); resolve(); });
    res.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  await route.handler(req, res);
  await finished;
  const bytes = Buffer.concat(res.chunks);
  return { status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8') };
}

async function jsonRequest(method, url, options) {
  const response = await request(method, url, options);
  let json = null;
  try { json = JSON.parse(response.text); } catch { /* not JSON */ }
  return { ...response, json };
}

async function invoke(cmd, invokeArgs = {}) {
  const response = await jsonRequest('POST', `${PREFIX}/engine/invoke`, {
    body: JSON.stringify({ cmd, args: invokeArgs }),
  });
  return response;
}

async function tool(name, toolArgs = {}) {
  const definition = tools.get(name);
  assert.ok(definition, `tool ${name} not registered`);
  return definition.execute(toolArgs, { callId: 'verify' });
}

function run(binary, argv) {
  return execFileSync(binary, argv, { encoding: 'buffer', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
}
function ffprobe(file) {
  const stdout = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(stdout.toString('utf8'));
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { void handler(req, res, baseUrl); });
    let baseUrl = null;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      mockServers.push(server);
      resolve(baseUrl);
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

try {
  // -------------------------------------------------------------------------
  // Plugin surface
  // -------------------------------------------------------------------------
  check('plugin registers one prefix route and its native tools', () => {
    assert.equal(routes.length, 1);
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, PREFIX);
    assert.ok(tools.size >= 28, `expected >= 28 tools, got ${tools.size}`);
    for (const required of [
      'opentake_route_b_engine_info', 'opentake_route_b_get_timeline', 'opentake_route_b_apply',
      'opentake_route_b_import_folder', 'opentake_route_b_import_media', 'opentake_route_b_export_video',
      'opentake_route_b_search', 'opentake_route_b_generate_image', 'opentake_route_b_generate_speech',
      'opentake_route_b_generate_video', 'opentake_route_b_export_audio', 'opentake_route_b_export_timeline',
      'opentake_route_b_export_subtitles',
    ]) {
      assert.ok(tools.has(required), `missing tool ${required}`);
    }
    return `${tools.size} tools`;
  });

  let info = null;
  await checkAsync('engine/info reports a loaded v28 addon', async () => {
    const response = await jsonRequest('GET', `${PREFIX}/engine/info`);
    assert.equal(response.status, 200);
    info = response.json;
    assert.equal(info.loaded, true, info.loadError ?? 'not loaded');
    assert.equal(info.loadError, null);
    assert.match(info.addonPath, /opentake_engine_v\d+\.node$/);
    assert.equal(info.node, process.versions.node);
    assert.equal(info.napi, process.versions.napi);
    return `${info.platform}/${info.arch} node=${info.node} napi=${info.napi}`;
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
  const fixtureDir = path.join(tempRoot, 'fixtures');
  const nestedDir = path.join(fixtureDir, 'nested');
  fs.mkdirSync(nestedDir, { recursive: true });
  const videoFile = path.join(fixtureDir, 'clip.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoFile]);
  const audioFile = path.join(fixtureDir, 'sound.mp3');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', audioFile]);
  const imageFile = path.join(fixtureDir, 'card.png');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1', '-frames:v', '1', imageFile]);
  const nestedImage = path.join(nestedDir, 'poster.png');
  fs.copyFileSync(imageFile, nestedImage);
  fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), 'not media');

  // -------------------------------------------------------------------------
  // Project + recursive folder import (v28 workstream)
  // -------------------------------------------------------------------------
  const bundle = path.join(tempRoot, 'project.opentake');
  await checkAsync('project_new creates a .opentake bundle', async () => {
    const response = await invoke('project_new', { path: bundle });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.projectPath, bundle);
    assert.ok(fs.existsSync(path.join(bundle, 'project.json')));
    assert.ok(fs.existsSync(path.join(bundle, 'media.json')));
  });

  let importedIds = {};
  await checkAsync('import_folder recursively imports video/audio/image (v28)', async () => {
    const response = await invoke('import_folder', { path: fixtureDir, recursive: true });
    assert.equal(response.status, 200, response.text);
    const catalog = response.json;
    assert.ok(Array.isArray(catalog.items));
    const names = catalog.items.map((item) => item.name).sort();
    for (const expected of ['clip', 'sound', 'card', 'poster']) {
      assert.ok(names.includes(expected), `${expected} missing from ${names.join(',')}`);
    }
    importedIds = {
      video: catalog.items.find((item) => item.name === 'clip').id,
      audio: catalog.items.find((item) => item.name === 'sound').id,
      image: catalog.items.find((item) => item.name === 'card').id,
    };
    assert.equal(catalog.items.find((item) => item.name === 'clip').hasAudio, true);
    return `${catalog.items.length} items`;
  });

  await checkAsync('import_folder tool is registered and returns the catalog', async () => {
    const result = await tool('opentake_route_b_import_folder', { path: fixtureDir, recursive: true });
    assert.ok(result.data.items.length >= 4);
    return `${result.data.items.length} items`;
  });

  // -------------------------------------------------------------------------
  // Media catalog / thumbnail / waveform / sprite caches
  // -------------------------------------------------------------------------
  await checkAsync('import paths generate poster thumbnails (v38 folder fix)', async () => {
    // v38 fix: import_folder now runs the thumbnail-generating import path.
    const folderCatalog = await jsonRequest('GET', `${PREFIX}/engine/media`);
    const folderVideo = folderCatalog.json.items.find((item) => item.id === importedIds.video);
    assert.ok(folderVideo, 'folder-imported video missing');
    assert.ok(folderVideo.thumbnail, 'import_folder did not generate a video poster thumbnail');
    assert.ok(fs.existsSync(folderVideo.thumbnail), folderVideo.thumbnail);
    // Legacy import-media path also generates a poster for a fresh asset.
    const freshImage = path.join(tempRoot, 'legacy-card.png');
    fs.copyFileSync(imageFile, freshImage);
    const legacy = await jsonRequest('POST', `${PREFIX}/engine/import-media`, { body: JSON.stringify({ paths: [freshImage] }) });
    assert.equal(legacy.status, 200, legacy.text);
    const image = legacy.json.items.find((item) => fs.realpathSync(item.path) === fs.realpathSync(freshImage));
    assert.ok(image, 'imported image missing');
    assert.ok(image.thumbnail, 'legacy import did not generate a thumbnail');
    assert.ok(fs.existsSync(image.thumbnail), `thumbnail missing at ${image.thumbnail}`);
    assert.equal(fs.statSync(image.thumbnail).size > 100, true);
    return image.thumbnail;
  });

  await checkAsync('get_waveform returns non-empty buckets', async () => {
    const response = await invoke('get_waveform', { mediaRef: importedIds.video });
    assert.equal(response.status, 200, response.text);
    assert.ok(Array.isArray(response.json));
    assert.ok(response.json.length > 10, `buckets=${response.json.length}`);
    return `${response.json.length} buckets`;
  });

  await checkAsync('request_timeline_sprite builds a cached JPEG tile grid (v28)', async () => {
    const response = await invoke('request_timeline_sprite', { mediaRef: importedIds.video, maxFrames: 8 });
    assert.equal(response.status, 200, response.text);
    const thumbnail = response.json.thumbnail;
    assert.equal(response.json.status, 'cached');
    assert.ok(thumbnail, 'sprite thumbnail missing');
    assert.ok(fs.existsSync(thumbnail.spritePath), thumbnail.spritePath);
    const bytes = fs.readFileSync(thumbnail.spritePath);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.equal(thumbnail.tileWidth, 160);
    assert.ok(thumbnail.columns >= 1);
    assert.equal(thumbnail.times.length, 8);
    return `${thumbnail.columns}x${thumbnail.rows ?? '?'} tiles @${thumbnail.tileWidth}px`;
  });

  // -------------------------------------------------------------------------
  // Timeline placement / preview / playback
  // -------------------------------------------------------------------------
  let videoClipId = null;
  await checkAsync('edit_apply inserts a video clip with linked audio', async () => {
    const insertTrack = await invoke('edit_apply', { command: { type: 'insertTrack', kind: 'video', at: 0 } });
    assert.equal(insertTrack.status, 200, insertTrack.text);
    const response = await invoke('edit_apply', {
      command: {
        type: 'addClips',
        entries: [{
          mediaRef: importedIds.video,
          mediaType: 'video',
          sourceClipType: 'video',
          trackIndex: 0,
          startFrame: 0,
          durationFrames: 30,
          trimStartFrame: 0,
          trimEndFrame: 0,
          hasAudio: true,
          addLinkedAudio: true,
        }],
      },
    });
    assert.equal(response.status, 200, response.text);
    // The invoke `edit_apply` bridge returns the bare EditResultDto (the UI
    // shim refetches the timeline); the /engine/apply route returns the full
    // ApplyResponse. Accept the invoke contract here.
    assert.equal(response.json.changed, true);
    const timelineResponse = await jsonRequest('GET', `${PREFIX}/engine/timeline`);
    assert.equal(timelineResponse.status, 200, timelineResponse.text);
    const tracks = timelineResponse.json.timeline.tracks;
    assert.ok(tracks.length >= 2, `tracks=${tracks.length}`);
    const clips = tracks.flatMap((track) => track.clips);
    assert.ok(clips.length >= 2, 'video + linked audio missing');
    assert.ok(clips.every((clip) => clip.startFrame === 0 && clip.durationFrames === 30));
    assert.equal(typeof clips[0].linkGroupId, 'string');
    const affected = Array.isArray(response.json.affectedClipIds) ? response.json.affectedClipIds : [];
    videoClipId = affected.find((id) => clips.some((clip) => clip.id === id && clip.mediaType === 'video')) ?? clips.find((clip) => clip.mediaType === 'video')?.id ?? null;
    return `${tracks.length} tracks / ${clips.length} clips`;
  });

  await checkAsync('composite preview frame returns a PNG', async () => {
    const response = await request('GET', `${PREFIX}/engine/preview/frame?frame=0`);
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.equal(response.bytes[0], 0x89);
    assert.equal(response.bytes[1], 0x50);
    assert.equal(response.bytes[2], 0x4e);
    assert.equal(response.bytes[3], 0x47);
    return `${response.bytes.length} bytes`;
  });

  await checkAsync('composite_frame invoke returns a PNG data URL', async () => {
    const response = await invoke('composite_frame', { frame: 0 });
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.match(response.json.dataUrl, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(response.json.dataUrl.split(',')[1], 'base64')[0], 0x89);
    return `${response.json.width}x${response.json.height}`;
  });

  await checkAsync('preview frame JPEG mode returns a JPEG (v38)', async () => {
    const response = await request('GET', `${PREFIX}/engine/preview/frame?frame=0&format=jpeg`);
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.match(response.headers['content-type'], /image\/jpeg/);
    assert.equal(response.bytes[0], 0xff);
    assert.equal(response.bytes[1], 0xd8);
    return `${response.bytes.length} bytes`;
  });

  await checkAsync('v38 denoise/loudness/stabilization analysis bridges answer', async () => {
    assert.ok(videoClipId, 'video clip id missing');
    const denoise = await invoke('prepare_denoise', { clipId: videoClipId, mode: 'voice', strength: 0.4, previewEnabled: false });
    assert.equal(denoise.status, 200, denoise.text);
    assert.equal(denoise.json.mode, 'voice');
    assert.equal(denoise.json.strength, 0.4);
    const loudness = await invoke('analyze_loudness', { clipId: videoClipId, targetLufs: -16, truePeakCeilingDbtp: -1 });
    assert.equal(loudness.status, 200, loudness.text);
    assert.equal(typeof loudness.json.inputIntegratedLufs, 'number');
    assert.equal(typeof loudness.json.gainDb, 'number');
    const stabilization = await invoke('analyze_stabilization', { clipId: videoClipId });
    assert.equal(stabilization.status, 200, stabilization.text);
    assert.equal(typeof stabilization.json, 'object');
    return `denoise=${denoise.json.mode} loudness=${loudness.json.gainDb.toFixed(1)}dB stabilisation keys=${Object.keys(stabilization.json).length}`;
  });

  await checkAsync('playback start/seek/status/pause/stop endpoints work', async () => {
    assert.equal((await invoke('playback_start', { fromFrame: 0 })).status, 200);
    const status = await jsonRequest('GET', `${PREFIX}/engine/playback/status`);
    assert.equal(status.status, 200);
    assert.equal(status.json.active, true);
    assert.equal(typeof status.json.frame, 'number');
    assert.equal((await invoke('playback_seek', { frame: 10 })).status, 200);
    const seeked = await jsonRequest('GET', `${PREFIX}/engine/playback/status`);
    assert.equal(seeked.json.frame, 10);
    assert.equal((await invoke('playback_pause', { frame: 10 })).status, 200);
    assert.equal((await invoke('playback_stop')).status, 200);
    const stopped = await jsonRequest('GET', `${PREFIX}/engine/playback/status`);
    assert.equal(stopped.json.active, false);
    return 'start/seek/pause/stop';
  });

  await checkAsync('playback uses the native cpal clock and stream endpoints (v38)', async () => {
    assert.equal((await invoke('playback_start', { fromFrame: 0 })).status, 200);
    const audio = await request('GET', `${PREFIX}/engine/playback/audio`);
    const nativeAudio = audio.status === 409;
    if (!nativeAudio) {
      assert.equal(audio.status, 200, audio.text.slice(0, 200));
      assert.equal(audio.bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    } else {
      assert.equal(JSON.parse(audio.text).error.code, 'native-audio');
    }
    const stream = await request('GET', `${PREFIX}/engine/playback/stream?frames=1&maxSize=320`);
    assert.equal(stream.status, 200, stream.text.slice(0, 200));
    assert.match(stream.headers['content-type'], /multipart\/x-mixed-replace/);
    assert.ok(stream.bytes.includes(Buffer.from('--routebframe')), 'multipart boundary missing');
    assert.ok(stream.bytes.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'PNG frame missing from stream');
    await invoke('playback_stop');
    return nativeAudio ? 'native cpal clock active; multipart PNG stream OK' : 'WAV fallback (no cpal device); multipart PNG stream OK';
  });

  // -------------------------------------------------------------------------
  // Export: H.264 range, audio-only m4a, interchange, subtitles
  // -------------------------------------------------------------------------
  // Persist before exporting so render/media resolution uses the bundle path.
  assert.equal((await invoke('project_save', { path: bundle })).status, 200);
  const videoOut = path.join(tempRoot, 'range.mp4');
  await checkAsync('export_video range exports a playable H.264 clip', async () => {
    const response = await invoke('export_video', {
      operationId: 'verify-range',
      req: { outPath: videoOut, codec: 'h264', quality: '720p', rangeStartFrame: 0, rangeEndFrame: 15 },
    });
    assert.equal(response.status, 200, response.text);
    assert.ok(fs.existsSync(videoOut));
    const probe = ffprobe(videoOut);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.ok(video, 'no video stream');
    assert.equal(video.codec_name, 'h264');
    const duration = Number(probe.format.duration);
    assert.ok(duration > 0.2 && duration < 1.2, `duration ${duration}`);
    return `${duration.toFixed(2)}s ${video.width}x${video.height}`;
  });

  const hevc10Out = path.join(tempRoot, 'range-10bit.mp4');
  await checkAsync('10-bit H.265 export is Main10/yuv420p10le and NOT falsely HDR-tagged', async () => {
    const response = await invoke('export_video', {
      operationId: 'verify-hevc10',
      req: { outPath: hevc10Out, codec: 'h265', bitDepth: 10, quality: '720p', rangeStartFrame: 0, rangeEndFrame: 15 },
    });
    assert.equal(response.status, 200, response.text);
    const probe = ffprobe(hevc10Out);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'hevc');
    assert.equal(video.profile, 'Main 10');
    assert.equal(video.pix_fmt, 'yuv420p10le');
    // SDR source: 10-bit precision must not be advertised as HDR10.
    assert.ok(!['smpte2084', 'arib-std-b67'].includes(video.color_transfer), `unexpected HDR transfer ${video.color_transfer}`);
    assert.ok(video.color_primaries !== 'bt2020', `unexpected HDR primaries ${video.color_primaries}`);
    const sideData = video.side_data_list ?? [];
    assert.equal(sideData.some((entry) => /Mastering|Content light/i.test(entry.side_data_type ?? '')), false);
    return `${video.profile}/${video.pix_fmt} transfer=${video.color_transfer} primaries=${video.color_primaries}`;
  });

  const audioOut = path.join(tempRoot, 'audio.m4a');
  await checkAsync('export_audio writes a valid AAC m4a mixdown', async () => {
    const response = await invoke('export_audio', { outPath: audioOut, format: 'm4a' });
    assert.equal(response.status, 200, response.text);
    assert.ok(fs.existsSync(audioOut));
    const probe = ffprobe(audioOut);
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    assert.ok(audio, 'no audio stream');
    assert.equal(audio.codec_name, 'aac');
    return `${Number(probe.format.duration).toFixed(2)}s`;
  });

  await checkAsync('music ducking export lowers standalone music against linked A/V audio (v38)', async () => {
    // Add a standalone audio clip (music) next to the linked A/V audio (voice).
    const inserted = await invoke('edit_apply', { command: { type: 'insertTrack', kind: 'audio', at: null } });
    assert.equal(inserted.status, 200, inserted.text);
    const timeline = await jsonRequest('GET', `${PREFIX}/engine/timeline`);
    const audioTrackIndex = timeline.json.timeline.tracks.findIndex((track) => track.type === 'audio' && track.clips.length === 0);
    assert.ok(audioTrackIndex >= 0, 'no empty audio track to place music on');
    const placed = await invoke('edit_apply', {
      command: { type: 'addClips', entries: [{
        mediaRef: importedIds.audio, mediaType: 'audio', sourceClipType: 'audio',
        trackIndex: audioTrackIndex, startFrame: 0, durationFrames: 30, trimStartFrame: 0, trimEndFrame: 0,
        hasAudio: true, addLinkedAudio: false,
      }] },
    });
    assert.equal(placed.status, 200, placed.text);
    const normal = path.join(tempRoot, 'mix-normal.m4a');
    const ducked = path.join(tempRoot, 'mix-ducked.m4a');
    assert.equal((await invoke('export_audio', { outPath: normal, format: 'm4a' })).status, 200);
    assert.equal((await invoke('export_audio', { outPath: ducked, format: 'm4a', duckMusic: true })).status, 200);
    const rms = (file) => {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 64 * 1024 * 1024 });
      const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let sum = 0;
      for (const value of values) sum += value * value;
      return Math.sqrt(sum / Math.max(1, values.length));
    };
    const normalRms = rms(normal);
    const duckedRms = rms(ducked);
    // Voice window is the whole 1 s here; ducking must reduce the standalone
    // music layer, so the ducked mix RMS must be lower than the normal mix.
    assert.ok(duckedRms < normalRms * 0.995, `ducked RMS ${duckedRms.toFixed(4)} !< normal ${normalRms.toFixed(4)}`);
    return `normal ${normalRms.toFixed(4)} -> ducked ${duckedRms.toFixed(4)}`;
  });

  await checkAsync('interchange export writes XMEML and EDL', async () => {
    const xmeml = path.join(tempRoot, 'timeline.xml');
    const edl = path.join(tempRoot, 'timeline.edl');
    const a = await invoke('export_xmeml', { path: xmeml });
    assert.equal(a.status, 200, a.text);
    assert.ok(fs.readFileSync(xmeml, 'utf8').includes('<xmeml'));
    const b = await invoke('export_edl', { path: edl });
    assert.equal(b.status, 200, b.text);
    assert.ok(fs.statSync(edl).size > 0);
    return 'xmeml + edl';
  });

  await checkAsync('Host real SigLIP2 search: status/index/query/image query', async () => {
    const model = await invoke('search_model_status');
    assert.equal(model.status, 200, model.text);
    assert.equal(model.json.visualAvailable, true, `model not available in Host: ${model.text}`);
    assert.equal(model.json.installed, true);
    assert.equal(model.json.backend, 'ort-native');
    const indexStatus = await invoke('search_index_status');
    assert.equal(indexStatus.status, 200, indexStatus.text);
    assert.equal(indexStatus.json.visualAvailable, true);
    const indexed = await invoke('search_index_start');
    assert.equal(indexed.status, 200, indexed.text);
    assert.equal(indexed.json.visualAvailable, true);
    assert.ok(indexed.json.indexed > 0, `no visual assets indexed: ${indexed.text}`);
    const text = await invoke('search_query', { query: 'clip' });
    assert.equal(text.status, 200, text.text);
    assert.equal(text.json.visualAvailable, true);
    assert.ok(Array.isArray(text.json.moments), 'Host search returned no moments array');
    // Image query: use the imported still and require a same-media self-match.
    const image = await invoke('search_query_image', { imageBase64: fs.readFileSync(imageFile).toString('base64') });
    assert.equal(image.status, 200, image.text);
    assert.equal(image.json.visualAvailable, true);
    const topImageMedia = image.json.moments?.[0]?.mediaId;
    assert.equal(topImageMedia, importedIds.image, `image self-match was ${topImageMedia}, expected ${importedIds.image}`);
    return `model=${model.json.backend}; indexed=${indexed.json.indexed}; text moments=${text.json.moments.length}; image top=${topImageMedia}`;
  });

  const asrUrl = await startMockServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/asr') {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'hello route b', language: 'en', segments: [{ text: 'hello route b', start: 0, end: 0.5 }], words: [] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await checkAsync('ASR mock transcribes and addCaptions creates caption clips', async () => {
    assert.equal((await request('POST', `${PREFIX}/engine/asr/config`, { body: JSON.stringify({ url: `${asrUrl}/asr`, model: 'mock-whisper' }) })).status, 200);
    const transcript = await invoke('transcribe_media', { mediaId: importedIds.video, language: 'en' });
    assert.equal(transcript.status, 200, transcript.text);
    assert.equal(transcript.json.text, 'hello route b');
    const captions = await invoke('generate_captions', { request: { language: 'en' } });
    assert.equal(captions.status, 200, captions.text);
    assert.ok(captions.json.captionCount >= 1, JSON.stringify(captions.json));
    const timeline = await jsonRequest('GET', `${PREFIX}/engine/timeline`);
    const captionClip = timeline.json.timeline.tracks.flatMap((track) => track.clips).find((clip) => typeof clip.textContent === 'string' && /hello route b/i.test(clip.textContent));
    assert.ok(captionClip, 'caption clip missing from timeline');
    return `${captions.json.captionCount} cue(s)`;
  });

  await checkAsync('export_subtitles writes SRT cues from the caption clips', async () => {
    const srt = path.join(tempRoot, 'captions.srt');
    const response = await invoke('export_subtitles', { path: srt, format: 'srt' });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.json.cueCount >= 1, JSON.stringify(response.json));
    assert.match(fs.readFileSync(srt, 'utf8'), /hello route b/i);
    return `${response.json.cueCount} cue(s)`;
  });

  // -------------------------------------------------------------------------
  // Provider generation (local mocks)
  // -------------------------------------------------------------------------
  const providerFiles = {
    image: PNG_1X1,
    speech: fs.readFileSync(audioFile),
    video: fs.readFileSync(videoFile),
  };
  const providerUrl = await startMockServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/image') {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: providerFiles.image.toString('base64') }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/speech') {
      await readBody(req);
      res.setHeader('content-type', 'audio/mpeg');
      res.end(providerFiles.speech);
      return;
    }
    if (req.method === 'POST' && req.url === '/video') {
      await readBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ video_url: `${providerUrl}/video-file` }));
      return;
    }
    if (req.method === 'GET' && req.url === '/video-file') {
      res.setHeader('content-type', 'video/mp4');
      res.end(providerFiles.video);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await checkAsync('image/speech/video generation tools import provider output (mocks)', async () => {
    await request('POST', `${PREFIX}/engine/generation/config`, { body: JSON.stringify({ url: `${providerUrl}/image`, model: 'mock-image' }) });
    await request('POST', `${PREFIX}/engine/speech/config`, { body: JSON.stringify({ url: `${providerUrl}/speech`, model: 'mock-tts' }) });
    await request('POST', `${PREFIX}/engine/video/config`, { body: JSON.stringify({ url: `${providerUrl}/video`, model: 'mock-video' }) });
    const before = JSON.parse((await jsonRequest('GET', `${PREFIX}/engine/media`)).json.items.length);
    const image = await tool('opentake_route_b_generate_image', { prompt: 'a red square', size: '256x256' });
    assert.ok(image.data.path && fs.existsSync(image.data.path));
    const speech = await tool('opentake_route_b_generate_speech', { text: 'hello' });
    assert.ok(speech.data.path && fs.existsSync(speech.data.path));
    const video = await tool('opentake_route_b_generate_video', { prompt: 'a short clip' });
    assert.ok(video.data.path && fs.existsSync(video.data.path));
    const after = (await jsonRequest('GET', `${PREFIX}/engine/media`)).json.items;
    assert.ok(after.length >= before + 3, `${before} -> ${after.length}`);
    const kinds = new Set(after.map((item) => item.type));
    for (const kind of ['image', 'audio', 'video']) assert.ok(kinds.has(kind), `missing kind ${kind}`);
    return `${before} -> ${after.length} media items`;
  });

  // -------------------------------------------------------------------------
  // Motion Studio preview through local Chrome
  // -------------------------------------------------------------------------
  await checkAsync('Motion Studio create + Chrome preview renders a PNG', async () => {
    const capability = await invoke('motion_capability');
    assert.equal(capability.status, 200);
    if (capability.json !== true) {
      return 'SKIP: Chrome/Chromium not available';
    }
    const created = await invoke('motion_document_create', { request: { title: 'Verify Motion' } });
    assert.equal(created.status, 200, created.text);
    const document = created.json;
    assert.ok(document.summary.id);
    const preview = await invoke('motion_preview', {
      request: {
        documentId: document.summary.id,
        revisionHash: document.summary.revisionHash,
        frame: 0,
        width: 320,
        height: 180,
        fps: 30,
        durationFrames: 30,
      },
    });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.json.pngDataUrl, /^data:image\/png;base64,/);
    const png = Buffer.from(preview.json.pngDataUrl.split(',')[1], 'base64');
    assert.equal(png[0], 0x89);
    return `${png.length} bytes @320x180`;
  });

  await checkAsync('Motion template preview + publish through the integrated Host bridge', async () => {
    const preview = await invoke('motion_preview', {
      request: { templateId: 'title-card', params: { title: 'Verify template', subtitle: 'Route B' }, frame: 0, width: 320, height: 180, fps: 30, durationFrames: 30 },
    });
    assert.equal(preview.status, 200, preview.text);
    assert.match(preview.json.pngDataUrl, /^data:image\/png;base64,/);
    assert.equal(preview.json.source?.kind, 'template');
    assert.match(preview.json.revisionHash, /^[0-9a-f]{64}$/);
    const publish = await invoke('motion_add', {
      request: { templateId: 'title-card', params: { title: 'Verify publish' }, width: 160, height: 90, fps: 30, durationFrames: 3, startFrame: 0, trackIndex: 0 },
    });
    assert.equal(publish.status, 200, publish.text);
    assert.equal(typeof publish.json.clipId, 'string');
    assert.equal(publish.json.source?.templateId, 'title-card');
    assert.equal(publish.json.output?.renderer, 'route-b-chrome-headless');
    assert.ok(fs.existsSync(publish.json.output.outputFile), publish.json.output.outputFile);
    const timeline = await jsonRequest('GET', `${PREFIX}/engine/timeline`);
    const motionClip = timeline.json.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === publish.json.clipId);
    assert.ok(motionClip, 'published template clip missing from timeline');
    return `clip ${publish.json.clipId} (${publish.json.output.durationFrames} frames)`;
  });

  // -------------------------------------------------------------------------
  // Project save/reopen, static web app, storage
  // -------------------------------------------------------------------------
  await checkAsync('project_save persists and reopens the edited timeline', async () => {
    const saved = await invoke('project_save', { path: bundle });
    assert.equal(saved.status, 200, saved.text);
    // Tauri-compatible `project_save` returns the bare path string (the Host
    // /engine/save route wraps it as { path }); accept the documented shape.
    assert.equal(saved.json, bundle);
    const reopened = await invoke('project_open', { path: bundle });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.json.projectPath, bundle);
    const fps = reopened.json.timeline.fps;
    assert.ok(Number.isFinite(fps));
    return saved.json.path;
  });

  await checkAsync('static /app/ route serves the built React shell and assets', async () => {
    const index = await request('GET', `${PREFIX}/app/`);
    assert.equal(index.status, 200, index.text.slice(0, 120));
    assert.match(index.text, /<div id="root">/);
    const assetMatch = index.text.match(/\/app\/assets\/[A-Za-z0-9._-]+\.js/);
    assert.ok(assetMatch, 'no JS asset referenced by index.html');
    const asset = await request('GET', `${PREFIX}${assetMatch[0].replace('/app', '/app')}`);
    assert.equal(asset.status, 200);
    assert.ok(asset.bytes.length > 1000);
    return assetMatch[0];
  });

  await checkAsync('storage_usage reports cache categories', async () => {
    const response = await invoke('storage_usage');
    assert.equal(response.status, 200, response.text);
    assert.ok(Array.isArray(response.json.categories));
    assert.ok(typeof response.json.totalBytes === 'number');
    return `${response.json.totalBytes} bytes`;
  });

  await checkAsync('Host production HDR10 export: true PQ output + SDR request rejected', async () => {
    const hdrSource = process.env.OPENTAKE_HDR_SOURCE ?? '/tmp/route-b-hdr10/hdr10_true.mp4';
    const sdrSource = process.env.OPENTAKE_SDR_SOURCE ?? '/tmp/route-b-hdr10/hdr10_sdr_fallback.mp4';
    if (!fs.existsSync(hdrSource) || !fs.existsSync(sdrSource)) return 'SKIP (HDR fixtures missing)';
    const makeProject = async (name, source) => {
      const dir = path.join(tempRoot, name);
      assert.equal((await invoke('project_new', { path: dir })).status, 200);
      const imported = await jsonRequest('POST', `${PREFIX}/engine/import-media`, { body: JSON.stringify({ paths: [source] }) });
      assert.equal(imported.status, 200, imported.text);
      const item = imported.json.items.find((entry) => entry.path === source) ?? imported.json.items[0];
      assert.ok(item, `import failed for ${source}`);
      const inserted = await invoke('edit_apply', { command: { type: 'insertTrack', kind: 'video', at: null } });
      assert.equal(inserted.status, 200, inserted.text);
      const snapshot = await jsonRequest('GET', `${PREFIX}/engine/timeline`);
      const trackIndex = snapshot.json.timeline.tracks.findIndex((track) => track.type === 'video');
      const placed = await invoke('edit_apply', {
        command: { type: 'addClips', entries: [{
          mediaRef: item.id, mediaType: 'video', sourceClipType: 'video', trackIndex,
          startFrame: 0, durationFrames: 10, trimStartFrame: 0, trimEndFrame: 0,
          hasAudio: false, addLinkedAudio: false,
        }] },
      });
      assert.equal(placed.status, 200, placed.text);
      return { dir, item };
    };
    const hdr = await makeProject('hdr-project', hdrSource);
    const out = path.join(tempRoot, 'hdr-host-export.mp4');
    const exported = await invoke('export_video', { operationId: 'verify-hdr-host', req: { outPath: out, codec: 'h265', quality: '720p', hdr10: true } });
    assert.equal(exported.status, 200, exported.text);
    const probe = ffprobe(out);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'hevc');
    assert.equal(video.profile, 'Main 10');
    assert.equal(video.pix_fmt, 'yuv420p10le');
    assert.equal(video.color_primaries, 'bt2020');
    assert.equal(video.color_transfer, 'smpte2084');
    assert.equal(video.color_space, 'bt2020nc');
    const sdr = await makeProject('sdr-hdr-request', sdrSource);
    const rejected = await invoke('export_video', { operationId: 'verify-hdr-sdr-negative', req: { outPath: path.join(tempRoot, 'sdr-requested-hdr10.mp4'), codec: 'h265', quality: '720p', hdr10: true } });
    assert.equal(rejected.status, 400, `SDR source HDR request was not rejected: ${rejected.text}`);
    assert.match(rejected.text, /requires HDR sources/);
    return `HDR ${video.profile}/${video.pix_fmt} ${video.color_primaries}/${video.color_transfer}; SDR rejected`;
  });

  noteEnd: {
    if (info !== null) {
      checks.push({ name: 'runtime', status: 'NOTE', detail: `plugin ${info.pluginVersion} ${info.platform}/${info.arch} node ${info.node} napi ${info.napi}` });
      if (!jsonOnly) console.log(`NOTE  runtime — plugin ${info.pluginVersion} ${info.platform}/${info.arch} node ${info.node} napi ${info.napi}`);
    }
  }
} catch (error) {
  checks.push({ name: 'host-api harness', status: 'FAIL', detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  if (!jsonOnly) console.log(`FAIL  host-api harness — ${error instanceof Error ? error.message : error}`);
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
  for (const server of mockServers) { await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const failed = checks.filter((entry) => entry.status === 'FAIL');
const warnings = checks.filter((entry) => entry.status === 'WARN');
const summary = {
  plugin: pluginDir,
  runtime: { node: process.versions.node, napi: process.versions.napi, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch },
  passed: checks.filter((entry) => entry.status === 'PASS').length,
  warnings: warnings.length,
  failed: failed.length,
  checks,
};
if (jsonOnly) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n${summary.passed} passed, ${summary.warnings} warning(s), ${summary.failed} failed (${checks.length} checks)`);
}
process.exit(failed.length > 0 ? 1 : 0);
