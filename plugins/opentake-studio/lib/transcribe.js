/**
 * Optional speech-to-text for OpenTake Studio.
 *
 * Pure HTTP integration: the Host extracts the media's audio with ffmpeg, posts
 * it to a Whisper-compatible endpoint and stores the transcript next to the
 * project (`transcripts/<mediaId>.json`). No model is bundled, so the feature is
 * available only when an endpoint/key is configured:
 *
 *   OPENTAKE_STUDIO_ASR_URL       full transcription endpoint
 *                                 (default https://api.openai.com/v1/audio/transcriptions)
 *   OPENTAKE_STUDIO_ASR_MODEL     model name (default whisper-1)
 *   OPENTAKE_STUDIO_ASR_KEY_REF   credential ref/env name (default OPENAI_API_KEY)
 *   OPENTAKE_STUDIO_ASR_LANGUAGE  optional ISO language hint
 *
 * Any OpenAI-compatible server works (including a local faster-whisper or
 * whisper.cpp HTTP server); loopback endpoints may omit the key.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MediaError, mediaFilePath, resolveTools, runFfmpeg } from './media.js';

export class TranscribeError extends Error {
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = 'TranscribeError';
    this.code = code;
  }
}

export const TRANSCRIPTS_DIR = 'transcripts';

export function transcriptionSettings() {
  const url =
    process.env.OPENTAKE_STUDIO_ASR_URL?.trim() || 'https://api.openai.com/v1/audio/transcriptions';
  const model = process.env.OPENTAKE_STUDIO_ASR_MODEL?.trim() || 'whisper-1';
  const keyRef = process.env.OPENTAKE_STUDIO_ASR_KEY_REF?.trim() || 'OPENAI_API_KEY';
  const language = process.env.OPENTAKE_STUDIO_ASR_LANGUAGE?.trim() || undefined;
  let loopback = false;
  try {
    const parsed = new URL(url);
    loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    throw new TranscribeError('asr-unavailable', 'OPENTAKE_STUDIO_ASR_URL is not a valid URL');
  }
  return { url, model, keyRef, language, loopback };
}

async function resolveApiKey(ctx, keyRef) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(keyRef);
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value;
      }
    }
  } catch {
    // Fall through to the environment.
  }
  const ambient = process.env[keyRef];
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : null;
}

/** Extract a mono 16 kHz WAV from a media file using ffmpeg. */
export async function extractAudioTrack(filePath, signal) {
  const tools = resolveTools();
  if (tools.ffmpeg === null) {
    throw new TranscribeError('ffmpeg-unavailable', 'ffmpeg is not available for audio extraction');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ots-transcribe-'));
  const output = path.join(dir, 'audio.wav');
  try {
    await runFfmpeg(
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', filePath,
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le',
        output,
      ],
      { signal: signal ?? AbortSignal.timeout(120_000) },
    );
    return { dir, output };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function normalizeSegments(payload, fallbackDurationSeconds) {
  const raw = Array.isArray(payload?.segments) ? payload.segments : null;
  if (raw !== null && raw.length > 0) {
    return raw
      .map((segment) => ({
        startSeconds: Number(segment.start ?? segment.start_seconds ?? 0),
        endSeconds: Number(segment.end ?? segment.end_seconds ?? segment.start ?? 0),
        text: String(segment.text ?? '').trim(),
      }))
      .filter((segment) => segment.text.length > 0 && Number.isFinite(segment.startSeconds));
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (text.length === 0) return [];
  return [{ startSeconds: 0, endSeconds: Math.max(0, Number(fallbackDurationSeconds) || 0), text }];
}

/**
 * Transcribe one project media asset.
 *
 * @param {object} options
 * @param {object} options.ctx Host plugin context (for credentials)
 * @param {object} options.project Project
 * @param {string} options.projectRoot
 * @param {object} options.media Project Media
 * @param {AbortSignal} [options.signal]
 */
export async function transcribeMedia({ ctx, project, projectRoot, media, signal }) {
  if (media === null || typeof media !== 'object') {
    throw new TranscribeError('invalid-input', 'A media asset is required');
  }
  if (media.kind !== 'video' && media.kind !== 'audio') {
    throw new TranscribeError('invalid-input', 'Only video and audio media can be transcribed');
  }
  const settings = transcriptionSettings();
  const key = await resolveApiKey(ctx, settings.keyRef);
  if (!settings.loopback && key === null) {
    throw new TranscribeError(
      'asr-unavailable',
      `No transcription credential is configured (set ${settings.keyRef} or OPENTAKE_STUDIO_ASR_URL)`,
    );
  }
  const filePath = mediaFilePath(projectRoot, media);
  const extracted = await extractAudioTrack(filePath, signal);
  try {
    const bytes = await readFile(extracted.output);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', settings.model);
    form.append('response_format', 'verbose_json');
    if (settings.language !== undefined) form.append('language', settings.language);
    const headers = {};
    if (key !== null) headers.authorization = `Bearer ${key}`;
    let response;
    try {
      response = await fetch(settings.url, {
        method: 'POST',
        headers,
        body: form,
        signal: signal ?? AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new TranscribeError('asr-unavailable', `Transcription request failed: ${error.message}`, {
        cause: error,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new TranscribeError(
        'asr-failed',
        `Transcription endpoint returned ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new TranscribeError('asr-failed', 'Transcription endpoint returned invalid JSON', {
        cause: error,
      });
    }
    const durationSeconds =
      media.sourceDurationSeconds ??
      (media.durationFrames === null || media.durationFrames === undefined
        ? null
        : media.durationFrames / project.fps);
    const segments = normalizeSegments(payload, durationSeconds);
    const transcript = {
      mediaId: media.id,
      mediaName: media.name,
      language: typeof payload.language === 'string' ? payload.language : (settings.language ?? null),
      text: typeof payload.text === 'string' ? payload.text : segments.map((segment) => segment.text).join(' '),
      segments,
      provider: settings.url,
      model: settings.model,
      createdAt: Date.now(),
    };
    const dir = path.join(projectRoot, TRANSCRIPTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${media.id}.json`), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
    return transcript;
  } finally {
    await rm(extracted.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read all stored transcripts for a project. */
export async function readTranscripts(projectRoot) {
  const dir = path.join(projectRoot, TRANSCRIPTS_DIR);
  let entries;
  try {
    entries = await readFileIndex(dir);
  } catch {
    return [];
  }
  return entries;
}

async function readFileIndex(dir) {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const transcripts = [];
  for (const name of names) {
    try {
      const raw = await readFile(path.join(dir, name), 'utf8');
      const transcript = JSON.parse(raw);
      if (transcript !== null && typeof transcript === 'object' && Array.isArray(transcript.segments)) {
        transcripts.push(transcript);
      }
    } catch {
      // Ignore a corrupt transcript; it is regenerable.
    }
  }
  return transcripts.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

/**
 * Convert a transcript to caption segments relative to a new caption clip.
 * @param {object} transcript
 * @param {number} fps
 */
export function transcriptToCaptionSegments(transcript, fps) {
  const segments = transcript.segments
    .map((segment) => ({
      startFrame: Math.max(0, Math.round(segment.startSeconds * fps)),
      durationFrames: Math.max(1, Math.round((segment.endSeconds - segment.startSeconds) * fps)),
      text: segment.text,
    }))
    .filter((segment) => segment.text.length > 0);
  if (segments.length === 0) return null;
  const startFrame = Math.min(...segments.map((segment) => segment.startFrame));
  const endFrame = Math.max(...segments.map((segment) => segment.startFrame + segment.durationFrames));
  const durationFrames = Math.max(1, endFrame - startFrame);
  return {
    startFrame,
    durationFrames,
    segments: segments
      .map((segment) => ({ ...segment, startFrame: Math.max(0, segment.startFrame - startFrame) }))
      .filter((segment) => segment.startFrame < durationFrames),
  };
}

/** Build a caption overlay style from a transcript. */
export const TRANSCRIPT_CAPTION_STYLE = Object.freeze({
  fontSize: 44,
  color: '#ffffff',
  fontWeight: '600',
  align: 'center',
  background: 'rgba(0,0,0,0.45)',
});
