import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { indexMediaVision, readVisionIndex } from '../lib/vision.js';

const exec = promisify(execFile);
const FFMPEG = process.env.OPENTAKE_STUDIO_FFMPEG ?? 'ffmpeg';
const HAS_FFMPEG = await exec(FFMPEG, ['-version']).then(() => true, () => false);
const skip = HAS_FFMPEG ? {} : { skip: 'ffmpeg is not available' };

async function fixture(root) {
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir, { recursive: true });
  const fileName = 'frame.mp4';
  await exec(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(mediaDir, fileName),
  ]);
  return {
    id: 'vision-media',
    name: 'frame.mp4',
    kind: 'video',
    fileName,
    durationFrames: 30,
    sourceDurationSeconds: 1,
    width: 160,
    height: 90,
    hasAudio: false,
    sizeBytes: 1,
    importedAt: Date.now(),
  };
}

test('indexes a thumbnail with a vision provider and stores the description', skip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ots-vision-'));
  const media = await fixture(root);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.url, '/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'A colour test pattern.' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const saved = { url: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const record = await indexMediaVision({
      ctx: { get: () => undefined },
      projectRoot: root,
      media,
    });
    assert.equal(record.description, 'A colour test pattern.');
    assert.equal(record.mediaId, media.id);
    const records = await readVisionIndex(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].description, 'A colour test pattern.');
  } finally {
    if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('reports vision-unavailable without a credential', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      indexMediaVision({
        ctx: { get: () => undefined },
        projectRoot: '/tmp/none',
        media: { id: 'm', name: 'a.mp4', kind: 'video', fileName: 'a.mp4', durationFrames: 30 },
      }),
      (error) => error.code === 'vision-unavailable',
    );
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
