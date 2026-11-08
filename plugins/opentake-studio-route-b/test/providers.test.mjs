import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import {
  ProviderError,
  buildRequest,
  createProviderClient,
  describeConfig,
  executeAsr,
  providerConfigFromEnv,
  redactSecrets,
  resolveProviderConfig,
} from '../lib/providers.js';

const SECRET = 'test-secret-do-not-log';
const VIDEO_SECRET = 'video-secret-do-not-log';
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const MP4_BYTES = Buffer.from('fake-mp4-bytes');
const AUDIO_BYTES = Buffer.from('fake-mp3-bytes');

let server;
let base;
let requests = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      body: body.toString('utf8'),
    });
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (path === '/asr') {
      if (req.headers.authorization !== `Bearer ${SECRET}` && req.headers.authorization !== undefined) {
        return json(res, 401, { error: { message: 'bad authorization' } });
      }
      return json(res, 200, {
        text: 'hello world',
        language: 'en',
        model: 'whisper-1',
        segments: [
          { start: 0, end: 0.5, text: 'hello' },
          { start: 0.5, end: 1, text: 'world' },
        ],
        words: [
          { word: 'hello', start: 0, end: 0.5 },
          { word: 'world', start: 0.5, end: 1 },
        ],
      });
    }
    if (path === '/chat') {
      return json(res, 200, {
        model: 'gpt-test',
        choices: [{ message: { role: 'assistant', content: 'chat answer' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
    }
    if (path === '/image') {
      return json(res, 200, { data: [{ b64_json: PNG_BYTES.toString('base64'), revised_prompt: 'revised' }] });
    }
    if (path === '/image-url') {
      return json(res, 200, { data: [{ url: `${base}/asset.png` }] });
    }
    if (path === '/video') {
      return json(res, 200, { video_url: `${base}/asset.mp4`, request_id: 'req-1' });
    }
    if (path === '/video-b64') {
      return json(res, 200, { video_b64: MP4_BYTES.toString('base64') });
    }
    if (path === '/speech') {
      res.statusCode = 200;
      res.setHeader('content-type', 'audio/mpeg');
      res.end(AUDIO_BYTES);
      return;
    }
    if (path === '/asset.png') {
      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.end(PNG_BYTES);
      return;
    }
    if (path === '/asset.mp4') {
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp4');
      res.end(MP4_BYTES);
      return;
    }
    if (path === '/malformed') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('this is not json');
      return;
    }
    if (path === '/invalid-asr') {
      return json(res, 200, { segments: [], text: '' });
    }
    if (path === '/invalid-image') {
      return json(res, 200, { data: [] });
    }
    if (path === '/invalid-speech') {
      res.statusCode = 200;
      res.setHeader('content-type', 'audio/mpeg');
      res.end(Buffer.alloc(0));
      return;
    }
    if (path === '/echo-auth') {
      return json(res, 401, {
        error: { message: `provider rejected ${req.headers.authorization ?? 'missing'}` },
      });
    }
    if (path === '/slow') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return json(res, 200, { ok: true });
    }
    if (path === '/retry') {
      const retryCount = (requests.filter((request) => request.path.startsWith('/retry')).length);
      if (retryCount === 1) return json(res, 503, { error: { message: 'temporary failure' } });
      return json(res, 200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    }
    if (path === '/status/401') return json(res, 401, { error: { message: 'unauthorized' } });
    if (path === '/status/429') return json(res, 429, { error: { message: 'slow down' } });
    if (path === '/status/500') return json(res, 500, { error: { message: 'boom' } });
    if (path === '/status/503') return json(res, 503, { error: { message: 'unavailable' } });
    if (path === '/large') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', String(10 * 1024 * 1024));
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }));
      return;
    }
    return json(res, 404, { error: { message: 'not found' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server !== undefined) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  requests = [];
});

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function config(kind, path, extra = {}) {
  return {
    kind,
    url: `${base}${path}`,
    model: kind === 'video' ? 'fal-ai/test-video' : kind === 'asr' ? 'whisper-1' : 'test-model',
    key: kind === 'video' ? VIDEO_SECRET : SECRET,
    authScheme: kind === 'video' ? 'Key' : 'Bearer',
    ...extra,
  };
}

function client(kind, path, options = {}, extra = {}) {
  return createProviderClient({
    kind,
    config: config(kind, path, extra),
    retries: 0,
    timeoutMs: 2_000,
    ...options,
  });
}

test('providerConfigFromEnv reads the documented env contract without exposing the key', () => {
  const env = {
    OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    OPENAI_API_KEY: 'env-key',
    OPENTAKE_ASR_MODEL: 'whisper-large',
  };
  const asr = providerConfigFromEnv('asr', { env });
  assert.equal(asr.url, 'http://127.0.0.1:1/v1/audio/transcriptions');
  assert.equal(asr.model, 'whisper-large');
  assert.equal(asr.configured, true);
  assert.equal(asr.key, 'env-key');

  const described = describeConfig(asr);
  assert.equal(described.hasKey, true);
  assert.equal(JSON.stringify(described).includes('env-key'), false);

  const image = providerConfigFromEnv('image', { env: { ...env, OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: '' } });
  assert.equal(image.configured, false);
  assert.equal(image.key, null);
});

