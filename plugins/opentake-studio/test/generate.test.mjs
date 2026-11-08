import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject } from '../lib/model.js';
import { generateImage, generateSpeech, generationProviders } from '../lib/generate.js';

const exec = promisify(execFile);
const FFMPEG = process.env.OPENTAKE_STUDIO_FFMPEG ?? 'ffmpeg';
const HAS_FFMPEG = await exec(FFMPEG, ['-version']).then(() => true, () => false);
const skip = HAS_FFMPEG ? {} : { skip: 'ffmpeg is not available' };

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function fakeCtx() {
  return { get: () => undefined };
}

test('generates an image through an OpenAI-compatible endpoint', skip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ots-generate-'));
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.url, '/images/generations');
      assert.equal(request.headers.authorization, 'Bearer test-key');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'gpt-image-1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: PNG_1X1 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const saved = { url: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    await mkdir(path.join(root, 'media'), { recursive: true });
    const media = await generateImage({ ctx: fakeCtx(), projectRoot: root, prompt: 'a red square' });
    assert.equal(media.kind, 'image');
    assert.equal(media.width, 1);
    assert.equal(media.height, 1);
    assert.match(media.name, /^generated-/);
    const bytes = await readFile(path.join(root, 'media', media.fileName));
    assert.equal(bytes.toString('base64'), PNG_1X1);
    const providers = await generationProviders(fakeCtx());
    assert.equal(providers.image.configured, true);
  } finally {
    if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('generates speech through an OpenAI-compatible endpoint', skip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ots-generate-'));
  const fixture = path.join(root, 'fixture.mp3');
  await exec(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    fixture,
  ]);
  const audio = await readFile(fixture);
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      assert.equal(request.url, '/audio/speech');
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.end(audio);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const saved = { url: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const project = createProject({ name: 'TTS', fps: 30 });
    const media = await generateSpeech({
      ctx: fakeCtx(),
      project,
      projectRoot: root,
      text: 'Hello from DSH',
    });
    assert.equal(media.kind, 'audio');
    assert.ok(media.durationFrames >= 1);
    assert.ok(media.sizeBytes > 0);
  } finally {
    if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('reports generation-unavailable without a credential', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      generateImage({ ctx: fakeCtx(), projectRoot: '/tmp/noop', prompt: 'x' }),
      (error) => error.code === 'generation-unavailable',
    );
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
