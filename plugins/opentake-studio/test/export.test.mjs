import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';

import {
  EXPORT_CODECS,
  ExportError,
  buildExportArgs,
  defaultContainerForCodec,
  defaultExtensionForCodec,
  runExport,
} from '../lib/export.js';
import {
  importToProject,
  probeMedia,
  resetToolCache,
  resolveTools,
  runFfmpeg,
  runFfprobe,
} from '../lib/media.js';

const initialTools = resolveTools();
const toolSkip = initialTools.available ? false : 'ffmpeg/ffprobe are not available on this machine';
const FIXTURE_ROOT = path.join(os.tmpdir(), 'ots-export-fixture');
const FIXTURE_OUTPUT = path.join(FIXTURE_ROOT, 'out.mp4');

const CLIP_DEFAULTS = {
  speed: 1,
  volume: 1,
  opacity: 1,
  trimStartFrame: 0,
  transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  text: null,
};

const IDENTITY_CUBE = [
  'TITLE "identity"',
  'LUT_3D_SIZE 2',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '1 1 0',
  '0 0 1',
  '1 0 1',
  '0 1 1',
  '1 1 1',
].join('\n');

// ---------------------------------------------------------------------------
// Phase 1 fixtures (speed/fades/keyframes/effects/captions/transitions)
// ---------------------------------------------------------------------------

let phaseRoot = null;
let phaseRealProject = null;
let redMedia = null;
let blueMedia = null;
let greenMedia = null;
let splitMedia = null;
let audioMedia = null;
let voiceMedia = null;
let musicMedia = null;
let phase2Project = null;

function mediaEntry(overrides = {}) {
  return {
    id: 'media-video',
    name: 'clip.mp4',
    kind: 'video',
    fileName: 'video.mp4',
    durationFrames: 120,
    sourceDurationSeconds: 4,
    width: 320,
    height: 180,
    hasAudio: true,
    sizeBytes: 1000,
    importedAt: 1,
    ...overrides,
  };
}

function makeClip(overrides = {}) {
  const { transform, ...rest } = overrides;
  return {
    ...CLIP_DEFAULTS,
    ...rest,
    transform: { ...CLIP_DEFAULTS.transform, ...(transform ?? {}) },
  };
}

function makeProject({
  media = [mediaEntry()],
  clips = [],
  transitions = [],
  extraTracks = [],
  width = 320,
  height = 180,
  fps = 30,
} = {}) {
  return {
    version: 1,
    name: 'phase',
    fps,
    width,
    height,
    createdAt: 0,
    updatedAt: 0,
    media,
    tracks: [
      { id: 'track-video', type: 'video', name: 'Video 1', muted: false, hidden: false, clips },
      ...extraTracks,
    ],
    transitions,
  };
}

function buildPhase(project, outputPath = path.join(phaseRoot, 'out.mp4')) {
  return buildExportArgs({ project, projectRoot: phaseRoot, outputPath });
}

function trueTransitionProject(type = 'dissolve', { trimStartFrame = 20 } = {}) {
  const media = [
    mediaEntry({ durationFrames: 300 }),
    mediaEntry({ id: 'media-video-b', name: 'b.mp4', fileName: 'b.mp4', durationFrames: 300 }),
  ];
  const clips = [
    makeClip({
      id: 'tt-a', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 45,
    }),
    makeClip({
      id: 'tt-b', type: 'video', mediaId: 'media-video-b', startFrame: 45, durationFrames: 45,
      trimStartFrame,
    }),
  ];
  return makeProject({
    media,
    clips,
    transitions: [{
      id: 'tt', trackId: 'track-video', fromClipId: 'tt-a', toClipId: 'tt-b',
      type, durationFrames: 20,
    }],
  });
}

function createFixtureProject() {
  return {
    version: 1,
    name: 'fixture',
    fps: 30,
    width: 640,
    height: 360,
    createdAt: 1,
    updatedAt: 1,
    media: [
      {
        id: 'media-video', name: 'clip.mp4', kind: 'video', fileName: 'video.mp4',
        durationFrames: 60, sourceDurationSeconds: 2, width: 320, height: 180,
        hasAudio: true, sizeBytes: 1000, importedAt: 1,
      },
      {
        id: 'media-image', name: 'card.png', kind: 'image', fileName: 'image.png',
        durationFrames: null, sourceDurationSeconds: null, width: 320, height: 180,
        hasAudio: false, sizeBytes: 500, importedAt: 1,
      },
      {
        id: 'media-audio', name: 'music.m4a', kind: 'audio', fileName: 'music.m4a',
        durationFrames: 120, sourceDurationSeconds: 4, width: null, height: null,
        hasAudio: true, sizeBytes: 800, importedAt: 1,
      },
    ],
    tracks: [
      {
        id: 'track-video', type: 'video', name: 'Video 1', muted: false, hidden: false,
        clips: [
          {
            ...CLIP_DEFAULTS,
            id: 'clip-video', type: 'video', mediaId: 'media-video',
            startFrame: 0, durationFrames: 45, volume: 0.8,
          },
          {
            ...CLIP_DEFAULTS,
            id: 'clip-image', type: 'image', mediaId: 'media-image',
            startFrame: 45, durationFrames: 45, opacity: 0.5,
            transform: { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0 },
          },
          {
            ...CLIP_DEFAULTS,
            id: 'clip-text', type: 'text', mediaId: null,
            startFrame: 15, durationFrames: 30,
            transform: { x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 0 },
            text: {
              content: "Take 1: it's 100%",
              fontSize: 36,
              color: '#ffffff',
              fontWeight: '600',
              align: 'center',
            },
          },
        ],
      },
      {
        id: 'track-audio', type: 'audio', name: 'Audio 1', muted: false, hidden: false,
        clips: [
          {
            ...CLIP_DEFAULTS,
            id: 'clip-audio', type: 'audio', mediaId: 'media-audio',
            startFrame: 30, durationFrames: 60, trimStartFrame: 15, volume: 0.5,
          },
        ],
      },
    ],
  };
}

function build(project, outputPath = FIXTURE_OUTPUT) {
  return buildExportArgs({ project, projectRoot: FIXTURE_ROOT, outputPath });
}

function filterOf(built) {
  const index = built.args.indexOf('-filter_complex');
  assert.ok(index >= 0, 'args contain -filter_complex');
  return built.args[index + 1];
}

function inputsOf(args) {
  const inputs = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-i') inputs.push(args[index + 1]);
  }
  return inputs;
}

function hasPair(args, flag, value) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag && args[index + 1] === value) return true;
  }
  return false;
}

async function ffmpegSupportsDrawtext() {
  if (!initialTools.available || initialTools.ffmpeg === null) return false;
  return new Promise((resolve) => {
    const child = spawn(initialTools.ffmpeg, ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) stdout = stdout.slice(-8_000_000);
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && /(^|\s)drawtext(\s|$)/.test(stdout)));
  });
}

const drawtextAvailable = initialTools.available ? await ffmpegSupportsDrawtext() : false;

async function ffmpegEncoderNames() {
  if (!initialTools.available || initialTools.ffmpeg === null) return new Set();
  return new Promise((resolve) => {
    const child = spawn(initialTools.ffmpeg, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.on('error', () => resolve(new Set()));
    child.on('close', (code) => {
      const names = new Set();
      if (code === 0) {
        for (const line of stdout.split('\n')) {
          const match = /^\s*([VA])[A-Za-z.]*\s+(\S+)/.exec(line);
          if (match !== null) names.add(match[2]);
        }
      }
      resolve(names);
    });
  });
}

const encoderNames = initialTools.available ? await ffmpegEncoderNames() : new Set();
const hasH265Encoder = encoderNames.has('libx265') || encoderNames.has('hevc_videotoolbox');
const hasProresEncoder = encoderNames.has('prores_ks');
const hasVp9Encoder = encoderNames.has('libvpx-vp9');
const hasOpusEncoder = encoderNames.has('libopus');

function meanVolumeDb(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(initialTools.ffmpeg, [
      '-hide_banner', '-nostats', '-i', filePath,
      '-af', 'volumedetect', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
      if (code === 0 && match !== null) resolve(Number(match[1]));
      else reject(new Error(`volumedetect failed (${code}): ${stderr.slice(-400)}`));
    });
  });
}

function samplePixel(filePath, seconds, x, y) {
  return new Promise((resolve, reject) => {
    const child = spawn(initialTools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `crop=8:8:${x}:${y},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`samplePixel failed (${code}): ${stderr}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      resolve({ r: buffer[0] ?? 0, g: buffer[1] ?? 0, b: buffer[2] ?? 0 });
    });
  });
}

let exportTemp = null;
let exportProjectRoot = null;
let realProject = null;

