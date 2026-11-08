/**
 * Optional provider-backed visual indexing for OpenTake Studio.
 *
 * Pure HTTP: the Host renders a thumbnail with ffmpeg and asks an
 * OpenAI-compatible vision model to describe it. Descriptions are stored under
 * `<projectRoot>/vision/<mediaId>.json` and included in project search, which
 * approximates visual search without bundling CLIP/SigLIP.
 *
 * Environment:
 *   OPENAI_API_KEY / OPENAI_BASE_URL
 *   OPENTAKE_STUDIO_VISION_MODEL  default gpt-4o-mini
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureThumbnail, mediaFilePath } from './media.js';

export class VisionError extends Error {
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = 'VisionError';
    this.code = code;
  }
}

export const VISION_DIR = 'vision';

function settings() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENTAKE_STUDIO_VISION_MODEL?.trim() || 'gpt-4o-mini',
  };
}

async function resolveKey(ctx) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve('OPENAI_API_KEY');
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value;
      }
    }
  } catch {
    // Fall back to the environment.
  }
  const ambient = process.env.OPENAI_API_KEY;
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : null;
}

/**
 * Describe one image/video thumbnail and persist the description.
 * @returns {Promise<{mediaId,mediaName,description,model,createdAt}>}
 */
export async function indexMediaVision({ ctx, projectRoot, media, signal }) {
  if (media === null || typeof media !== 'object') {
    throw new VisionError('invalid-input', 'A media asset is required');
  }
  if (media.kind !== 'image' && media.kind !== 'video') {
    throw new VisionError('invalid-input', 'Only image and video media can be visually indexed');
  }
  const key = await resolveKey(ctx);
  if (key === null) {
    throw new VisionError(
      'vision-unavailable',
      'No vision credential is configured (set OPENAI_API_KEY or store it in DSH credentials)',
    );
  }
  const source = mediaFilePath(projectRoot, media);
  const thumbnail = await ensureThumbnail({ projectRoot, media });
  const bytes = await readFile(thumbnail);
  const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  void source;
  const config = settings();
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 220,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Describe this video frame precisely for a searchable media library. Reply with one ' +
                  'compact sentence covering subjects, actions, setting, colours and any visible text.',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new VisionError('vision-unavailable', `Vision request failed: ${error.message}`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new VisionError('vision-failed', `Vision endpoint returned ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new VisionError('vision-failed', 'Vision endpoint returned invalid JSON', { cause: error });
  }
  const description = String(payload?.choices?.[0]?.message?.content ?? '').trim();
  if (description.length === 0) throw new VisionError('vision-failed', 'The vision model returned no description');
  const record = {
    mediaId: media.id,
    mediaName: media.name,
    description,
    model: config.model,
    createdAt: Date.now(),
  };
  const dir = path.join(projectRoot, VISION_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${media.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** Read all stored visual descriptions for a project. */
export async function readVisionIndex(projectRoot) {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(projectRoot, VISION_DIR);
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (record !== null && typeof record === 'object' && typeof record.description === 'string') {
        records.push(record);
      }
    } catch {
      // Ignore a corrupt index entry; it is regenerable.
    }
  }
  return records.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}