test('resolveProviderConfig accepts Host overrides, DSH-style credentials and loopback keyless config', async () => {
  const resolved = await resolveProviderConfig('image', {
    env: {},
    overrides: { url: `${base}/image`, keyRef: 'MY_IMAGE_KEY' },
    credentials: { resolve: async (ref) => ({ value: ref === 'MY_IMAGE_KEY' ? 'credential-key' : null }) },
  });
  assert.equal(resolved.key, 'credential-key');
  assert.equal(resolved.configured, true);

  const loopback = await resolveProviderConfig('asr', {
    env: { OPENTAKE_ASR_URL: `${base}/asr` },
    overrides: {},
  });
  assert.equal(loopback.key, null);
  assert.equal(loopback.configured, true);

  await assert.rejects(
    () => resolveProviderConfig('image', { env: {}, overrides: { url: 'https://user:pass@example.test/v1' } }),
    (error) => error instanceof ProviderError && error.code === 'provider-invalid-config',
  );
});

test('ASR success normalizes text/segments/words and sends multipart + bearer auth', async () => {
  const result = await client('asr', '/asr').transcribe({
    audio: Buffer.from('wav bytes'),
    filename: 'clip.wav',
    language: 'en',
  });
  assert.equal(result.kind, 'asr');
  assert.equal(result.text, 'hello world');
  assert.equal(result.segments.length, 2);
  assert.equal(result.words.length, 2);
  assert.equal(result.language, 'en');
  assert.equal(requests[0].authorization, `Bearer ${SECRET}`);
  assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(requests[0].body, /name="file"/);
  assert.match(requests[0].body, /name="model"/);
  assert.match(requests[0].body, /whisper-1/);
  assert.match(requests[0].body, /name="response_format"/);
  assert.match(requests[0].body, /verbose_json/);
});

test('executeAsr convenience function uses the same request path', async () => {
  const result = await executeAsr(config('asr', '/asr'), {
    audio: Buffer.from('wav bytes'),
    filename: 'clip.wav',
  }, { retries: 0, timeoutMs: 2_000 });
  assert.equal(result.text, 'hello world');
});

test('chat success returns assistant text', async () => {
  const result = await client('chat', '/chat').chat({
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    maxTokens: 32,
  });
  assert.equal(result.kind, 'chat');
  assert.equal(result.text, 'chat answer');
  assert.equal(result.usage.completion_tokens, 2);
});

test('buildRequest shapes are deterministic for JSON providers', () => {
  const image = buildRequest('image', config('image', '/image'), { prompt: 'a cat', size: '512x512' });
  const imageBody = JSON.parse(image.init.body);
  assert.deepEqual(imageBody, {
    model: 'test-model',
    prompt: 'a cat',
    size: '512x512',
    n: 1,
    response_format: 'b64_json',
  });
  assert.equal(image.init.headers.authorization, `Bearer ${SECRET}`);

  const speech = buildRequest('speech', config('speech', '/speech'), { text: 'speak', voice: 'alloy', format: 'mp3' });
  assert.deepEqual(JSON.parse(speech.init.body), {
    model: 'test-model',
    input: 'speak',
    voice: 'alloy',
    response_format: 'mp3',
  });

  const video = buildRequest('video', config('video', '/video'), { prompt: 'waves' });
  assert.deepEqual(JSON.parse(video.init.body), {
    model: 'fal-ai/test-video',
    prompt: 'waves',
  });
  assert.equal(video.init.headers.authorization, `Key ${VIDEO_SECRET}`);
});

test('image generation returns decoded png bytes and media type', async () => {
  const result = await client('image', '/image').generateImage({ prompt: 'a cat' });
  assert.equal(result.kind, 'image');
  assert.ok(result.bytes.equals(PNG_BYTES));
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.url, null);
  assert.equal(result.revisedPrompt, 'revised');
});

test('image URL result can be downloaded without forwarding provider auth', async () => {
  const provider = client('image', '/image-url');
  const result = await provider.generateImage({ prompt: 'a cat' });
  assert.ok(result.url.endsWith('/asset.png'));
  const downloaded = await provider.download(result.url);
  assert.ok(downloaded.bytes.equals(PNG_BYTES));
  assert.equal(downloaded.mediaType, 'image/png');
  const assetRequest = requests.find((request) => request.path === '/asset.png');
  assert.equal(assetRequest.authorization, null);
});

test('speech success returns audio bytes and the requested extension', async () => {
  const result = await client('speech', '/speech').generateSpeech({ text: 'hello', format: 'mp3' });
  assert.equal(result.kind, 'speech');
  assert.ok(result.bytes.equals(AUDIO_BYTES));
  assert.equal(result.mediaType, 'audio/mpeg');
  assert.equal(result.extension, 'mp3');
});