before(async () => {
  if (!initialTools.available) return;
  exportTemp = await mkdtemp(path.join(os.tmpdir(), 'ots-export-test-'));
  const sourceDir = path.join(exportTemp, 'source');
  await mkdir(sourceDir, { recursive: true });

  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    path.join(sourceDir, 'clip.mp4'),
  ]);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    path.join(sourceDir, 'sound.m4a'),
  ]);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1',
    '-frames:v', '1',
    path.join(sourceDir, 'card.png'),
  ]);

  // Phase 2 fixtures: solid red/blue clips for the true-dissolve pixel test
  // and a solid green poster for the rotation overlay.
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(sourceDir, 'red.mp4'),
  ]);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(sourceDir, 'blue.mp4'),
  ]);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1',
    '-frames:v', '1',
    path.join(sourceDir, 'greenposter.png'),
  ]);
  // Left red / right blue poster for the crop pixel test.
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1',
    '-vf', 'drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill',
    '-frames:v', '1',
    path.join(sourceDir, 'split.png'),
  ]);

  // Distinct voice/music tones for the ducking export test.
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    path.join(sourceDir, 'voice.m4a'),
  ]);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    path.join(sourceDir, 'music.m4a'),
  ]);

  exportProjectRoot = path.join(exportTemp, 'project');
  await mkdir(exportProjectRoot, { recursive: true });
  const imported = await importToProject({
    projectRoot: exportProjectRoot,
    folderPath: sourceDir,
    project: { fps: 30, media: [] },
  });
  const byName = new Map(imported.media.map((entry) => [entry.name, entry]));

  realProject = {
    version: 1,
    name: 'real-export',
    fps: 30,
    width: 320,
    height: 180,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    media: imported.media,
    tracks: [
      {
        id: 'real-video', type: 'video', name: 'Video 1', muted: false, hidden: false,
        clips: [
          {
            ...CLIP_DEFAULTS,
            id: 'real-clip-video', type: 'video', mediaId: byName.get('clip.mp4').id,
            startFrame: 0, durationFrames: 30, volume: 0.9,
          },
          {
            ...CLIP_DEFAULTS,
            id: 'real-clip-image', type: 'image', mediaId: byName.get('card.png').id,
            startFrame: 30, durationFrames: 15, opacity: 0.6,
            transform: { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0 },
          },
        ],
      },
      {
        id: 'real-audio', type: 'audio', name: 'Audio 1', muted: false, hidden: false,
        clips: [
          {
            ...CLIP_DEFAULTS,
            id: 'real-clip-audio', type: 'audio', mediaId: byName.get('sound.m4a').id,
            startFrame: 0, durationFrames: 45, volume: 0.4,
          },
        ],
      },
    ],
  };

  // Phase 1 real fixture: speed 2 (2s source -> 1s timeline), fades and a
  // representative effect stack including chroma key and a 3D LUT.
  const phaseVideoMedia = byName.get('clip.mp4');
  await mkdir(path.join(exportProjectRoot, 'luts'), { recursive: true });
  await writeFile(path.join(exportProjectRoot, 'luts', 'film.cube'), IDENTITY_CUBE);
  phaseRealProject = {
    version: 1,
    name: 'phase-real',
    fps: 30,
    width: 320,
    height: 180,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    media: imported.media,
    tracks: [
      {
        id: 'phase-video', type: 'video', name: 'Video 1', muted: false, hidden: false,
        clips: [
          makeClip({
            id: 'phase-real-clip',
            type: 'video',
            mediaId: phaseVideoMedia.id,
            startFrame: 0,
            durationFrames: 30,
            speed: 2,
            fadeInFrames: 5,
            fadeOutFrames: 5,
            effects: [
              { id: 'fx-brightness', type: 'brightness', enabled: true, params: { amount: 1.3 } },
              { id: 'fx-blur', type: 'blur', enabled: true, params: { radius: 1 } },
              {
                id: 'fx-chroma', type: 'chromaKey', enabled: true,
                params: { keyColor: '#00ff00', similarity: 0.2, blend: 0.1 },
              },
              { id: 'fx-lut', type: 'lut', enabled: true, params: { file: 'film.cube' } },
            ],
          }),
        ],
      },
    ],
    transitions: [],
  };

  redMedia = byName.get('red.mp4');
  blueMedia = byName.get('blue.mp4');
  greenMedia = byName.get('greenposter.png');
  splitMedia = byName.get('split.png');
  audioMedia = byName.get('sound.m4a');
  voiceMedia = byName.get('voice.m4a');
  musicMedia = byName.get('music.m4a');

  // True dissolve between red (0..30 frames, 1s) and blue (trimStart 10,
  // 30..60) with 10 transition frames (5 per side), plus a 45-degree rotated
  // green poster on a second track from 60..75.
  phase2Project = {
    version: 1,
    name: 'phase2',
    fps: 30,
    width: 320,
    height: 180,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    media: imported.media,
    tracks: [
      {
        id: 'phase2-video', type: 'video', name: 'Video 1', muted: false, hidden: false,
        clips: [
          makeClip({
            id: 'phase2-a', type: 'video', mediaId: redMedia.id,
            startFrame: 0, durationFrames: 30, trimStartFrame: 0,
          }),
          makeClip({
            id: 'phase2-b', type: 'video', mediaId: blueMedia.id,
            startFrame: 30, durationFrames: 30, trimStartFrame: 10,
          }),
        ],
      },
      {
        id: 'phase2-overlay', type: 'video', name: 'Overlay', muted: false, hidden: false,
        clips: [
          makeClip({
            id: 'phase2-rotated', type: 'image', mediaId: greenMedia.id,
            startFrame: 60, durationFrames: 15,
            transform: { x: 0, y: 0, width: 1, height: 1, rotation: 45 },
          }),
        ],
      },
    ],
    transitions: [
      {
        id: 'phase2-transition', trackId: 'phase2-video',
        fromClipId: 'phase2-a', toClipId: 'phase2-b',
        type: 'dissolve', durationFrames: 10,
      },
    ],
  };
});

before(async () => {
  phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'ots-export-phase-'));
  await mkdir(path.join(phaseRoot, 'luts'), { recursive: true });
  await mkdir(path.join(phaseRoot, 'renders'), { recursive: true });
  await writeFile(path.join(phaseRoot, 'luts', 'film.cube'), IDENTITY_CUBE);
});

after(async () => {
  if (exportTemp !== null) await rm(exportTemp, { recursive: true, force: true });
});

after(async () => {
  if (phaseRoot !== null) await rm(phaseRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure argument building
// ---------------------------------------------------------------------------

it('builds a complete argv for video + image + text + audio', () => {
  const project = createFixtureProject();
  const built = build(project);

  assert.equal(built.durationFrames, 90);
  assert.ok(Array.isArray(built.args));
  assert.ok(built.args.every((argument) => typeof argument === 'string'));
  assert.equal(built.args.at(-1), FIXTURE_OUTPUT);

  const inputs = inputsOf(built.args);
  assert.equal(inputs.length, 4, 'base + video clip + image clip + audio clip');
  assert.match(inputs[0], /^color=c=black:s=640x360:r=30:d=3$/);
  assert.equal(inputs[1], path.join(FIXTURE_ROOT, 'media', 'video.mp4'));
  assert.equal(inputs[2], path.join(FIXTURE_ROOT, 'media', 'image.png'));
  assert.equal(inputs[3], path.join(FIXTURE_ROOT, 'media', 'music.m4a'));

  const filter = filterOf(built);

  // Video clip overlay.
  assert.match(filter, /\[1:v\]scale=640:360,setsar=1,fps=30,setpts=PTS-STARTPTS\+0\/TB\[v0\]/);
  assert.match(filter, /\[0:v\]\[v0\]overlay=x=0:y=0:enable='between\(t,0,1\.5\)'/);

  // Image clip overlay with half opacity and a half-size box.
  assert.match(filter, /\[2:v\]scale=320:180,setsar=1,fps=30,format=rgba,colorchannelmixer=aa=0\.5/);
  assert.match(filter, /overlay=x=320:y=180:enable='between\(t,1\.5,3\)'/);

  // Text clip uses drawtext with the auto-detected font and centered alignment.
  assert.match(filter, /drawtext=/);
  assert.match(filter, /fontsize=36/);
  assert.match(filter, /fontcolor='#ffffff'/);
  assert.match(filter, /expansion=none/);
  assert.match(filter, /x=64\+\(512-text_w\)\/2/);
  assert.match(filter, /y=36/);
  assert.match(filter, /between\(t,0\.5,1\.5\)/);

  // The video clip's own audio is mixed from its already-added input (index 1).
  assert.match(filter, /\[1:a\]atrim=duration=1\.5,asetpts=PTS-STARTPTS,volume=0\.8,adelay=0:all=1\[a0\]/);
  // The audio clip gets its own input (index 3) and a delayed start.
  assert.match(filter, /\[3:a\]atrim=duration=2,asetpts=PTS-STARTPTS,volume=0\.5,adelay=1000:all=1\[a1\]/);
  assert.match(filter, /\[a0\]\[a1\]amix=inputs=2:normalize=0:duration=longest,aresample=48000\[aout\]/);
  assert.match(filter, /null\[vout\]/);

  // Encoding / mapping / progress options.
  assert.ok(hasPair(built.args, '-map', '[vout]'));
  assert.ok(hasPair(built.args, '-map', '[aout]'));
  assert.ok(hasPair(built.args, '-c:v', 'libx264'));
  assert.ok(hasPair(built.args, '-pix_fmt', 'yuv420p'));
  assert.ok(hasPair(built.args, '-preset', 'veryfast'));
  assert.ok(hasPair(built.args, '-crf', '20'));
  assert.ok(hasPair(built.args, '-movflags', '+faststart'));
  assert.ok(hasPair(built.args, '-c:a', 'aac'));
  assert.ok(hasPair(built.args, '-b:a', '192k'));
  assert.ok(hasPair(built.args, '-t', '3'));
  assert.ok(hasPair(built.args, '-progress', 'pipe:1'));
  assert.ok(built.args.includes('-nostats'));
});

it('escapes drawtext text for both ffmpeg escaping layers', () => {
  const project = createFixtureProject();
  const textClip = project.tracks[0].clips[2];
  textClip.text.content = "a:b it's 100%";

  const filter = filterOf(build(project));
  // Option layer escapes ':' and quotes; the filtergraph layer escapes the
  // backslashes produced by the option layer.
  assert.ok(
    filter.includes(String.raw`text='a\\:b it\\\'s 100%'`),
    `filter should contain the escaped text token:\n${filter}`,
  );
  assert.ok(!filter.includes("text='a:b"), 'raw colon must not reach the filtergraph');
});

it('mixes audio from video clips that have hasAudio=true', () => {
  const project = createFixtureProject();
  project.tracks = [
    {
      id: 'only-video', type: 'video', name: 'Video', muted: false, hidden: false,
      clips: [
        {
          ...CLIP_DEFAULTS,
          id: 'only-video-clip', type: 'video', mediaId: 'media-video',
          startFrame: 0, durationFrames: 45, volume: 0.7,
        },
      ],
    },
  ];

  const built = build(project);
  const filter = filterOf(built);
  const inputs = inputsOf(built.args);
  assert.equal(inputs.length, 2, 'base + one video input (reused for audio)');
  assert.match(filter, /\[1:a\]atrim=duration=1\.5,asetpts=PTS-STARTPTS,volume=0\.7,adelay=0:all=1/);
  assert.match(filter, /amix=inputs=1:normalize=0/);
  assert.ok(hasPair(built.args, '-map', '[aout]'));
  assert.ok(!built.args.includes('-an'));

  // Same project with a silent source must not invent an audio stream.
  const silent = createFixtureProject();
  silent.media[0].hasAudio = false;
  silent.tracks = [
    {
      id: 'only-video', type: 'video', name: 'Video', muted: false, hidden: false,
      clips: [
        {
          ...CLIP_DEFAULTS,
          id: 'only-video-clip', type: 'video', mediaId: 'media-video',
          startFrame: 0, durationFrames: 45,
        },
      ],
    },
  ];
  const silentBuilt = build(silent);
  assert.ok(!filterOf(silentBuilt).includes('[1:a]'));
  assert.ok(silentBuilt.args.includes('-an'));
});

it('honors hidden video tracks and muted audio tracks independently', () => {
  // Hidden + muted: no visual and no audio from the video track, and the
  // audio track is muted too, so only the black base remains.
  const both = createFixtureProject();
  both.tracks[0].hidden = true;
  both.tracks[0].muted = true;
  both.tracks[1].muted = true;
  const bothBuilt = build(both);
  const bothFilter = filterOf(bothBuilt);
  assert.equal(inputsOf(bothBuilt.args).length, 1);
  assert.ok(!bothFilter.includes('overlay='));
  assert.ok(!bothFilter.includes('drawtext='));
  assert.ok(!bothFilter.includes('amix'));
  assert.match(bothFilter, /\[0:v\]null\[vout\]/);
  assert.ok(bothBuilt.args.includes('-an'));

  // Hidden but not muted: visuals are gone, yet the video clip's audio remains.
  const hiddenOnly = createFixtureProject();
  hiddenOnly.tracks[0].hidden = true;
  hiddenOnly.tracks[1].muted = true;
  const hiddenBuilt = build(hiddenOnly);
  const hiddenFilter = filterOf(hiddenBuilt);
  assert.ok(!hiddenFilter.includes('overlay='));
  assert.ok(!hiddenFilter.includes('drawtext='));
  assert.match(hiddenFilter, /\[1:a\]/);
  assert.match(hiddenFilter, /amix=inputs=1:normalize=0/);
  assert.ok(hasPair(hiddenBuilt.args, '-map', '[aout]'));

  // Muted video track: visuals remain; its audio is dropped, but the separate
  // audio track is still mixed.
  const mutedOnly = createFixtureProject();
  mutedOnly.tracks[0].muted = true;
  const mutedBuilt = build(mutedOnly);
  const mutedFilter = filterOf(mutedBuilt);
  assert.ok(mutedFilter.includes('overlay='));
  assert.ok(mutedFilter.includes('drawtext='));
  assert.ok(!mutedFilter.includes('[1:a]'), 'muted video-track audio must be dropped');
  assert.match(mutedFilter, /\[3:a\]/);
  assert.match(mutedFilter, /amix=inputs=1:normalize=0/);
});

it('reports invalid build inputs and an empty timeline', async () => {
  assert.throws(
    () => buildExportArgs({ project: null, projectRoot: FIXTURE_ROOT, outputPath: FIXTURE_OUTPUT }),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );
  assert.throws(
    () => buildExportArgs({ project: createFixtureProject(), projectRoot: '', outputPath: FIXTURE_OUTPUT }),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );
  assert.throws(
    () => buildExportArgs({ project: createFixtureProject(), projectRoot: FIXTURE_ROOT, outputPath: '' }),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );

  const empty = createFixtureProject();
  empty.tracks = [];
  const built = build(empty);
  assert.equal(built.durationFrames, 0);
  await assert.rejects(
    runExport({ project: empty, projectRoot: FIXTURE_ROOT, outputPath: FIXTURE_OUTPUT }),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );
});

it('rejects clearly when ffmpeg is unavailable', async () => {
  const saved = {
    path: process.env.PATH,
    ffmpeg: process.env.OPENTAKE_STUDIO_FFMPEG,
    ffprobe: process.env.OPENTAKE_STUDIO_FFPROBE,
  };
  try {
    process.env.PATH = '';
    process.env.OPENTAKE_STUDIO_FFMPEG = '/definitely/not/a/real/ffmpeg';
    process.env.OPENTAKE_STUDIO_FFPROBE = '/definitely/not/a/real/ffprobe';
    resetToolCache();

    await assert.rejects(
      runExport({
        project: createFixtureProject(),
        projectRoot: FIXTURE_ROOT,
        outputPath: FIXTURE_OUTPUT,
      }),
      (error) => error instanceof ExportError && error.code === 'ffmpeg-unavailable',
    );
  } finally {
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.ffmpeg === undefined) delete process.env.OPENTAKE_STUDIO_FFMPEG;
    else process.env.OPENTAKE_STUDIO_FFMPEG = saved.ffmpeg;
    if (saved.ffprobe === undefined) delete process.env.OPENTAKE_STUDIO_FFPROBE;
    else process.env.OPENTAKE_STUDIO_FFPROBE = saved.ffprobe;
    resetToolCache();
  }
});

// ---------------------------------------------------------------------------
// Real ffmpeg execution
// ---------------------------------------------------------------------------

it('exports a real MP4 with video, audio and progress', { skip: toolSkip }, async () => {
  const outputPath = path.join(exportTemp, 'export.mp4');
  const progress = [];
  const result = await runExport({
    project: realProject,
    projectRoot: exportProjectRoot,
    outputPath,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.durationFrames, 45);

  const info = await stat(outputPath);
  assert.ok(info.size > 1000, `expected a non-trivial MP4, got ${info.size} bytes`);

  const probe = await probeMedia(outputPath);
  assert.equal(probe.kind, 'video');
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 180);
  assert.equal(probe.hasAudio, true);
  assert.ok(probe.durationSeconds > 0.5 && probe.durationSeconds < 3, `duration ${probe.durationSeconds}`);

  const parsed = JSON.parse(await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
  ]));
  const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(videoStream, 'output has a video stream');
  assert.ok(audioStream, 'output has an audio stream');
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(audioStream.codec_name, 'aac');

  assert.ok(progress.length >= 1, 'onProgress was called');
  assert.ok(progress.every((value) => value >= 0 && value <= 1));
  assert.equal(progress.at(-1), 1);
});

