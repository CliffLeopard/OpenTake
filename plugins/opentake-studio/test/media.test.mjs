import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  MediaError,
  ensureThumbnail,
  importToProject,
  isMediaFile,
  mediaExtensions,
  mediaFilePath,
  mediaKindForFile,
  mediaMimeType,
  probeMedia,
  resetToolCache,
  resolveTools,
  runFfmpeg,
  runFfprobe,
  scanMediaFolder,
} from '../lib/media.js';

const initialTools = resolveTools();
const toolSkip = initialTools.available ? false : 'ffmpeg/ffprobe are not available on this machine';
const FIXTURE_FPS = 30;
const FIXTURE_DURATION_SECONDS = 2;
const EXPECTED_FRAMES = FIXTURE_FPS * FIXTURE_DURATION_SECONDS;

let tempRoot = null;
let sourceDir = null;
let videoPath = null;
let audioPath = null;
let imagePath = null;
let weirdNamePath = null;

function relativeName(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

async function expectJpeg(filePath) {
  const bytes = await readFile(filePath);
  assert.ok(bytes.length > 100, `thumbnail should have content: ${filePath}`);
  assert.equal(bytes[0], 0xff, 'JPEG SOI marker');
  assert.equal(bytes[1], 0xd8, 'JPEG SOI marker');
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ots-media-test-'));
  sourceDir = path.join(tempRoot, 'source');
  await mkdir(sourceDir, { recursive: true });
  if (!initialTools.available) return;

  videoPath = path.join(sourceDir, 'clip.mp4');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=30:duration=${FIXTURE_DURATION_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FIXTURE_DURATION_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    videoPath,
  ]);

  audioPath = path.join(sourceDir, 'sound.m4a');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=660:duration=${FIXTURE_DURATION_SECONDS}`,
    audioPath,
  ]);

  imagePath = path.join(sourceDir, 'card.png');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1',
    '-frames:v', '1',
    imagePath,
  ]);

  weirdNamePath = path.join(sourceDir, 'my clip [1] é.mp4');
  await copyFile(videoPath, weirdNamePath);

  const nested = path.join(sourceDir, 'nested');
  await mkdir(nested, { recursive: true });
  await copyFile(imagePath, path.join(nested, 'poster.png'));

  await writeFile(path.join(sourceDir, 'notes.txt'), 'not media');

  for (const [directory, fileName] of [
    ['.hidden', 'secret.mp4'],
    ['media', 'ignored.mp4'],
    ['thumbnails', 'ignored.png'],
    ['exports', 'ignored.m4a'],
  ]) {
    const fullDirectory = path.join(sourceDir, directory);
    await mkdir(fullDirectory, { recursive: true });
    await copyFile(
      fileName.endsWith('.mp4') ? videoPath : fileName.endsWith('.png') ? imagePath : audioPath,
      path.join(fullDirectory, fileName),
    );
  }
});

after(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

it('resolveTools reports a stable cached shape', () => {
  resetToolCache();
  const first = resolveTools();
  assert.equal(typeof first.available, 'boolean');
  assert.ok(first.ffmpeg === null || (typeof first.ffmpeg === 'string' && path.isAbsolute(first.ffmpeg)));
  assert.ok(first.ffprobe === null || (typeof first.ffprobe === 'string' && path.isAbsolute(first.ffprobe)));
  assert.ok(first.version === null || typeof first.version === 'string');
  assert.equal(first.available, first.ffmpeg !== null && first.ffprobe !== null);

  const second = resolveTools();
  assert.deepEqual(second, first);
  resetToolCache();
});

it('resolveTools honors the environment overrides, then PATH, and caches', () => {
  const saved = {
    ffmpeg: process.env.OPENTAKE_STUDIO_FFMPEG,
    ffprobe: process.env.OPENTAKE_STUDIO_FFPROBE,
  };
  try {
    const actual = resolveTools();
    if (actual.available) {
      process.env.OPENTAKE_STUDIO_FFMPEG = actual.ffmpeg;
      process.env.OPENTAKE_STUDIO_FFPROBE = actual.ffprobe;
      resetToolCache();
      const overridden = resolveTools();
      assert.equal(overridden.ffmpeg, actual.ffmpeg);
      assert.equal(overridden.ffprobe, actual.ffprobe);

      // Cached results ignore later environment changes until resetToolCache().
      process.env.OPENTAKE_STUDIO_FFMPEG = '/definitely/not/a/real/ffmpeg';
      assert.equal(resolveTools().ffmpeg, actual.ffmpeg);

      // A stale override falls back to PATH after a cache reset.
      resetToolCache();
      assert.equal(resolveTools().ffmpeg, actual.ffmpeg);
      assert.equal(resolveTools().ffprobe, actual.ffprobe);
    } else {
      process.env.OPENTAKE_STUDIO_FFMPEG = '/definitely/not/a/real/ffmpeg';
      process.env.OPENTAKE_STUDIO_FFPROBE = '/definitely/not/a/real/ffprobe';
      resetToolCache();
      const missing = resolveTools();
      assert.equal(missing.available, false);
      assert.equal(missing.ffmpeg, null);
      assert.equal(missing.ffprobe, null);
    }
  } finally {
    if (saved.ffmpeg === undefined) delete process.env.OPENTAKE_STUDIO_FFMPEG;
    else process.env.OPENTAKE_STUDIO_FFMPEG = saved.ffmpeg;
    if (saved.ffprobe === undefined) delete process.env.OPENTAKE_STUDIO_FFPROBE;
    else process.env.OPENTAKE_STUDIO_FFPROBE = saved.ffprobe;
    resetToolCache();
  }
});

it('reports missing tools instead of pretending to work', async () => {
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

    const tools = resolveTools();
    assert.equal(tools.available, false);
    assert.equal(tools.ffmpeg, null);
    assert.equal(tools.version, null);

    await assert.rejects(
      runFfmpeg(['-version']),
      (error) => error instanceof MediaError && error.code === 'ffmpeg-unavailable',
    );
    await assert.rejects(
      runFfprobe(['-version']),
      (error) => error instanceof MediaError && error.code === 'ffprobe-unavailable',
    );
    await assert.rejects(
      probeMedia(videoPath ?? path.join(tempRoot, 'missing.mp4')),
      (error) => error instanceof MediaError && error.code === 'ffprobe-unavailable',
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
// Pure classification helpers
// ---------------------------------------------------------------------------

it('classifies media kinds from file names', () => {
  assert.equal(mediaKindForFile('clip.MP4'), 'video');
  assert.equal(mediaKindForFile('movie.mov'), 'video');
  assert.equal(mediaKindForFile('take.webm'), 'video');
  assert.equal(mediaKindForFile('sound.m4a'), 'audio');
  assert.equal(mediaKindForFile('voice.FLAC'), 'audio');
  assert.equal(mediaKindForFile('card.png'), 'image');
  assert.equal(mediaKindForFile('photo.JPEG'), 'image');
  assert.equal(mediaKindForFile('notes.txt'), null);
  assert.equal(mediaKindForFile('archive.zip'), null);
  assert.equal(mediaKindForFile('no-extension'), null);
  assert.equal(mediaKindForFile(''), null);

  assert.equal(isMediaFile('clip.mp4'), true);
  assert.equal(isMediaFile('notes.txt'), false);
  assert.equal(isMediaFile(''), false);

  const extensions = mediaExtensions();
  assert.ok(extensions.includes('mp4'));
  assert.ok(extensions.includes('m4a'));
  assert.ok(extensions.includes('png'));
  assert.equal(new Set(extensions).size, extensions.length);
});

it('maps media MIME types', () => {
  assert.equal(mediaMimeType('clip.mp4'), 'video/mp4');
  assert.equal(mediaMimeType('clip.mov'), 'video/quicktime');
  assert.equal(mediaMimeType('sound.m4a'), 'audio/mp4');
  assert.equal(mediaMimeType('card.jpg'), 'image/jpeg');
  assert.equal(mediaMimeType('unknown.bin'), 'application/octet-stream');
  assert.equal(mediaMimeType(''), 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

it('probes video, audio and image media with ffprobe', { skip: toolSkip }, async () => {
  const video = await probeMedia(videoPath);
  assert.equal(video.kind, 'video');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.fps, 30);
  assert.equal(video.hasAudio, true);
  assert.ok(video.durationSeconds > 1.5 && video.durationSeconds < 2.5, `duration ${video.durationSeconds}`);
  assert.ok(video.sizeBytes > 1000);

  const audio = await probeMedia(audioPath);
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.width, null);
  assert.equal(audio.height, null);
  assert.equal(audio.fps, null);
  assert.equal(audio.hasAudio, true);
  assert.ok(audio.durationSeconds > 1.5 && audio.durationSeconds < 2.5);

  const image = await probeMedia(imagePath);
  assert.equal(image.kind, 'image');
  assert.equal(image.durationSeconds, null);
  assert.equal(image.width, 320);
  assert.equal(image.height, 180);
  assert.equal(image.fps, null);
  assert.equal(image.hasAudio, false);
});

it('reports unreadable and unsupported media clearly', { skip: toolSkip }, async () => {
  await assert.rejects(
    probeMedia(path.join(sourceDir, 'does-not-exist.mp4')),
    (error) => error instanceof MediaError && error.code === 'io-error',
  );

  const textPath = path.join(sourceDir, 'notes.txt');
  await assert.rejects(
    probeMedia(textPath),
    (error) => error instanceof MediaError && ['probe-failed', 'unsupported-media'].includes(error.code),
  );
});

it('runFfprobe returns raw ffprobe JSON stdout', { skip: toolSkip }, async () => {
  const stdout = await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', videoPath,
  ]);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.streams));
  assert.ok(parsed.streams.some((stream) => stream.codec_type === 'video'));
});

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

it('scans folders recursively while skipping hidden and generated directories', { skip: toolSkip }, async () => {
  const files = await scanMediaFolder(sourceDir);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => path.isAbsolute(file)));
  assert.deepEqual(files, [...files].sort());

  const names = files.map((file) => relativeName(sourceDir, file));
  assert.ok(names.includes('clip.mp4'));
  assert.ok(names.includes('sound.m4a'));
  assert.ok(names.includes('card.png'));
  assert.ok(names.includes('notes.txt'));
  assert.ok(names.includes('nested/poster.png'));
  assert.ok(names.includes('my clip [1] é.mp4'));

  assert.ok(!names.some((name) => name.startsWith('.hidden/')));
  assert.ok(!names.some((name) => name.startsWith('media/')));
  assert.ok(!names.some((name) => name.startsWith('thumbnails/')));
  assert.ok(!names.some((name) => name.startsWith('exports/')));
  assert.ok(!names.some((name) => name.split('/').some((segment) => segment.startsWith('.'))));
});

it('rejects a missing or non-directory scan path', async () => {
  await assert.rejects(
    scanMediaFolder(path.join(tempRoot, 'no-such-folder')),
    (error) => error instanceof MediaError && error.code === 'io-error',
  );
  const filePath = path.join(tempRoot, 'scan-file.txt');
  await writeFile(filePath, 'not a directory');
  await assert.rejects(
    scanMediaFolder(filePath),
    (error) => error instanceof MediaError && error.code === 'invalid-input',
  );
});

// ---------------------------------------------------------------------------
// Project media paths
// ---------------------------------------------------------------------------

it('resolves media files inside media/ and rejects escapes', () => {
  const projectRoot = path.join(tempRoot, 'path-check');
  assert.equal(
    mediaFilePath(projectRoot, { fileName: 'abc.mp4' }),
    path.join(projectRoot, 'media', 'abc.mp4'),
  );
  assert.equal(
    mediaFilePath(projectRoot, { fileName: 'sub/dir/clip.mp4' }),
    path.join(projectRoot, 'media', 'sub', 'dir', 'clip.mp4'),
  );

  for (const fileName of ['../evil.mp4', '../../etc/passwd', '/etc/passwd', '..\\evil.mp4']) {
    assert.throws(
      () => mediaFilePath(projectRoot, { fileName }),
      (error) => error instanceof MediaError && error.code === 'invalid-path',
      `expected escape rejection for ${fileName}`,
    );
  }

  assert.throws(
    () => mediaFilePath(projectRoot, { fileName: '' }),
    (error) => error instanceof MediaError && error.code === 'invalid-input',
  );
  assert.throws(
    () => mediaFilePath(projectRoot, null),
    (error) => error instanceof MediaError && error.code === 'invalid-input',
  );
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

it('imports media into <root>/media with hard links, ids and probed metadata', { skip: toolSkip }, async () => {
  const projectRoot = path.join(tempRoot, 'project-import');
  const project = { fps: FIXTURE_FPS, media: [] };
  const result = await importToProject({ projectRoot, folderPath: sourceDir, project });

  assert.equal(result.media.length, 5);
  assert.equal(result.imported.length, 5);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].endsWith('notes.txt'));

  const byName = new Map(result.media.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('clip.mp4').kind, 'video');
  assert.equal(byName.get('sound.m4a').kind, 'audio');
  assert.equal(byName.get('card.png').kind, 'image');
  assert.equal(byName.get('my clip [1] é.mp4').kind, 'video');
  assert.equal(byName.get('poster.png').kind, 'image');

  const ids = new Set();
  for (const entry of result.media) {
    assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(!ids.has(entry.id));
    ids.add(entry.id);
    assert.ok(entry.fileName.startsWith(`${entry.id}-`), entry.fileName);
    assert.ok(!entry.fileName.includes('/'));
    assert.ok(!entry.fileName.includes('\\'));
    assert.ok(Number.isFinite(entry.importedAt));
    const destination = path.join(projectRoot, 'media', entry.fileName);
    const destinationInfo = await stat(destination);
    assert.ok(destinationInfo.size > 0);
    assert.equal(destinationInfo.size, entry.sizeBytes);
  }

  const video = byName.get('clip.mp4');
  assert.equal(video.durationFrames, EXPECTED_FRAMES);
  assert.ok(Math.abs(video.sourceDurationSeconds - FIXTURE_DURATION_SECONDS) < 0.2);
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.hasAudio, true);

  const audio = byName.get('sound.m4a');
  assert.equal(audio.durationFrames, EXPECTED_FRAMES);
  assert.equal(audio.hasAudio, true);
  assert.equal(audio.width, null);

  const image = byName.get('card.png');
  assert.equal(image.durationFrames, null);
  assert.equal(image.sourceDurationSeconds, null);

  // Same device => the import should be a hard link (inode shared).
  const sourceInfo = await stat(videoPath);
  const destinationInfo = await stat(path.join(projectRoot, 'media', video.fileName));
  if (sourceInfo.dev === destinationInfo.dev) {
    assert.equal(destinationInfo.ino, sourceInfo.ino, 'import should hard-link when possible');
    assert.ok(destinationInfo.nlink >= 2);
  }

  // Scanning the project root must skip its own media directory.
  assert.deepEqual(await scanMediaFolder(projectRoot), []);

  // Repeated imports of the same name+size are skipped (MVP dedupe).
  const repeated = await importToProject({
    projectRoot,
    folderPath: sourceDir,
    project: { fps: FIXTURE_FPS, media: result.media },
  });
  assert.equal(repeated.media.length, 0);
  assert.equal(repeated.imported.length, 0);
  assert.equal(repeated.skipped.length, 6);
});

it('computes durationFrames with the project fps', { skip: toolSkip }, async () => {
  const singleDir = path.join(tempRoot, 'single-source');
  await mkdir(singleDir, { recursive: true });
  await copyFile(videoPath, path.join(singleDir, 'only.mp4'));

  const projectRoot = path.join(tempRoot, 'project-fps24');
  const result = await importToProject({
    projectRoot,
    folderPath: singleDir,
    project: { fps: 24, media: [] },
  });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].durationFrames, 48);
});

it('rejects relative import paths', async () => {
  await assert.rejects(
    importToProject({ projectRoot: 'relative/project', folderPath: sourceDir, project: { fps: 30, media: [] } }),
    (error) => error instanceof MediaError && error.code === 'invalid-input',
  );
  await assert.rejects(
    importToProject({ projectRoot: path.join(tempRoot, 'x'), folderPath: 'relative/source', project: { fps: 30, media: [] } }),
    (error) => error instanceof MediaError && error.code === 'invalid-input',
  );
});

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

it('generates cached JPEG thumbnails for video, image and audio media', { skip: toolSkip }, async () => {
  const projectRoot = path.join(tempRoot, 'project-thumbs');
  const imported = await importToProject({
    projectRoot,
    folderPath: sourceDir,
    project: { fps: FIXTURE_FPS, media: [] },
  });
  const byName = new Map(imported.media.map((entry) => [entry.name, entry]));

  for (const name of ['clip.mp4', 'card.png', 'sound.m4a']) {
    const media = byName.get(name);
    const thumbnail = await ensureThumbnail({ projectRoot, media });
    assert.ok(path.isAbsolute(thumbnail));
    assert.equal(path.dirname(thumbnail), path.join(projectRoot, 'thumbnails'));
    assert.equal(path.extname(thumbnail), '.jpg');
    await expectJpeg(thumbnail);

    const firstInfo = await stat(thumbnail);
    const cached = await ensureThumbnail({ projectRoot, media });
    assert.equal(cached, thumbnail);
    const secondInfo = await stat(thumbnail);
    assert.equal(secondInfo.mtimeMs, firstInfo.mtimeMs, 'cached thumbnail should not be regenerated');
  }

  // A supplied atFrame produces a thumbnail for a fresh media id.
  const video = byName.get('clip.mp4');
  const alternate = { ...video, id: randomUUID() };
  const alternateThumbnail = await ensureThumbnail({ projectRoot, media: alternate, atFrame: 15 });
  await expectJpeg(alternateThumbnail);
});

it('rejects invalid thumbnail inputs', async () => {
  await assert.rejects(
    ensureThumbnail({ projectRoot: path.join(tempRoot, 'bad-thumb'), media: { id: 'x', fileName: '../escape.mp4' } }),
    (error) => error instanceof MediaError && error.code === 'invalid-path',
  );
});