test('video URL and base64 responses are normalized', async () => {
  const provider = client('video', '/video');
  const urlResult = await provider.generateVideo({ prompt: 'waves' });
  assert.equal(urlResult.kind, 'video');
  assert.ok(urlResult.url.endsWith('/asset.mp4'));
  assert.equal(urlResult.requestId, 'req-1');
  const downloaded = await provider.download(urlResult.url);
  assert.ok(downloaded.bytes.equals(MP4_BYTES));

  const b64Result = await client('video', '/video-b64').generateVideo({ prompt: 'waves' });
  assert.ok(b64Result.bytes.equals(MP4_BYTES));
  assert.equal(b64Result.mediaType, 'video/mp4');
});

test('non-2xx statuses map to provider error codes', async () => {
  await assert.rejects(
    () => client('asr', '/status/401').transcribe({ audio: Buffer.from('x'), filename: 'a.wav' }),
    (error) => error.code === 'provider-auth' && error.status === 401 && error.retryable === false,
  );
  await assert.rejects(
    () => client('image', '/status/429').generateImage({ prompt: 'cat' }),
    (error) => error.code === 'provider-rate-limit' && error.status === 429 && error.retryable === true,
  );
  await assert.rejects(
    () => client('image', '/status/500').generateImage({ prompt: 'cat' }),
    (error) => error.code === 'provider-unavailable' && error.status === 500 && error.retryable === true,
  );
});

test('malformed JSON and invalid provider payloads fail validation', async () => {
  await assert.rejects(
    () => client('asr', '/malformed').transcribe({ audio: Buffer.from('x'), filename: 'a.wav' }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => client('asr', '/invalid-asr').transcribe({ audio: Buffer.from('x'), filename: 'a.wav' }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => client('image', '/invalid-image').generateImage({ prompt: 'cat' }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => client('speech', '/invalid-speech').generateSpeech({ text: 'hello' }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('timeout maps to provider-timeout and is retryable', async () => {
  await assert.rejects(
    () => createProviderClient({
      kind: 'asr',
      config: config('asr', '/slow'),
      timeoutMs: 25,
      retries: 0,
    }).transcribe({ audio: Buffer.from('x'), filename: 'a.wav' }),
    (error) => error.code === 'provider-timeout' && error.retryable === true,
  );
});

test('caller cancellation maps to provider-cancelled', async () => {
  const controller = new AbortController();
  const pending = createProviderClient({
    kind: 'image',
    config: config('image', '/slow'),
    timeoutMs: 2_000,
    retries: 0,
  }).generateImage({ prompt: 'cat' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.code === 'provider-cancelled');
});

test('transient failures retry with backoff and then succeed', async () => {
  const result = await createProviderClient({
    kind: 'image',
    config: config('image', '/retry'),
    retries: 1,
    retryDelayMs: 1,
    timeoutMs: 2_000,
  }).generateImage({ prompt: 'cat' });
  assert.equal(result.kind, 'image');
  assert.equal(requests.filter((request) => request.path === '/retry').length, 2);
});

test('provider errors redact secrets from messages, details and JSON', async () => {
  await assert.rejects(
    () => client('image', '/echo-auth').generateImage({ prompt: 'cat' }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'provider-auth');
      const serialized = `${error.message}\n${JSON.stringify(error)}\n${String(error)}`;
      assert.equal(serialized.includes(SECRET), false);
      assert.match(serialized, /\[redacted\]/);
      return true;
    },
  );
});

test('describeConfig and redactSecrets never emit the key', () => {
  const described = describeConfig(config('image', '/image'));
  assert.equal(described.hasKey, true);
  assert.equal(JSON.stringify(described).includes(SECRET), false);
  assert.equal(redactSecrets(`bearer ${SECRET}`, [SECRET]), 'bearer [redacted]');
});

test('unconfigured remote providers fail closed without making a request', async () => {
  const unconfigured = createProviderClient({
    kind: 'image',
    config: { url: 'https://api.example.test/v1/images/generations', key: null, model: 'x' },
    retries: 0,
    timeoutMs: 2_000,
  });
  await assert.rejects(
    () => unconfigured.generateImage({ prompt: 'cat' }),
    (error) => error.code === 'provider-not-configured',
  );
  assert.equal(requests.length, 0);
});

test('missing input fields are rejected before fetch', async () => {
  await assert.rejects(
    () => client('image', '/image').generateImage({}),
    (error) => error.code === 'provider-invalid-input',
  );
  assert.equal(requests.length, 0);
});

test('download rejects non-http URLs and provider errors', async () => {
  const provider = client('image', '/image');
  await assert.rejects(() => provider.download('file:///etc/passwd'), (error) => error.code === 'provider-invalid-config');
  await assert.rejects(() => provider.download(`${base}/missing`), (error) => error.code === 'provider-http');
});

test('no request in this suite leaves the loopback mock origin', () => {
  assert.ok(requests.every((request) => request.path.startsWith('/') || request.path.startsWith(base)));
});