it('rejects an already-aborted export and leaves no output', { skip: toolSkip }, async () => {
  const outputPath = path.join(exportTemp, 'aborted.mp4');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runExport({
      project: realProject,
      projectRoot: exportProjectRoot,
      outputPath,
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(existsSync(outputPath), false);
});

it('kills a running ffmpeg process when the signal aborts', { skip: toolSkip }, async () => {
  const controller = new AbortController();
  const running = runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=30',
    '-f', 'null', '-',
  ], { signal: controller.signal });

  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error) => error.name === 'AbortError');
});

it(
  'reports a clear error when the ffmpeg build cannot render text',
  {
    skip: initialTools.available
      ? (drawtextAvailable ? 'ffmpeg provides drawtext' : false)
      : 'ffmpeg/ffprobe are not available on this machine',
  },
  async () => {
    const project = structuredClone(realProject);
    project.tracks[0].clips.push({
      ...CLIP_DEFAULTS,
      id: 'text-degradation-clip',
      type: 'text',
      mediaId: null,
      startFrame: 0,
      durationFrames: 30,
      text: { content: 'text needs drawtext', fontSize: 24, color: '#ffffff', fontWeight: '400', align: 'left' },
    });

    const outputPath = path.join(exportTemp, 'text.mp4');
    await assert.rejects(
      runExport({ project, projectRoot: exportProjectRoot, outputPath }),
      (error) => error instanceof ExportError && error.code === 'ffmpeg-failed' && /drawtext/i.test(error.message),
    );
    assert.equal(existsSync(outputPath), false);
  },
);

// ---------------------------------------------------------------------------
// Phase 1: speed, fades, keyframes, effects, captions, transitions
// ---------------------------------------------------------------------------

it('applies clip speed to video and audio', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'speed-video', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, speed: 2,
      }),
    ],
  });
  const built = buildPhase(project);
  const filter = filterOf(built);

  // durationFrames is timeline time; the source window is duration*speed.
  assert.equal(built.durationFrames, 30);
  assert.ok(hasPair(built.args, '-t', '1'), 'output covers 30 timeline frames');
  assert.ok(hasPair(built.args, '-t', '2'), 'video input consumes 60 source frames = 2s');
  assert.match(filter, /\[1:v\]scale=320:180,setsar=1,fps=30,setpts=\(PTS-STARTPTS\)\/2\+0\/TB/);
  assert.match(filter, /\[1:a\]atrim=duration=2,asetpts=PTS-STARTPTS,atempo=2/);

  const slowProject = makeProject({
    clips: [
      makeClip({
        id: 'slow-video', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, speed: 0.25,
      }),
    ],
  });
  const slowBuilt = buildPhase(slowProject);
  const slowFilter = filterOf(slowBuilt);
  assert.match(slowFilter, /setpts=\(PTS-STARTPTS\)\/0\.25\+0\/TB/);
  assert.match(slowFilter, /atempo=0\.5,atempo=0\.5/);
  assert.ok(hasPair(slowBuilt.args, '-t', '0.25'), 'slow motion consumes 7.5 source frames = 0.25s');

  const audioProject = makeProject({
    media: [
      mediaEntry(),
      mediaEntry({
        id: 'media-audio', name: 'music.m4a', kind: 'audio', fileName: 'music.m4a',
        durationFrames: 120, sourceDurationSeconds: 4, width: null, height: null, hasAudio: true,
      }),
    ],
    clips: [],
    extraTracks: [
      {
        id: 'track-audio', type: 'audio', name: 'Audio 1', muted: false, hidden: false,
        clips: [
          makeClip({
            id: 'speed-audio', type: 'audio', mediaId: 'media-audio',
            startFrame: 0, durationFrames: 30, speed: 2,
          }),
        ],
      },
    ],
  });
  const audioFilter = filterOf(buildPhase(audioProject));
  assert.match(audioFilter, /\[1:a\]atrim=duration=2,asetpts=PTS-STARTPTS,atempo=2/);
  assert.match(audioFilter, /amix=inputs=1:normalize=0/);
});

it('applies fade in/out to video and audio', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'fade-clip', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45, fadeInFrames: 10, fadeOutFrames: 15,
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));

  // 45 frames @30fps = 1.5s; 10 in = 0.333333s, 15 out = 0.5s.
  assert.match(filter, /fade=t=in:st=0:d=0\.333333/);
  assert.match(filter, /fade=t=out:st=1:d=0\.5/);
  assert.match(filter, /\[1:a\]atrim=duration=1\.5,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0\.333333/);
  assert.match(filter, /afade=t=out:st=1:d=0\.5/);
});

it('builds keyframe volume and overlay position expressions', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'keyframe-clip', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, volume: 0.9,
        keyframes: {
          volume: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 15, value: 1, easing: 'ease-in-out' },
            { frame: 30, value: 0.2, easing: 'linear' },
          ],
          x: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 30, value: 0.5, easing: 'ease-out' },
          ],
          y: [{ frame: 0, value: 0.25, easing: 'linear' }],
        },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));

  // Keyframe volume replaces the static 0.9 with an eval=frame expression.
  assert.match(filter, /volume=eval=frame:volume='if\(lt\(t,0\),0,if\(lt\(t,0\.5\),/);
  assert.ok(filter.includes('0+(1-0)*((t-0)/(0.5))'), 'linear volume segment');
  assert.ok(filter.includes('if(lt((t-0.5)/(0.5),0.5)'), 'ease-in-out segment');
  assert.ok(filter.includes(',0.2)))'), 'final volume keyframe');

  // x is normalized 0..1 and scaled to the 320px project width; y to 180px.
  assert.ok(
    filter.includes("x='if(lt(t,0),0,if(lt(t,1),0+(160-0)*((t-0)/(1)),160))'"),
    filter,
  );
  assert.ok(filter.includes("y='if(lt(t,0),45,45)'"), filter);
});

it('applies ordered effects, chroma key and LUT filters', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'effects-clip', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        effects: [
          { id: 'e-brightness', type: 'brightness', enabled: true, params: { amount: 1.5 } },
          { id: 'e-contrast', type: 'contrast', enabled: true, params: { amount: 0.8 } },
          { id: 'e-saturation', type: 'saturation', enabled: true, params: { amount: 1.2 } },
          { id: 'e-temperature', type: 'temperature', enabled: true, params: { amount: 0.3 } },
          { id: 'e-blur', type: 'blur', enabled: true, params: { radius: 4 } },
          { id: 'e-sharpen', type: 'sharpen', enabled: true, params: { amount: 0.6 } },
          {
            id: 'e-chroma', type: 'chromaKey', enabled: true,
            params: { keyColor: '#00ff00', similarity: 0.2, blend: 0.1 },
          },
          { id: 'e-lut', type: 'lut', enabled: true, params: { file: 'film.cube' } },
          { id: 'e-disabled', type: 'blur', enabled: false, params: { radius: 10 } },
        ],
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));

  const lutPath = path.join(phaseRoot, 'luts', 'film.cube');
  const ordered = [
    'eq=brightness=0.5',
    'eq=contrast=0.8',
    'eq=saturation=1.2',
    'colorbalance=rs=0.3:bs=-0.3',
    'gblur=sigma=4',
    'unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.6',
    'format=rgba,chromakey=color=0x00ff00:similarity=0.2:blend=0.1',
    `lut3d=file='${lutPath}'`,
  ];
  let previous = -1;
  for (const fragment of ordered) {
    const index = filter.indexOf(fragment);
    assert.ok(index >= 0, `missing effect fragment: ${fragment}\n${filter}`);
    assert.ok(index > previous, `effects must keep clip.effects order: ${fragment}`);
    previous = index;
  }
  assert.ok(!filter.includes('gblur=sigma=10'), 'disabled effects are skipped');
});

it('rejects missing or escaping LUT files with a clear ExportError', () => {
  const projectWithLut = (file) => makeProject({
    clips: [
      makeClip({
        id: 'lut-clip', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        effects: [{ id: 'e-lut', type: 'lut', enabled: true, params: { file } }],
      }),
    ],
  });

  assert.throws(
    () => buildPhase(projectWithLut('missing.cube')),
    (error) => error instanceof ExportError && error.code === 'lut-missing',
  );
  assert.throws(
    () => buildPhase(projectWithLut('../escape.cube')),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );
  assert.throws(
    () => buildPhase(projectWithLut('')),
    (error) => error instanceof ExportError && error.code === 'lut-missing',
  );
});

