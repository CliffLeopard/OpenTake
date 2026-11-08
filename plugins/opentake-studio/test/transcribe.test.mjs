import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject } from '../lib/model.js';
import {
  TRANSCRIPTS_DIR,
  readTranscripts,
  transcribeMedia,
  transcriptToCaptionSegments,
} from '../lib/transcribe.js';

const exec = promisify(execFile);
const FFMPEG = process.env.OPENTAKE_STUDIO_FFMPEG ?? 'ffmpeg';
const HAS_FFMPEG = await exec(FFMPEG, ['-version']).then(() => true, () => false);
const skip = HAS_FFMPEG ? {} : { skip: 'ffmpeg is not available' };

async function fixture(root) {
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir, { recursive: true });
  const fileName = 'audio.mp4';
  await exec(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(mediaDir, fileName),
  ]);
  return {
    id: 'media-1',
    name: 'audio.mp4',
    kind: 'video',
    fileName,
    durationFrames: 60,
    sourceDurationSeconds: 2,
    width: 160,
    height: 90,
    hasAudio: true,
    sizeBytes: 1,
    importedAt: Date.now(),
  };
}

function fakeCtx() {
  return {
    get(name) {
      if (name === 'credentials') return { resolve: async () => undefined };
      return undefined;
    },
  };
}

test('transcribes through an OpenAI-compatible endpoint and stores JSON', skip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ots-transcribe-test-'));
  const project = createProject({ name: 'ASR', fps: 30 });
  const media = await fixture(root);
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      calls.push({ url: request.url, auth: request.headers.authorization, type: request.headers['content-type'] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        language: 'en',
        text: 'Hello world',
        segments: [
          { start: 0, end: 1, text: 'Hello' },
          { start: 1, end: 2, text: 'world' },
        ],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previous = process.env.OPENTAKE_STUDIO_ASR_URL;
  process.env.OPENTAKE_STUDIO_ASR_URL = `http://127.0.0.1:${port}/transcribe`;
  try {
    const transcript = await transcribeMedia({ ctx: fakeCtx(), project, projectRoot: root, media });
    assert.equal(transcript.text, 'Hello world');
    assert.equal(transcript.segments.length, 2);
    assert.equal(transcript.language, 'en');
    assert.equal(calls.length, 1);
    assert.match(calls[0].type, /multipart\/form-data/);
    const stored = JSON.parse(
      await readFile(path.join(root, TRANSCRIPTS_DIR, `${media.id}.json`), 'utf8'),
    );
    assert.equal(stored.text, 'Hello world');
    const listed = await readTranscripts(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].mediaId, media.id);
  } finally {
    if (previous === undefined) delete process.env.OPENTAKE_STUDIO_ASR_URL;
    else process.env.OPENTAKE_STUDIO_ASR_URL = previous;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('converts transcript segments into a caption clip shape', () => {
  const clip = transcriptToCaptionSegments(
    {
      segments: [
        { startSeconds: 1, endSeconds: 2, text: 'One' },
        { startSeconds: 3, endSeconds: 4.5, text: 'Two' },
      ],
    },
    30,
  );
  assert.equal(clip.startFrame, 30);
  assert.equal(clip.durationFrames, 105);
  assert.deepEqual(clip.segments, [
    { startFrame: 0, durationFrames: 30, text: 'One' },
    { startFrame: 60, durationFrames: 45, text: 'Two' },
  ]);
});

test('reports asr-unavailable without a key for non-loopback endpoints', async () => {
  const previousUrl = process.env.OPENTAKE_STUDIO_ASR_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENTAKE_STUDIO_ASR_URL = 'https://example.invalid/v1/audio/transcriptions';
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      transcribeMedia({
        ctx: fakeCtx(),
        project: createProject({ name: 'ASR' }),
        projectRoot: '/tmp/does-not-matter',
        media: { id: 'm', name: 'a.mp4', kind: 'video', fileName: 'a.mp4', durationFrames: 30 },
      }),
      (error) => error.code === 'asr-unavailable',
    );
  } finally {
    if (previousUrl === undefined) delete process.env.OPENTAKE_STUDIO_ASR_URL;
    else process.env.OPENTAKE_STUDIO_ASR_URL = previousUrl;
    if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
  }
});
