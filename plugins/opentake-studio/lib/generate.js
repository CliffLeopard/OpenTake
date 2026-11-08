/**
 * Provider-backed generation for OpenTake Studio (pure HTTP, optional keys).
 *
 * The plugin never bundles models or provider SDKs. It talks to
 * OpenAI-compatible endpoints using credentials from the DSH credential
 * service (or environment variables). When a provider is not configured the
 * routes return a clear `generation-unavailable` error instead of failing
 * silently.
 *
 * Environment:
 *   OPENAI_API_KEY / OPENAI_BASE_URL        image + speech provider credential
 *   OPENTAKE_STUDIO_IMAGE_MODEL            default gpt-image-1
 *   OPENTAKE_STUDIO_TTS_MODEL              default gpt-4o-mini-tts
 *   OPENTAKE_STUDIO_TTS_VOICE              default alloy
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { probeMedia } from './media.js';

export class GenerateError extends Error {
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = 'GenerateError';
    this.code = code;
  }
}

export function generationSettings() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    imageModel: process.env.OPENTAKE_STUDIO_IMAGE_MODEL?.trim() || 'gpt-image-1',
    ttsModel: process.env.OPENTAKE_STUDIO_TTS_MODEL?.trim() || 'gpt-4o-mini-tts',
    ttsVoice: process.env.OPENTAKE_STUDIO_TTS_VOICE?.trim() || 'alloy',
  };
}

async function resolveOpenAiKey(ctx) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve('OPENAI_API_KEY');
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value;
      }
    }
  } catch {
    // Fall through to the environment.
  }
  const ambient = process.env.OPENAI_API_KEY;
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : null;
}

export async function generationProviders(ctx) {
  const settings = generationSettings();
  const key = await resolveOpenAiKey(ctx);
  return {
    image: { configured: key !== null, model: settings.imageModel, baseUrl: settings.baseUrl },
    speech: { configured: key !== null, model: settings.ttsModel, baseUrl: settings.baseUrl },
  };
}

function safeName(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

async function postJson({ ctx, pathName, body, signal }) {
  const key = await resolveOpenAiKey(ctx);
  if (key === null) {
    throw new GenerateError(
      'generation-unavailable',
      'No OpenAI credential is configured (set OPENAI_API_KEY or store it in DSH credentials)',
    );
  }
  const settings = generationSettings();
  let response;
  try {
    response = await fetch(`${settings.baseUrl}${pathName}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new GenerateError('generation-unavailable', `Generation request failed: ${error.message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GenerateError(
      'generation-failed',
      `Generation endpoint returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return response;
}

/**
 * Generate one image, write it under `<projectRoot>/media/` and return the
 * probed project Media object. Caller adds it with `add-media`.
 */
export async function generateImage({ ctx, projectRoot, prompt, size, signal }) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0) throw new GenerateError('invalid-input', 'A prompt is required');
  const settings = generationSettings();
  const response = await postJson({
    ctx,
    pathName: '/images/generations',
    body: { model: settings.imageModel, prompt: text, n: 1, ...(size === undefined ? {} : { size }) },
    signal,
  });
  const payload = await response.json();
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (first === null || typeof first?.b64_json !== 'string') {
    throw new GenerateError('generation-failed', 'The image provider returned no b64_json image');
  }
  const bytes = Buffer.from(first.b64_json, 'base64');
  const id = randomUUID();
  const fileName = `${id}-generated.png`;
  const mediaDir = path.join(projectRoot, 'media');
  await mkdir(mediaDir, { recursive: true });
  const destination = path.join(mediaDir, path.basename(fileName));
  await writeFile(destination, bytes);
  const probe = await probeMedia(destination);
  return {
    id,
    name: `generated-${safeName(text.slice(0, 24), 'image')}.png`,
    kind: 'image',
    fileName,
    durationFrames: null,
    sourceDurationSeconds: null,
    width: probe.width,
    height: probe.height,
    hasAudio: false,
    sizeBytes: bytes.length,
    importedAt: Date.now(),
    generated: { provider: 'openai', model: settings.imageModel, prompt: text },
  };
}

/**
 * Generate speech from text, write the audio into `<projectRoot>/media/` and
 * return the probed project Media object. Caller adds it with `add-media`.
 */
export async function generateSpeech({ ctx, project, projectRoot, text, voice, model, signal }) {
  const input = typeof text === 'string' ? text.trim() : '';
  if (input.length === 0) throw new GenerateError('invalid-input', 'Speech text is required');
  const settings = generationSettings();
  const response = await postJson({
    ctx,
    pathName: '/audio/speech',
    body: {
      model: model ?? settings.ttsModel,
      voice: voice ?? settings.ttsVoice,
      input,
      response_format: 'mp3',
    },
    signal,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new GenerateError('generation-failed', 'The speech provider returned no audio');
  const id = randomUUID();
  const fileName = `${id}-speech.mp3`;
  await mkdir(path.join(projectRoot, 'media'), { recursive: true });
  const destination = path.join(projectRoot, 'media', fileName);
  await writeFile(destination, bytes);
  const probe = await probeMedia(destination);
  const fps = Math.max(1, Number(project?.fps) || 30);
  return {
    id,
    name: `speech-${safeName(input.slice(0, 24), 'clip')}.mp3`,
    kind: 'audio',
    fileName,
    durationFrames:
      probe.durationSeconds === null ? 90 : Math.max(1, Math.round(probe.durationSeconds * fps)),
    sourceDurationSeconds: probe.durationSeconds,
    width: null,
    height: null,
    hasAudio: true,
    sizeBytes: bytes.length,
    importedAt: Date.now(),
    generated: { provider: 'openai', model: model ?? settings.ttsModel, prompt: input },
  };
}