it('renders caption segments as timed drawtext overlays', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'caption-clip', type: 'caption', mediaId: null,
        startFrame: 30, durationFrames: 50,
        transform: { x: 0.05, y: 0.8, width: 0.9, height: 0.15, rotation: 0 },
        caption: {
          segments: [
            { startFrame: 0, durationFrames: 20, text: 'First line' },
            { startFrame: 25, durationFrames: 20, text: 'Second line' },
          ],
          style: {
            fontSize: 18, color: '#ffff00', fontWeight: '600',
            align: 'center', background: '#000000',
          },
        },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));

  assert.equal((filter.match(/drawtext=/g) ?? []).length, 2);
  assert.ok(filter.includes("text='First line'"));
  assert.ok(filter.includes("text='Second line'"));
  assert.ok(filter.includes("fontcolor='#ffff00'"));
  assert.ok(filter.includes('fontsize=18'));
  assert.ok(filter.includes("boxcolor='#000000'"));
  // Caption clip starts at frame 30 (1s); segments are relative to the clip.
  assert.ok(filter.includes("enable='between(t,1,1.666667)'"), filter);
  assert.ok(filter.includes("enable='between(t,1.833333,2.5)'"), filter);
  // Centered inside the 0.9-wide transform box (x=16px, width=288px).
  assert.ok(filter.includes('x=16+(288-text_w)/2'), filter);
});

it('uses browser-rendered PNGs for text and caption clips', async () => {
  const textClipId = 'phase-png-text';
  const captionClipId = 'phase-png-caption';
  const textPng = path.join(phaseRoot, 'renders', `${textClipId}.png`);
  const captionPng = path.join(phaseRoot, 'renders', `${captionClipId}.png`);
  await writeFile(textPng, 'fake png for argv-only assertions');
  await writeFile(captionPng, 'fake png for argv-only assertions');

  const project = makeProject({
    clips: [
      makeClip({
        id: textClipId, type: 'text', mediaId: null,
        startFrame: 0, durationFrames: 30,
        text: { content: 'SHOULD NOT DRAW', fontSize: 24, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
      makeClip({
        id: captionClipId, type: 'caption', mediaId: null,
        startFrame: 30, durationFrames: 30,
        caption: { segments: [{ startFrame: 0, durationFrames: 30, text: 'SHOULD NOT DRAW CAPTION' }], style: {} },
      }),
    ],
  });
  const built = buildPhase(project);
  const filter = filterOf(built);
  const inputs = inputsOf(built.args);

  assert.ok(inputs.includes(textPng), 'text render PNG is an ffmpeg input');
  assert.ok(inputs.includes(captionPng), 'caption render PNG is an ffmpeg input');
  assert.ok(!filter.includes("text='SHOULD NOT DRAW'"));
  assert.ok(!filter.includes("text='SHOULD NOT DRAW CAPTION'"));
  assert.equal((filter.match(/overlay=/g) ?? []).length, 2);
});

it('uses per-segment caption PNG renders when present', async () => {
  const clipId = 'phase-seg-caption';
  const segmentPng = path.join(phaseRoot, 'renders', `${clipId}-seg-1.png`);
  await writeFile(segmentPng, 'fake segment png for argv-only assertions');

  const project = makeProject({
    clips: [
      makeClip({
        id: clipId, type: 'caption', mediaId: null,
        startFrame: 30, durationFrames: 50,
        transform: { x: 0.05, y: 0.8, width: 0.9, height: 0.15, rotation: 0 },
        caption: {
          segments: [
            { startFrame: 0, durationFrames: 20, text: 'First segment text' },
            { startFrame: 25, durationFrames: 20, text: 'Second segment text' },
          ],
          style: { fontSize: 18, color: '#ffff00', fontWeight: '600', align: 'center' },
        },
      }),
    ],
  });
  const built = buildPhase(project);
  const filter = filterOf(built);

  assert.ok(inputsOf(built.args).includes(segmentPng), 'segment render PNG is an input');
  assert.ok(filter.includes("text='First segment text'"), 'segment 0 still falls back to drawtext');
  assert.ok(!filter.includes("text='Second segment text'"), 'segment 1 uses its PNG render');
  assert.equal((filter.match(/drawtext=/g) ?? []).length, 1);
  assert.equal((filter.match(/overlay=/g) ?? []).length, 1);
});

it('approximates transitions with fade out/in fades when source has no headroom', () => {
  // 45-frame clip on a 45-frame source and an image incoming clip: neither
  // side can extend, so true xfade overlap is impossible and fades are used.
  const media = [
    mediaEntry({ durationFrames: 45 }),
    mediaEntry({
      id: 'media-image', name: 'card.png', kind: 'image', fileName: 'image.png',
      durationFrames: null, sourceDurationSeconds: null, hasAudio: false,
    }),
  ];
  const clips = [
    makeClip({ id: 'tr-a', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 45 }),
    makeClip({ id: 'tr-b', type: 'image', mediaId: 'media-image', startFrame: 45, durationFrames: 45 }),
  ];
  const transitionProject = (type) => makeProject({
    media,
    clips,
    transitions: [{
      id: 'tr-1', trackId: 'track-video', fromClipId: 'tr-a', toClipId: 'tr-b',
      type, durationFrames: 20,
    }],
  });

  // 20 transition frames => 10 frames (0.333333s) on each side.
  for (const type of ['fadeToBlack', 'dissolve', 'wipeLeft', 'wipeRight']) {
    const filter = filterOf(buildPhase(transitionProject(type)));
    assert.ok(filter.includes('fade=t=out:st=1.166667:d=0.333333'), `${type} outgoing fade`);
    assert.ok(filter.includes('fade=t=in:st=1.5:d=0.333333'), `${type} incoming fade`);
  }

  const unsupported = makeProject({
    media,
    clips,
    transitions: [{
      id: 'tr-unknown', trackId: 'track-video', fromClipId: 'tr-a', toClipId: 'tr-b',
      type: 'mystery', durationFrames: 20,
    }],
  });
  assert.ok(!filterOf(buildPhase(unsupported)).includes('fade=t='));

  // Text clips are not valid transition endpoints (DESIGN §11.1).
  const textProject = makeProject({
    clips: [
      makeClip({
        id: 'tr-text', type: 'text', mediaId: null, startFrame: 0, durationFrames: 30,
        text: { content: 'no transition', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
      makeClip({ id: 'tr-video', type: 'video', mediaId: 'media-video', startFrame: 30, durationFrames: 30 }),
    ],
    transitions: [{
      id: 'tr-text', trackId: 'track-video', fromClipId: 'tr-text', toClipId: 'tr-video',
      type: 'fadeToBlack', durationFrames: 10,
    }],
  });
  assert.ok(!filterOf(buildPhase(textProject)).includes('fade=t='));
});

it('degrades unsupported keyframes to the static transform', () => {
  const project = makeProject({
    width: 320,
    height: 180,
    clips: [
      makeClip({
        id: 'unsupported-keyframes', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        keyframes: {
          width: [{ frame: 0, value: 0.5 }, { frame: 30, value: 1 }],
          height: [{ frame: 0, value: 0.5 }, { frame: 30, value: 1 }],
          rotation: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }],
          opacity: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }],
        },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));
  assert.match(filter, /\[1:v\]scale=320:180,setsar=1,fps=30,setpts=PTS-STARTPTS\+0\/TB/);
  assert.ok(filter.includes('overlay=x=0:y=0'), 'static transform is used');
  assert.ok(!filter.includes('colorchannelmixer'), 'static opacity is used for opacity keyframes');
  assert.ok(!filter.includes('if(lt(t,'), 'no dynamic width/height/rotation expressions');
});

it('exports with speed, fades and effects, verified by ffprobe', { skip: toolSkip }, async () => {
  const outputPath = path.join(exportTemp, 'phase-speed-fades-effects.mp4');
  const progress = [];
  const result = await runExport({
    project: phaseRealProject,
    projectRoot: exportProjectRoot,
    outputPath,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.durationFrames, 30);

  const info = await stat(outputPath);
  assert.ok(info.size > 1000, `expected a non-trivial MP4, got ${info.size} bytes`);

  const probe = await probeMedia(outputPath);
  assert.equal(probe.kind, 'video');
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 180);
  assert.equal(probe.hasAudio, true);
  assert.ok(probe.durationSeconds > 0.5 && probe.durationSeconds < 1.5, `duration ${probe.durationSeconds}`);

  const parsed = JSON.parse(await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
  ]));
  const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
  assert.ok(videoStream, 'output has a video stream');
  assert.ok(audioStream, 'output has an audio stream');
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(audioStream.codec_name, 'aac');

  assert.ok(progress.length >= 1);
  assert.equal(progress.at(-1), 1);
});

// ---------------------------------------------------------------------------
// Phase 2: true transitions, rotation, export presets
// ---------------------------------------------------------------------------

it('builds a true overlapping dissolve for butt-joined full-frame clips', () => {
  const built = buildPhase(trueTransitionProject('dissolve'));
  const filter = filterOf(built);
  const inputs = inputsOf(built.args);

  assert.equal(inputs.length, 3, 'base + outgoing source + incoming source');
  assert.ok(hasPair(built.args, '-ss', '0.333333'), 'incoming trim moves 10 frames before its start');
  assert.equal(
    built.args.filter((value, index) => built.args[index - 1] === '-t' && value === '1.833333').length,
    2,
    'both sources are extended to 55 frames',
  );

  // A 20-frame transition splits into 10 frames per side: xfade duration
  // 20/30s starting 10 frames before the cut (45-10=35 frames = 1.166667s).
  assert.match(filter, /\[v0\]\[v1\]xfade=transition=dissolve:duration=0\.666667:offset=1\.166667/);
  assert.match(filter, /setpts=PTS-STARTPTS\+0\/TB/);
  assert.match(filter, /overlay=x=0:y=0:enable='between\(t,0,3\)'/);
  assert.ok(!filter.includes(',fade=t=out'), 'true dissolve does not use the fade fallback');

  // Audio crossfade over the same overlap window.
  assert.ok(filter.includes('afade=t=out:st=1.166667:d=0.666667'), filter);
  assert.ok(filter.includes('afade=t=in:st=0:d=0.666667'), filter);
  assert.ok(filter.includes('adelay=1167:all=1'), filter);
  assert.ok(filter.includes('amix=inputs=2:normalize=0'));
});

it('maps wipeLeft/wipeRight to xfade wipes', () => {
  assert.match(filterOf(buildPhase(trueTransitionProject('wipeLeft'))), /xfade=transition=wipeleft:/);
  assert.match(filterOf(buildPhase(trueTransitionProject('wipeRight'))), /xfade=transition=wiperight:/);
});

it('uses a one-sided true crossfade when the incoming clip has no pre-roll', () => {
  const built = buildPhase(trueTransitionProject('dissolve', { trimStartFrame: 0 }));
  const filter = filterOf(built);

  // sideB is clamped to 0, so the requested 20-frame window moves onto the
  // outgoing tail instead of being halved.
  assert.match(filter, /xfade=transition=dissolve:duration=0\.666667:offset=1\.5/);
  assert.ok(hasPair(built.args, '-ss', '0'), 'incoming source starts at its normal trim');
  assert.ok(filter.includes('afade=t=out:st=1.5:d=0.666667'), filter);
  assert.ok(filter.includes('afade=t=in:st=0:d=0.666667'), filter);
  assert.ok(filter.includes('adelay=1500:all=1'), filter);
});

it('supports a true transition when the outgoing clip is a still image', () => {
  const media = [
    mediaEntry({
      id: 'media-image', name: 'card.png', kind: 'image', fileName: 'image.png',
      durationFrames: null, sourceDurationSeconds: null, hasAudio: false,
    }),
    mediaEntry({ id: 'media-video-b', name: 'b.mp4', fileName: 'b.mp4', durationFrames: 300 }),
  ];
  const clips = [
    makeClip({
      id: 'img-a', type: 'image', mediaId: 'media-image', startFrame: 0, durationFrames: 30,
    }),
    makeClip({
      id: 'img-b', type: 'video', mediaId: 'media-video-b', startFrame: 30, durationFrames: 30,
      trimStartFrame: 10,
    }),
  ];
  const project = makeProject({
    media,
    clips,
    transitions: [{
      id: 'img-tr', trackId: 'track-video', fromClipId: 'img-a', toClipId: 'img-b',
      type: 'dissolve', durationFrames: 10,
    }],
  });
  const built = buildPhase(project);
  const filter = filterOf(built);

  // Outgoing still image has no tail: the 10-frame window moves entirely onto
  // the incoming clip's 10-frame pre-roll.
  assert.match(filter, /xfade=transition=dissolve:duration=0\.333333:offset=0\.666667/);
  assert.ok(hasPair(built.args, '-loop', '1'), 'image input is looped');
  assert.ok(hasPair(built.args, '-t', '1'), 'image layer lasts its 30-frame duration');
  assert.ok(hasPair(built.args, '-t', '1.333333'), 'incoming source covers 40 frames');
});

it('falls back to fades when a true transition clip is transformed', () => {
  const project = trueTransitionProject('dissolve');
  project.tracks[0].clips[0].transform = { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 };
  const filter = filterOf(buildPhase(project));
  assert.ok(!filter.includes('xfade='));
  assert.ok(filter.includes('fade=t=out:st=1.166667:d=0.333333'));
  assert.ok(filter.includes('fade=t=in:st=1.5:d=0.333333'));
});

it('applies static rotation with an expanded canvas fitted inside the transform box', () => {
  const full = makeProject({
    clips: [
      makeClip({
        id: 'rot-full', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45,
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 90 },
      }),
    ],
  });
  const fullFilter = filterOf(buildPhase(full));
  assert.ok(
    fullFilter.includes('rotate=1.570796:ow=180:oh=320:fillcolor=none'),
    fullFilter,
  );
  assert.ok(fullFilter.includes('scale=101:180'), fullFilter);
  assert.ok(fullFilter.includes('overlay=x=110:y=0'), fullFilter);

  const half = makeProject({
    clips: [
      makeClip({
        id: 'rot-half', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45,
        transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 45 },
      }),
    ],
  });
  const halfFilter = filterOf(buildPhase(half));
  assert.ok(halfFilter.includes('rotate=0.785398:ow=177:oh=177:fillcolor=none'), halfFilter);
  assert.ok(halfFilter.includes('scale=90:90'), halfFilter);
  assert.ok(halfFilter.includes('overlay=x=115:y=45'), halfFilter);
});

it('does not rotate drawtext or honor rotation keyframes', () => {
  const textProject = makeProject({
    clips: [
      makeClip({
        id: 'rot-text', type: 'text', mediaId: null, startFrame: 0, durationFrames: 30,
        transform: { x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 90 },
        text: { content: 'upright', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
    ],
  });
  const textFilter = filterOf(buildPhase(textProject));
  assert.ok(!textFilter.includes('rotate='), 'drawtext fallback cannot rotate');
  assert.ok(textFilter.includes("text='upright'"));

  const keyframed = makeProject({
    clips: [
      makeClip({
        id: 'rot-kf', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 30,
        keyframes: { rotation: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }] },
      }),
    ],
  });
  const kfFilter = filterOf(buildPhase(keyframed));
  assert.ok(!kfFilter.includes('rotate='), 'rotation keyframes degrade to the static value');
  assert.match(kfFilter, /\[1:v\]scale=320:180,setsar=1,fps=30,setpts=PTS-STARTPTS\+0\/TB/);
});

it('builds codec/resolution/fps/crf/bitrate presets and validates them', () => {
  const project = makeProject({
    clips: [
      makeClip({ id: 'preset-clip', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 45 }),
    ],
  });
  const defaults = buildPhase(project);
  assert.ok(hasPair(defaults.args, '-c:v', 'libx264'));
  assert.ok(hasPair(defaults.args, '-preset', 'veryfast'));
  assert.ok(hasPair(defaults.args, '-crf', '20'));

  const sizedBuilt = buildExportArgs({
    project,
    projectRoot: phaseRoot,
    outputPath: path.join(phaseRoot, 'sized.mp4'),
    options: { width: 640, height: 360, fps: 24, crf: 28 },
  });
  assert.match(inputsOf(sizedBuilt.args)[0], /^color=c=black:s=640x360:r=30:d=1\.5$/);
  assert.match(filterOf(sizedBuilt), /scale=640:360/);
  assert.ok(hasPair(sizedBuilt.args, '-r', '24'));
  assert.ok(hasPair(sizedBuilt.args, '-crf', '28'));
  assert.equal(sizedBuilt.durationFrames, 45);

  const bitrateBuilt = buildExportArgs({
    project,
    projectRoot: phaseRoot,
    outputPath: path.join(phaseRoot, 'bitrate.mp4'),
    options: { bitrate: '5M' },
  });
  assert.ok(hasPair(bitrateBuilt.args, '-b:v', '5M'));
  assert.ok(!hasPair(bitrateBuilt.args, '-crf', '20'));

  const numeric = buildExportArgs({
    project,
    projectRoot: phaseRoot,
    outputPath: path.join(phaseRoot, 'bitrate2.mp4'),
    options: { bitrate: 4000 },
  });
  assert.ok(hasPair(numeric.args, '-b:v', '4000k'));

  // Top-level (inline) options are accepted for convenience.
  const inline = buildExportArgs({
    project,
    projectRoot: phaseRoot,
    outputPath: path.join(phaseRoot, 'inline.mp4'),
    codec: 'h265',
    crf: 30,
  });
  if (encoderNames.has('libx265')) {
    assert.ok(hasPair(inline.args, '-c:v', 'libx265'));
    assert.ok(hasPair(inline.args, '-tag:v', 'hvc1'));
    assert.ok(hasPair(inline.args, '-crf', '30'));
  } else if (encoderNames.has('hevc_videotoolbox')) {
    assert.ok(hasPair(inline.args, '-c:v', 'hevc_videotoolbox'));
    assert.ok(hasPair(inline.args, '-b:v', '8M'));
    assert.ok(!hasPair(inline.args, '-crf', '30'));
  } else if (initialTools.available) {
    assert.throws(
      () => buildPhase(project, path.join(phaseRoot, 'h265.mp4')),
      (error) => error instanceof ExportError && error.code === 'encoder-unavailable',
    );
  } else {
    assert.ok(hasPair(inline.args, '-c:v', 'libx265'));
  }

  for (const options of [
    { codec: 'av1' },
    { width: 0 },
    { height: 1 },
    { fps: 0 },
    { fps: 300 },
    { crf: 52 },
    { bitrate: 'abc' },
  ]) {
    assert.throws(
      () => buildExportArgs({ project, projectRoot: phaseRoot, outputPath: path.join(phaseRoot, 'x.mp4'), options }),
      (error) => error instanceof ExportError && error.code === 'invalid-input',
      `expected invalid-input for ${JSON.stringify(options)}`,
    );
  }
});

it('keeps true-transition visuals on muted tracks and hides them on hidden tracks', () => {
  const muted = trueTransitionProject('dissolve');
  muted.tracks[0].muted = true;
  const mutedBuilt = buildPhase(muted);
  const mutedFilter = filterOf(mutedBuilt);
  assert.ok(mutedFilter.includes('xfade=transition=dissolve:'));
  assert.ok(!mutedFilter.includes('afade='));
  assert.ok(!mutedFilter.includes('amix'));
  assert.ok(mutedBuilt.args.includes('-an'));

  const hidden = trueTransitionProject('dissolve');
  hidden.tracks[0].hidden = true;
  const hiddenFilter = filterOf(buildPhase(hidden));
  assert.ok(!hiddenFilter.includes('xfade='), 'hidden tracks never build a visual transition');
  assert.ok(!hiddenFilter.includes('overlay='));
  assert.ok(!hiddenFilter.includes('drawtext='));
});

it('exports a true dissolve and rotation with H.264, verified by pixel sampling', { skip: toolSkip }, async () => {
  const outputPath = path.join(exportTemp, 'phase2-h264.mp4');
  const progress = [];
  const result = await runExport({
    project: phase2Project,
    projectRoot: exportProjectRoot,
    outputPath,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.durationFrames, 75);
  const info = await stat(outputPath);
  assert.ok(info.size > 1000);

  const probe = await probeMedia(outputPath);
  assert.equal(probe.kind, 'video');
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 180);
  assert.ok(probe.durationSeconds > 2.2 && probe.durationSeconds < 3, `duration ${probe.durationSeconds}`);
  assert.equal(probe.hasAudio, false, 'the phase 2 fixture has no audio sources');

  const parsed = JSON.parse(await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
  ]));
  const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(videoStream.codec_name, 'h264');

  // 10 transition frames split 5/5 around the 1s cut (window 0.833..1.167).
  const before = await samplePixel(outputPath, 0.2, 160, 90);
  assert.ok(before.r > 180 && before.b < 80, `expected red before the cut, got ${JSON.stringify(before)}`);
  const blended = await samplePixel(outputPath, 1, 160, 90);
  assert.ok(
    blended.r > 50 && blended.b > 50,
    `expected a true red/blue dissolve at the cut, got ${JSON.stringify(blended)}`,
  );
  const after = await samplePixel(outputPath, 1.8, 160, 90);
  assert.ok(after.b > 180 && after.r < 80, `expected blue after the cut, got ${JSON.stringify(after)}`);
  const rotated = await samplePixel(outputPath, 2.2, 160, 90);
  assert.ok(
    rotated.g > 90 && rotated.r < 40 && rotated.b < 40,
    `expected the rotated green poster at 2.2s, got ${JSON.stringify(rotated)}`,
  );

  assert.ok(progress.length >= 1);
  assert.equal(progress.at(-1), 1);
});

