import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';

import { ExportError, buildExportArgs, runExport } from '../lib/export.js';
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
});

after(async () => {
  if (exportTemp !== null) await rm(exportTemp, { recursive: true, force: true });
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