it(
  'exports H.265 with resolution/fps presets when the encoder is available',
  { skip: toolSkip ? toolSkip : (!hasH265Encoder ? 'no H.265 encoder available' : false) },
  async () => {
    const outputPath = path.join(exportTemp, 'phase2-h265.mp4');
    const result = await runExport({
      project: phase2Project,
      projectRoot: exportProjectRoot,
      outputPath,
      options: { codec: 'h265', width: 160, height: 90, fps: 15 },
    });
    assert.equal(result.durationFrames, 75);

    const probe = await probeMedia(outputPath);
    assert.equal(probe.kind, 'video');
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 90);
    assert.equal(probe.fps, 15);
    assert.ok(probe.durationSeconds > 2.2 && probe.durationSeconds < 3);

    const parsed = JSON.parse(await runFfprobe([
      '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
    ]));
    const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(videoStream.codec_name, 'hevc');
  },
);

// ---------------------------------------------------------------------------
// Phase 6: ProRes / WebM export formats
// ---------------------------------------------------------------------------

it('exposes default containers and extensions per codec', () => {
  assert.deepEqual([...EXPORT_CODECS], ['h264', 'h265', 'prores', 'vp9']);
  assert.equal(defaultExtensionForCodec('h264'), '.mp4');
  assert.equal(defaultExtensionForCodec('h265'), '.mp4');
  assert.equal(defaultExtensionForCodec('prores'), '.mov');
  assert.equal(defaultExtensionForCodec('vp9'), '.webm');
  assert.equal(defaultExtensionForCodec('webm'), '.webm', 'webm is a vp9 alias');
  assert.equal(defaultExtensionForCodec('hevc'), '.mp4', 'hevc is an h265 alias');
  assert.equal(defaultContainerForCodec('prores'), 'mov');
  assert.equal(defaultContainerForCodec('webm'), 'webm');
  assert.throws(
    () => defaultExtensionForCodec('av1'),
    (error) => error instanceof ExportError && error.code === 'invalid-input',
  );
});

it('builds ProRes MOV argv with PCM audio and no CRF', () => {
  const project = createFixtureProject();
  const outputPath = path.join(FIXTURE_ROOT, 'out.mov');
  const built = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'prores' },
  });
  assert.equal(built.codec, 'prores');
  assert.equal(built.container, 'mov');
  assert.ok(hasPair(built.args, '-c:v', 'prores_ks'));
  assert.ok(hasPair(built.args, '-profile:v', '3'));
  assert.ok(hasPair(built.args, '-pix_fmt', 'yuv422p10le'));
  assert.ok(hasPair(built.args, '-c:a', 'pcm_s16le'));
  assert.ok(hasPair(built.args, '-f', 'mov'));
  assert.ok(hasPair(built.args, '-movflags', '+faststart'));
  assert.ok(!built.args.includes('-crf'), 'ProRes ignores CRF');
  assert.ok(!built.args.includes('-preset'));
  assert.ok(!hasPair(built.args, '-c:a', 'aac'));

  const bitrateBuilt = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'prores', bitrate: '80M' },
  });
  assert.ok(hasPair(bitrateBuilt.args, '-b:v', '80M'));
  assert.ok(!bitrateBuilt.args.includes('-crf'));

  const crfIgnored = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'prores', crf: 10 },
  });
  assert.ok(!crfIgnored.args.includes('-crf'));
});

it('builds VP9/WebM argv with libopus and CRF/bitrate semantics', () => {
  const project = createFixtureProject();
  const outputPath = path.join(FIXTURE_ROOT, 'out.webm');
  const built = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'vp9' },
  });
  assert.equal(built.codec, 'vp9');
  assert.equal(built.container, 'webm');
  assert.ok(hasPair(built.args, '-c:v', 'libvpx-vp9'));
  assert.ok(hasPair(built.args, '-pix_fmt', 'yuv420p'));
  assert.ok(hasPair(built.args, '-crf', '31'));
  assert.ok(hasPair(built.args, '-b:v', '0'), 'constant-quality VP9 uses -b:v 0');
  assert.ok(hasPair(built.args, '-c:a', 'libopus'));
  assert.ok(hasPair(built.args, '-b:a', '128k'));
  assert.ok(hasPair(built.args, '-f', 'webm'));
  assert.ok(!hasPair(built.args, '-movflags', '+faststart'));
  assert.ok(!built.args.includes('-preset'));

  const alias = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'webm' },
  });
  assert.equal(alias.codec, 'vp9');
  assert.ok(hasPair(alias.args, '-c:v', 'libvpx-vp9'));

  const crfBuilt = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'vp9', crf: 40 },
  });
  assert.ok(hasPair(crfBuilt.args, '-crf', '40'));
  assert.ok(hasPair(crfBuilt.args, '-b:v', '0'));

  const bitrateBuilt = buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options: { codec: 'vp9', bitrate: '2M' },
  });
  assert.ok(hasPair(bitrateBuilt.args, '-b:v', '2M'));
  assert.ok(!bitrateBuilt.args.includes('-crf'), 'bitrate mode does not use CRF');
});

it('validates codec/container combinations', () => {
  const project = createFixtureProject();
  const outputPath = path.join(FIXTURE_ROOT, 'out.bin');
  const buildWith = (options) => buildExportArgs({
    project,
    projectRoot: FIXTURE_ROOT,
    outputPath,
    options,
  });

  // H.264/H.265 may be written into MOV when explicitly requested.
  const mov = buildWith({ container: 'mov' });
  assert.equal(mov.container, 'mov');
  assert.ok(hasPair(mov.args, '-f', 'mov'));
  assert.ok(hasPair(mov.args, '-c:a', 'aac'));
  assert.ok(hasPair(mov.args, '-movflags', '+faststart'));
  assert.ok(!hasPair(mov.args, '-f', 'mp4'), 'default h264 export does not force a muxer');

  for (const options of [
    { codec: 'prores', container: 'mp4' },
    { codec: 'prores', container: 'webm' },
    { codec: 'vp9', container: 'mov' },
    { codec: 'vp9', container: 'mp4' },
    { codec: 'h264', container: 'webm' },
    { codec: 'h265', container: 'webm' },
    { codec: 'h264', container: 'mkv' },
    { codec: 'av1' },
  ]) {
    assert.throws(
      () => buildWith(options),
      (error) => error instanceof ExportError && error.code === 'invalid-input',
      `expected invalid-input for ${JSON.stringify(options)}`,
    );
  }
});

it('selects the audio codec per format and omits it for silent projects', () => {
  const silent = createFixtureProject();
  // Keep only the video track and mark its source silent so no audio chain is
  // produced at all.
  silent.tracks = [silent.tracks[0]];
  silent.media[0].hasAudio = false;

  const proresSilent = buildExportArgs({
    project: silent,
    projectRoot: FIXTURE_ROOT,
    outputPath: path.join(FIXTURE_ROOT, 'silent.mov'),
    options: { codec: 'prores' },
  });
  assert.ok(proresSilent.args.includes('-an'));
  assert.ok(!hasPair(proresSilent.args, '-c:a', 'pcm_s16le'));

  const vp9Silent = buildExportArgs({
    project: silent,
    projectRoot: FIXTURE_ROOT,
    outputPath: path.join(FIXTURE_ROOT, 'silent.webm'),
    options: { codec: 'vp9' },
  });
  assert.ok(vp9Silent.args.includes('-an'));
  assert.ok(!hasPair(vp9Silent.args, '-c:a', 'libopus'));
});

it(
  'exports a real ProRes MOV verified by ffprobe',
  {
    skip: toolSkip
      ? toolSkip
      : (!hasProresEncoder ? 'prores_ks encoder is not available' : false),
  },
  async () => {
    const outputPath = path.join(exportTemp, 'formats-prores.mov');
    const result = await runExport({
      project: realProject,
      projectRoot: exportProjectRoot,
      outputPath,
      options: { codec: 'prores' },
    });
    assert.equal(result.codec, 'prores');
    assert.equal(result.container, 'mov');
    assert.equal(result.durationFrames, 45);

    const info = await stat(outputPath);
    assert.ok(info.size > 1000);
    const probe = await probeMedia(outputPath);
    assert.equal(probe.kind, 'video');
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 180);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.durationSeconds > 1 && probe.durationSeconds < 2);

    const parsed = JSON.parse(await runFfprobe([
      '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
    ]));
    const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(videoStream.codec_name, 'prores');
    assert.equal(videoStream.pix_fmt, 'yuv422p10le');
    assert.equal(audioStream.codec_name, 'pcm_s16le');
  },
);

it(
  'exports a real VP9 WebM verified by ffprobe',
  {
    skip: toolSkip
      ? toolSkip
      : (!hasVp9Encoder || !hasOpusEncoder ? 'libvpx-vp9/libopus encoders are not available' : false),
  },
  async () => {
    const outputPath = path.join(exportTemp, 'formats-vp9.webm');
    const result = await runExport({
      project: realProject,
      projectRoot: exportProjectRoot,
      outputPath,
      options: { codec: 'vp9' },
    });
    assert.equal(result.codec, 'vp9');
    assert.equal(result.container, 'webm');
    assert.equal(result.durationFrames, 45);

    const info = await stat(outputPath);
    assert.ok(info.size > 1000);
    const probe = await probeMedia(outputPath);
    assert.equal(probe.kind, 'video');
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 180);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.durationSeconds > 1 && probe.durationSeconds < 2);

    const parsed = JSON.parse(await runFfprobe([
      '-v', 'error', '-print_format', 'json', '-show_streams', outputPath,
    ]));
    const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(videoStream.codec_name, 'vp9');
    assert.equal(audioStream.codec_name, 'opus');
  },
);

// ---------------------------------------------------------------------------
// Phase 6: crop export
// ---------------------------------------------------------------------------

it('applies a normalized crop before scale and keeps the transform box', () => {
  const cropped = makeProject({
    clips: [
      makeClip({
        id: 'crop-video', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45,
        crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      }),
    ],
  });
  const filter = filterOf(buildPhase(cropped));
  assert.ok(filter.includes('crop=w=iw*0.5:h=ih*1:x=iw*0.25:y=ih*0'), filter);
  const cropIndex = filter.indexOf('crop=');
  const scaleIndex = filter.indexOf('scale=');
  assert.ok(cropIndex >= 0 && cropIndex < scaleIndex, 'crop must run before scale');
  assert.ok(filter.includes('overlay=x=0:y=0'), 'overlay placement/transform box unchanged');

  const plain = makeProject({
    clips: [
      makeClip({ id: 'plain-video', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 45 }),
    ],
  });
  const plainFilter = filterOf(buildPhase(plain));
  assert.ok(!plainFilter.includes('crop='), 'no-crop clips are unchanged');
  assert.match(plainFilter, /\[1:v\]scale=320:180,setsar=1,fps=30/);
});

it('applies crop before rotation and scales the cropped region into the box', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'crop-rotate', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45,
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 90 },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));
  const cropIndex = filter.indexOf('crop=w=iw*0.8:h=ih*0.8:x=iw*0.1:y=ih*0.1');
  const scaleIndex = filter.indexOf('scale=320:180');
  const rotateIndex = filter.indexOf('rotate=');
  assert.ok(cropIndex >= 0, filter);
  assert.ok(scaleIndex > cropIndex, 'scale follows crop');
  assert.ok(rotateIndex > scaleIndex, 'rotation follows scale');
});

it('applies crop to image clips and browser-rendered text PNGs', async () => {
  const imageProject = makeProject({
    media: [
      mediaEntry({
        id: 'media-image', name: 'card.png', kind: 'image', fileName: 'image.png',
        durationFrames: null, sourceDurationSeconds: null, hasAudio: false,
      }),
    ],
    clips: [
      makeClip({
        id: 'crop-image', type: 'image', mediaId: 'media-image',
        startFrame: 0, durationFrames: 30,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ],
  });
  const imageFilter = filterOf(buildPhase(imageProject));
  assert.ok(imageFilter.includes('crop=w=iw*0.5:h=ih*0.5:x=iw*0:y=ih*0'), imageFilter);
  assert.ok(imageFilter.indexOf('crop=') < imageFilter.indexOf('scale='));

  const textClipId = 'crop-png-text';
  const pngPath = path.join(phaseRoot, 'renders', `${textClipId}.png`);
  await writeFile(pngPath, 'fake png for argv-only assertions');
  const textProject = makeProject({
    clips: [
      makeClip({
        id: textClipId, type: 'text', mediaId: null,
        startFrame: 0, durationFrames: 30,
        crop: { x: 0, y: 0, width: 0.25, height: 0.5 },
        text: { content: 'crop me', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
    ],
  });
  const textBuilt = buildPhase(textProject);
  const textFilter = filterOf(textBuilt);
  assert.ok(inputsOf(textBuilt.args).includes(pngPath));
  assert.ok(textFilter.includes('crop=w=iw*0.25:h=ih*0.5:x=iw*0:y=ih*0'), textFilter);
  assert.ok(!textFilter.includes('drawtext='), 'PNG render path wins over drawtext');
});

it('keeps effects, fades and keyframes on cropped clips', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'crop-rich', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 45,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        fadeInFrames: 10, fadeOutFrames: 10,
        effects: [{ id: 'fx', type: 'brightness', enabled: true, params: { amount: 1.4 } }],
        keyframes: {
          x: [{ frame: 0, value: 0 }, { frame: 45, value: 0.25 }],
        },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));
  assert.ok(filter.includes('crop=w=iw*0.5:h=ih*0.5:x=iw*0:y=ih*0'), filter);
  assert.ok(filter.includes('eq=brightness=0.399999') || filter.includes('eq=brightness=0.4'), filter);
  assert.ok(filter.includes('fade=t=in:st=0:d=0.333333'), filter);
  assert.ok(filter.includes('fade=t=out:st=1.166667:d=0.333333'), filter);
  assert.ok(filter.includes("overlay=x='if(lt(t,0),0,"), filter);
});

it('falls back from true xfade when either clip has a crop', () => {
  const project = trueTransitionProject('dissolve');
  project.tracks[0].clips[0].crop = { x: 0, y: 0, width: 1, height: 1 };
  const filter = filterOf(buildPhase(project));
  assert.ok(!filter.includes('xfade='), 'cropped clips cannot use xfade');
  assert.ok(filter.includes('fade=t=out:st=1.166667:d=0.333333'), filter);
  assert.ok(filter.includes('fade=t=in:st=1.5:d=0.333333'), filter);
  assert.ok(filter.includes('crop=w=iw*1:h=ih*1:x=iw*0:y=ih*0'));
});

it('ignores crop in the drawtext fallback', () => {
  const project = makeProject({
    clips: [
      makeClip({
        id: 'crop-text', type: 'text', mediaId: null, startFrame: 0, durationFrames: 30,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        text: { content: 'uncropped text', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
    ],
  });
  const filter = filterOf(buildPhase(project));
  assert.ok(!filter.includes('crop='), 'drawtext fallback cannot crop');
  assert.ok(filter.includes("text='uncropped text'"));
});

it('exports a cropped clip and samples only the cropped region', { skip: toolSkip }, async () => {
  const project = makeProject({
    media: [splitMedia],
    clips: [
      makeClip({
        id: 'crop-real', type: 'image', mediaId: splitMedia.id,
        startFrame: 0, durationFrames: 30,
        crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
      }),
    ],
  });
  const outputPath = path.join(exportTemp, 'crop-export.mp4');
  const result = await runExport({
    project,
    projectRoot: exportProjectRoot,
    outputPath,
    options: { codec: 'h264' },
  });
  assert.equal(result.durationFrames, 30);
  assert.equal(result.codec, 'h264');
  assert.equal(result.container, 'mp4');

  const probe = await probeMedia(outputPath);
  assert.equal(probe.kind, 'video');
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 180);
  assert.ok(probe.durationSeconds > 0.5 && probe.durationSeconds < 1.5);

  // The source is red on the left and blue on the right; cropping x=0.5 keeps
  // only blue, and the cropped region is scaled back to the full 320x180 box.
  for (const x of [60, 160, 260]) {
    const pixel = await samplePixel(outputPath, 0.2, x, 90);
    assert.ok(
      pixel.r < 50 && pixel.g < 50 && pixel.b > 150,
      `expected blue at x=${x} after cropping the right half, got ${JSON.stringify(pixel)}`,
    );
  }
  const info = await stat(outputPath);
  assert.ok(info.size > 1000);
});

// ---------------------------------------------------------------------------
// Phase 7: masks, blend modes, track volume
// ---------------------------------------------------------------------------

it('applies rect/ellipse mask alpha with feather and invert via geq', () => {
  const rect = makeProject({
    clips: [
      makeClip({
        id: 'mask-rect', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 1, feather: 0, invert: false },
      }),
    ],
  });
  const rectFilter = filterOf(buildPhase(rect));
  assert.ok(rectFilter.includes("geq=r='r(X,Y)'"), rectFilter);
  assert.ok(rectFilter.includes("a='255*("), 'geq alpha is 0..255');
  assert.ok(rectFilter.includes('gte(') && rectFilter.includes('lte('), 'hard rect edges');
  assert.ok(rectFilter.indexOf('format=rgba') < rectFilter.indexOf('geq='));
  assert.ok(rectFilter.indexOf('geq=') < rectFilter.indexOf('setpts='), 'mask before setpts/overlay');

  const feather = makeProject({
    clips: [
      makeClip({
        id: 'mask-feather', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 1, feather: 0.2, invert: false },
      }),
    ],
  });
  const featherFilter = filterOf(buildPhase(feather));
  assert.ok(featherFilter.includes('3-2*'), 'smoothstep feather');
  assert.ok(featherFilter.includes('/0.2'), 'feather fraction is used');

  const ellipse = makeProject({
    clips: [
      makeClip({
        id: 'mask-ellipse', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30,
        mask: { shape: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0, invert: true },
      }),
    ],
  });
  const ellipseFilter = filterOf(buildPhase(ellipse));
  assert.ok(ellipseFilter.includes('sqrt('), ellipseFilter);
  assert.ok(ellipseFilter.includes('1-('), 'invert flips alpha');
  assert.ok(ellipseFilter.includes('lte('), 'hard ellipse boundary');
});

it('applies masks to image clips and rendered text PNGs but not drawtext', async () => {
  const imageProject = makeProject({
    media: [
      mediaEntry({
        id: 'media-image', name: 'card.png', kind: 'image', fileName: 'image.png',
        durationFrames: null, sourceDurationSeconds: null, hasAudio: false,
      }),
    ],
    clips: [
      makeClip({
        id: 'mask-image', type: 'image', mediaId: 'media-image',
        startFrame: 0, durationFrames: 30,
        mask: { shape: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.1, invert: false },
      }),
    ],
  });
  assert.ok(filterOf(buildPhase(imageProject)).includes('geq='));

  const textClipId = 'mask-png-text';
  const pngPath = path.join(phaseRoot, 'renders', `${textClipId}.png`);
  await writeFile(pngPath, 'fake png for argv-only assertions');
  const textPngProject = makeProject({
    clips: [
      makeClip({
        id: textClipId, type: 'text', mediaId: null, startFrame: 0, durationFrames: 30,
        mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false },
        text: { content: 'masked text', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
    ],
  });
  const textPngFilter = filterOf(buildPhase(textPngProject));
  assert.ok(textPngFilter.includes('geq='), 'PNG render can be masked');
  assert.ok(!textPngFilter.includes('drawtext='));

  const drawtextProject = makeProject({
    clips: [
      makeClip({
        id: 'mask-drawtext', type: 'text', mediaId: null, startFrame: 0, durationFrames: 30,
        mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false },
        text: { content: 'unmasked text', fontSize: 20, color: '#ffffff', fontWeight: '400', align: 'left' },
      }),
    ],
  });
  const drawtextFilter = filterOf(buildPhase(drawtextProject));
  assert.ok(!drawtextFilter.includes('geq='), 'drawtext fallback cannot mask');
  assert.ok(drawtextFilter.includes("text='unmasked text'"));
});

it('falls back from true xfade for masked or blended clips', () => {
  const masked = trueTransitionProject('dissolve');
  masked.tracks[0].clips[0].mask = {
    shape: 'rect', x: 0, y: 0, width: 1, height: 1, feather: 0, invert: false,
  };
  const maskedFilter = filterOf(buildPhase(masked));
  assert.ok(!maskedFilter.includes('xfade='));
  assert.ok(maskedFilter.includes('geq='));
  assert.ok(maskedFilter.includes('fade=t=out:st=1.166667:d=0.333333'));

  const blended = trueTransitionProject('dissolve');
  blended.tracks[0].clips[0].blendMode = 'screen';
  const blendedFilter = filterOf(buildPhase(blended));
  assert.ok(!blendedFilter.includes('xfade='));
  assert.ok(blendedFilter.includes('blend=all_mode=screen'));
});

it('uses blend for full-frame clips and falls back to overlay otherwise', () => {
  const screen = makeProject({
    clips: [
      makeClip({
        id: 'blend-screen', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, blendMode: 'screen',
      }),
    ],
  });
  const screenFilter = filterOf(buildPhase(screen));
  assert.ok(screenFilter.includes("blend=all_mode=screen:enable='between(t,0,1)'"), screenFilter);
  assert.ok(!screenFilter.includes('overlay='), 'blend replaces overlay');

  const add = makeProject({
    clips: [
      makeClip({
        id: 'blend-add', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, blendMode: 'add', opacity: 0.5,
      }),
    ],
  });
  const addFilter = filterOf(buildPhase(add));
  assert.ok(addFilter.includes('blend=all_mode=addition:all_opacity=0.5:enable='), addFilter);

  for (const [label, patch] of [
    ['half transform', { transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 } }],
    ['rotation', { transform: { x: 0, y: 0, width: 1, height: 1, rotation: 45 } }],
    ['crop', { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    ['mask', { mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 0.5, feather: 0, invert: false } }],
  ]) {
    const fallback = makeProject({
      clips: [
        makeClip({
          id: `blend-fallback-${label}`, type: 'video', mediaId: 'media-video',
          startFrame: 0, durationFrames: 30, blendMode: 'screen', ...patch,
        }),
      ],
    });
    const filter = filterOf(buildPhase(fallback));
    assert.ok(!filter.includes('blend='), `${label} falls back to overlay`);
    assert.ok(filter.includes('overlay='), `${label} uses overlay`);
  }
});

it('multiplies track volume into clip volume, keyframes and transition audio', () => {
  const project = makeProject({
    media: [
      mediaEntry(),
      mediaEntry({
        id: 'media-audio', name: 'music.m4a', kind: 'audio', fileName: 'music.m4a',
        durationFrames: 120, sourceDurationSeconds: 4, width: null, height: null, hasAudio: true,
      }),
    ],
    clips: [
      makeClip({
        id: 'tv', type: 'video', mediaId: 'media-video',
        startFrame: 0, durationFrames: 30, volume: 0.75,
      }),
    ],
    extraTracks: [
      {
        id: 'track-audio', type: 'audio', name: 'Audio', muted: false, hidden: false, volume: 0.5,
        clips: [
          makeClip({
            id: 'ta', type: 'audio', mediaId: 'media-audio',
            startFrame: 0, durationFrames: 30, volume: 0.8,
          }),
        ],
      },
    ],
  });
  // Video track has no volume property -> default 1.
  project.tracks[0].volume = 2;
  const filter = filterOf(buildPhase(project));
  assert.ok(filter.includes('volume=1.5'), 'video clip audio: 0.75 * track 2');
  assert.ok(filter.includes('volume=0.4'), 'audio clip: 0.8 * track 0.5');

  const keyframed = makeProject({
    media: [
      mediaEntry({
        id: 'media-audio', name: 'music.m4a', kind: 'audio', fileName: 'music.m4a',
        durationFrames: 120, sourceDurationSeconds: 4, width: null, height: null, hasAudio: true,
      }),
    ],
    clips: [],
    extraTracks: [
      {
        id: 'track-audio', type: 'audio', name: 'Audio', muted: false, hidden: false, volume: 0.5,
        clips: [
          makeClip({
            id: 'ta', type: 'audio', mediaId: 'media-audio',
            startFrame: 0, durationFrames: 30,
            keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] },
          }),
        ],
      },
    ],
  });
  const keyframeFilter = filterOf(buildPhase(keyframed));
  assert.ok(keyframeFilter.includes("volume=eval=frame:volume='(if("), keyframeFilter);
  assert.ok(keyframeFilter.includes(')*0.5'), 'keyframe volume is multiplied by track volume');

  const transition = trueTransitionProject('dissolve');
  transition.tracks[0].volume = 0.5;
  const transitionFilter = filterOf(buildPhase(transition));
  assert.equal((transitionFilter.match(/volume=0\.5/g) ?? []).length, 2, 'both crossfade inputs are scaled');
});

it('exports mask alpha and blend modes with pixel sampling', { skip: toolSkip }, async () => {
  // Mask: green full-frame poster masked to the left half over black.
  const maskProject = makeProject({
    media: [greenMedia],
    clips: [
      makeClip({
        id: 'mask-real', type: 'image', mediaId: greenMedia.id,
        startFrame: 0, durationFrames: 30,
        mask: { shape: 'rect', x: 0, y: 0, width: 0.5, height: 1, feather: 0, invert: false },
      }),
    ],
  });
  const maskOutput = path.join(exportTemp, 'mask-export.mp4');
  await runExport({ project: maskProject, projectRoot: exportProjectRoot, outputPath: maskOutput });

  const left = await samplePixel(maskOutput, 0.2, 60, 90);
  assert.ok(left.g > 90 && left.r < 40 && left.b < 40, `expected green inside mask, got ${JSON.stringify(left)}`);
  const right = await samplePixel(maskOutput, 0.2, 260, 90);
  assert.ok(right.r < 40 && right.g < 40 && right.b < 40, `expected black outside mask, got ${JSON.stringify(right)}`);

  // Blend: red base, blue clip with screen over it -> magenta.
  const blendProject = makeProject({
    media: [redMedia, blueMedia, audioMedia],
    clips: [
      makeClip({ id: 'blend-base', type: 'video', mediaId: redMedia.id, startFrame: 0, durationFrames: 30 }),
    ],
    extraTracks: [
      {
        id: 'blend-top', type: 'video', name: 'Blend', muted: false, hidden: false,
        clips: [
          makeClip({
            id: 'blend-top-clip', type: 'video', mediaId: blueMedia.id,
            startFrame: 0, durationFrames: 30, blendMode: 'screen',
          }),
        ],
      },
      {
        id: 'blend-audio', type: 'audio', name: 'Audio', muted: false, hidden: false, volume: 1,
        clips: [
          makeClip({
            id: 'blend-tone', type: 'audio', mediaId: audioMedia.id,
            startFrame: 0, durationFrames: 30, volume: 0.8,
          }),
        ],
      },
    ],
  });
  const loudOutput = path.join(exportTemp, 'blend-loud.mp4');
  await runExport({ project: blendProject, projectRoot: exportProjectRoot, outputPath: loudOutput });
  const blended = await samplePixel(loudOutput, 0.2, 160, 90);
  assert.ok(
    blended.r > 150 && blended.b > 150 && blended.g < 90,
    `expected screen(red, blue) = magenta, got ${JSON.stringify(blended)}`,
  );

  // Track volume 0.25 must bring the audio down versus the same project at 1.
  const quietProject = structuredClone(blendProject);
  quietProject.tracks[2].volume = 0.25;
  const quietOutput = path.join(exportTemp, 'blend-quiet.mp4');
  await runExport({ project: quietProject, projectRoot: exportProjectRoot, outputPath: quietOutput });

  const loudDb = await meanVolumeDb(loudOutput);
  const quietDb = await meanVolumeDb(quietOutput);
  assert.ok(
    quietDb < loudDb - 6,
    `track volume 0.25 should lower mean volume (loud ${loudDb} dB, quiet ${quietDb} dB)`,
  );
});

// ---------------------------------------------------------------------------
// Phase 9: audio ducking
// ---------------------------------------------------------------------------

function audioMediaEntry(id, name) {
  return mediaEntry({
    id, name, kind: 'audio', fileName: `${name}.m4a`,
    durationFrames: 300, sourceDurationSeconds: 10,
    width: null, height: null, hasAudio: true,
  });
}

function audioTrackFor(id, role, ducking, clips, volume = 1) {
  return {
    id, type: 'audio', name: id, muted: false, hidden: false, volume, role, ducking, clips,
  };
}

function audioClipFor(id, mediaId, durationFrames = 30) {
  return makeClip({ id, type: 'audio', mediaId, startFrame: 0, durationFrames });
}

it('builds a voice bus and sidechain-compresses a ducking music track', () => {
  const project = makeProject({
    media: [audioMediaEntry('media-voice', 'voice'), audioMediaEntry('media-music', 'music')],
    clips: [],
    extraTracks: [
      audioTrackFor('t-voice', 'voice', false, [audioClipFor('vc', 'media-voice')]),
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
    ],
  });
  const filter = filterOf(buildPhase(project));

  assert.ok(filter.includes('[a0]asplit=2[voiceKey0][voiceFinal]'), filter);
  assert.ok(
    filter.includes(
      '[a1][voiceKey0]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300:makeup=1[ducked0]',
    ),
    filter,
  );
  assert.ok(
    filter.includes('[voiceFinal][ducked0]amix=inputs=2:normalize=0:duration=longest,aresample=48000[aout]'),
    filter,
  );
});

it('splits the voice bus once per ducking track', () => {
  const project = makeProject({
    media: [
      audioMediaEntry('media-voice', 'voice'),
      audioMediaEntry('media-music', 'music'),
      audioMediaEntry('media-sfx', 'sfx'),
    ],
    clips: [],
    extraTracks: [
      audioTrackFor('t-voice', 'voice', false, [audioClipFor('vc', 'media-voice')]),
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
      audioTrackFor('t-sfx', 'sfx', true, [audioClipFor('sc', 'media-sfx')]),
    ],
  });
  const filter = filterOf(buildPhase(project));

  assert.ok(filter.includes('[a0]asplit=3[voiceKey0][voiceKey1][voiceFinal]'), filter);
  assert.ok(filter.includes('[a1][voiceKey0]sidechaincompress='), filter);
  assert.ok(filter.includes('[a2][voiceKey1]sidechaincompress='), filter);
  assert.ok(
    filter.includes('[voiceFinal][ducked0][ducked1]amix=inputs=3:normalize=0:duration=longest,aresample=48000[aout]'),
    filter,
  );
});

it('keeps the flat audio mix when there is no voice audio', () => {
  const noVoice = makeProject({
    media: [audioMediaEntry('media-music', 'music')],
    clips: [],
    extraTracks: [
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
    ],
  });
  const noVoiceFilter = filterOf(buildPhase(noVoice));
  assert.ok(!noVoiceFilter.includes('sidechaincompress'), noVoiceFilter);
  assert.ok(!noVoiceFilter.includes('asplit'), noVoiceFilter);
  assert.ok(noVoiceFilter.includes('[a0]amix=inputs=1:normalize=0:duration=longest,aresample=48000[aout]'));

  const mutedVoice = makeProject({
    media: [audioMediaEntry('media-voice', 'voice'), audioMediaEntry('media-music', 'music')],
    clips: [],
    extraTracks: [
      audioTrackFor('t-voice', 'voice', false, [audioClipFor('vc', 'media-voice')]),
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
    ],
  });
  mutedVoice.tracks[1].muted = true;
  const mutedFilter = filterOf(buildPhase(mutedVoice));
  assert.ok(!mutedFilter.includes('sidechaincompress'), 'muted voice does not duck');
  assert.ok(!mutedFilter.includes('asplit'));
  assert.ok(mutedFilter.includes('amix=inputs=1:normalize=0'));

  const noDucking = makeProject({
    media: [audioMediaEntry('media-voice', 'voice'), audioMediaEntry('media-music', 'music')],
    clips: [],
    extraTracks: [
      audioTrackFor('t-voice', 'voice', false, [audioClipFor('vc', 'media-voice')]),
      audioTrackFor('t-music', 'music', false, [audioClipFor('mc', 'media-music')]),
    ],
  });
  const noDuckingFilter = filterOf(buildPhase(noDucking));
  assert.ok(!noDuckingFilter.includes('sidechaincompress'));
  assert.ok(noDuckingFilter.includes('[a0][a1]amix=inputs=2:normalize=0:duration=longest,aresample=48000[aout]'));
});

it('mixes multiple voice clips into one bus before ducking', () => {
  const project = makeProject({
    media: [audioMediaEntry('media-voice', 'voice'), audioMediaEntry('media-music', 'music')],
    clips: [],
    extraTracks: [
      audioTrackFor('t-voice', 'voice', false, [
        makeClip({ id: 'v1', type: 'audio', mediaId: 'media-voice', startFrame: 0, durationFrames: 15 }),
        makeClip({ id: 'v2', type: 'audio', mediaId: 'media-voice', startFrame: 15, durationFrames: 15 }),
      ]),
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
    ],
  });
  const filter = filterOf(buildPhase(project));
  assert.ok(
    filter.includes('[a0][a1]amix=inputs=2:normalize=0:duration=longest,aresample=48000[a3]'),
    filter,
  );
  assert.ok(filter.includes('[a3]asplit=2[voiceKey0][voiceFinal]'), filter);
  assert.ok(filter.includes('[a2][voiceKey0]sidechaincompress='), filter);
});

it('ducks from a hidden video track that still carries voice audio', () => {
  const project = makeProject({
    media: [mediaEntry({ hasAudio: true }), audioMediaEntry('media-music', 'music')],
    clips: [
      makeClip({ id: 'hidden-voice', type: 'video', mediaId: 'media-video', startFrame: 0, durationFrames: 30 }),
    ],
    extraTracks: [
      audioTrackFor('t-music', 'music', true, [audioClipFor('mc', 'media-music')]),
    ],
  });
  project.tracks[0].hidden = true;
  project.tracks[0].role = 'voice';
  const filter = filterOf(buildPhase(project));
  assert.ok(filter.includes('[a0]asplit=2[voiceKey0][voiceFinal]'), filter);
  assert.ok(filter.includes('[a1][voiceKey0]sidechaincompress='), filter);
});

it('exports ducked voice/music audio and verifies the volume drop', { skip: toolSkip }, async () => {
  const buildProject = (ducking) => makeProject({
    media: [voiceMedia, musicMedia],
    clips: [],
    extraTracks: [
      audioTrackFor(
        'duck-voice', 'voice', false,
        [makeClip({ id: 'duck-vc', type: 'audio', mediaId: voiceMedia.id, startFrame: 0, durationFrames: 30 })],
      ),
      audioTrackFor(
        'duck-music', 'music', ducking,
        [makeClip({ id: 'duck-mc', type: 'audio', mediaId: musicMedia.id, startFrame: 0, durationFrames: 30 })],
      ),
    ],
  });

  const referencePath = path.join(exportTemp, 'duck-reference.mp4');
  const duckedPath = path.join(exportTemp, 'duck-applied.mp4');
  await runExport({
    project: buildProject(false),
    projectRoot: exportProjectRoot,
    outputPath: referencePath,
  });
  await runExport({
    project: buildProject(true),
    projectRoot: exportProjectRoot,
    outputPath: duckedPath,
  });

  const probe = await probeMedia(duckedPath);
  assert.equal(probe.kind, 'video');
  assert.equal(probe.hasAudio, true);
  assert.ok(probe.durationSeconds > 0.5 && probe.durationSeconds < 1.5);

  const parsed = JSON.parse(await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_streams', duckedPath,
  ]));
  assert.ok(parsed.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(parsed.streams.some((stream) => stream.codec_type === 'audio'));

  const referenceDb = await meanVolumeDb(referencePath);
  const duckedDb = await meanVolumeDb(duckedPath);
  assert.ok(
    duckedDb < referenceDb - 1,
    `ducking should reduce mean volume (reference ${referenceDb} dB, ducked ${duckedDb} dB)`,
  );
  assert.ok(duckedDb > -60, 'the ducked mix stays audible');
});
