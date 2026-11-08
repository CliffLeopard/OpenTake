/**
 * ffmpeg export pipeline for OpenTake Studio (docs/DESIGN.md §5).
 *
 * `buildExportArgs` is a pure argv builder: it never spawns a process, never
 * writes files and returns the complete ffmpeg argument vector for a project.
 * `runExport` validates the project, spawns ffmpeg with that argv and reports
 * progress parsed from `-progress pipe:1`.
 *
 * MVP limitations (also documented in DESIGN §5): no transitions, keyframes,
 * effects or speed changes; text rendering depends on a system font; clip
 * rotation is ignored; only clips' own `volume` is applied.
 */

import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { mediaFilePath, resolveTools, runFfmpeg } from './media.js';

/** Error thrown by export argument building and execution. */
export class ExportError extends Error {
  constructor(message, code = 'ffmpeg-failed', options) {
    super(message, options);
    this.name = 'ExportError';
    this.code = code;
  }
}

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const REGULAR_FONTS = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/HelveticaNeue.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
];

const BOLD_FONTS = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf',
];

let fontCache = null;

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  return null;
}

/** Auto-detect a system font (regular + bold) once per process. */
function detectFonts() {
  if (fontCache === null) {
    const regular = firstExisting(REGULAR_FONTS);
    fontCache = {
      regular,
      bold: firstExisting(BOLD_FONTS) ?? regular,
    };
  }
  return fontCache;
}

// ---------------------------------------------------------------------------
// Numbers, paths and filter escaping
// ---------------------------------------------------------------------------

function normalizeFps(project) {
  const fps = Number(project?.fps);
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

function normalizeDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

function framesToSeconds(frames, fps) {
  const value = Number(frames);
  if (!Number.isFinite(value)) return 0;
  return value / fps;
}

function formatSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '0';
  const fixed = number.toFixed(6).replace(/\.?0+$/, '');
  return fixed.length === 0 ? '0' : fixed;
}

function formatNumber(value) {
  return formatSeconds(value);
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

/**
 * Escape one filter option value for both ffmpeg escaping layers:
 *   1. the filter-option value (`\`, `'` and `:` are special),
 *   2. the filtergraph token (`\`, `'`, `[]`, `,` and `;` are special).
 * The result is a single-quoted filtergraph token.
 */
function escapeFilterValue(value) {
  const optionEscaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
  const graphEscaped = optionEscaped
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  return `'${graphEscaped}'`;
}

/**
 * Quote a filtergraph-safe expression that contains no option-level separators
 * (for example `between(t,1.5,3)`), protecting its commas from the graph parser.
 */
function quoteFilterExpression(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Project helpers (local, so export stays independent of model.js internals)
// ---------------------------------------------------------------------------

function timelineDurationFrames(project) {
  let duration = 0;
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      const start = Number(clip?.startFrame);
      const length = Number(clip?.durationFrames);
      if (!Number.isFinite(start) || !Number.isFinite(length)) continue;
      const end = Math.max(0, Math.round(start)) + Math.max(1, Math.round(length));
      if (end > duration) duration = Math.round(end);
    }
  }
  return duration;
}

function findMedia(project, mediaId) {
  if (typeof mediaId !== 'string') return null;
  const media = Array.isArray(project?.media) ? project.media : [];
  return media.find((entry) => entry !== null && typeof entry === 'object' && entry.id === mediaId) ?? null;
}

function normalizeTransform(transform) {
  const source = transform !== null && typeof transform === 'object' ? transform : {};
  const read = (key, fallback) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    x: read('x', 0),
    y: read('y', 0),
    width: read('width', 1),
    height: read('height', 1),
    rotation: read('rotation', 0),
  };
}

function geometryFor(transform, projectWidth, projectHeight) {
  const normalized = normalizeTransform(transform);
  return {
    x: Math.round(normalized.x * projectWidth),
    y: Math.round(normalized.y * projectHeight),
    width: Math.max(1, Math.round(normalized.width * projectWidth)),
    height: Math.max(1, Math.round(normalized.height * projectHeight)),
  };
}

// ---------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------

/**
 * Build the complete ffmpeg argv for a project export.
 *
 * @param {{ project: object, projectRoot: string, outputPath: string }} input
 * @returns {{ args: string[], durationFrames: number }}
 */
export function buildExportArgs({ project, projectRoot, outputPath } = {}) {
  if (project === null || typeof project !== 'object') {
    throw new ExportError('buildExportArgs requires a project object', 'invalid-input');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new ExportError('buildExportArgs requires a projectRoot path', 'invalid-input');
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new ExportError('buildExportArgs requires an output path', 'invalid-input');
  }

  const fps = normalizeFps(project);
  const width = normalizeDimension(project.width, DEFAULT_WIDTH);
  const height = normalizeDimension(project.height, DEFAULT_HEIGHT);
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = framesToSeconds(durationFrames, fps);
  const framesToSecondsForProject = (frames) => framesToSeconds(frames, fps);

  const inputs = [
    '-f', 'lavfi',
    '-i', `color=c=black:s=${width}x${height}:r=${formatNumber(fps)}:d=${formatSeconds(durationSeconds)}`,
  ];
  let inputIndex = 1;

  const chains = [];
  const audioLabels = [];
  let baseLabel = '0:v';
  let counter = 0;
  let audioCounter = 0;
  let hasVisual = false;

  const addInput = (prefix, file) => {
    inputs.push(...prefix, '-i', file);
    const index = inputIndex;
    inputIndex += 1;
    return index;
  };

  const addAudioChain = (clip, index) => {
    const duration = formatSeconds(framesToSecondsForProject(
      Math.max(1, Number(clip.durationFrames) || 1),
    ));
    const volume = formatNumber(clamp01(clip.volume ?? 1));
    const startMilliseconds = Math.max(0, Math.round(framesToSecondsForProject(clip.startFrame ?? 0) * 1000));
    const label = `a${audioCounter}`;
    audioCounter += 1;
    chains.push(
      `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
      `volume=${volume},adelay=${startMilliseconds}:all=1[${label}]`,
    );
    audioLabels.push(label);
  };

  const addOverlayChain = (clip, index) => {
    const startSeconds = framesToSecondsForProject(clip.startFrame ?? 0);
    const clipSeconds = framesToSecondsForProject(Math.max(1, Number(clip.durationFrames) || 1));
    const endSeconds = startSeconds + clipSeconds;
    const box = geometryFor(clip.transform, width, height);
    const opacity = clamp01(clip.opacity ?? 1);

    const label = `v${counter}`;
    counter += 1;
    const scaleParts = [`scale=${box.width}:${box.height}`, 'setsar=1', `fps=${formatNumber(fps)}`];
    if (opacity < 1) {
      scaleParts.push('format=rgba', `colorchannelmixer=aa=${formatNumber(opacity)}`);
    }
    scaleParts.push(`setpts=PTS-STARTPTS+${formatSeconds(startSeconds)}/TB`);
    chains.push(`[${index}:v]${scaleParts.join(',')}[${label}]`);

    const outputLabel = `b${counter}`;
    counter += 1;
    const window = quoteFilterExpression(
      `between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`,
    );
    chains.push(
      `[${baseLabel}][${label}]overlay=x=${box.x}:y=${box.y}:enable=${window}[${outputLabel}]`,
    );
    baseLabel = outputLabel;
    hasVisual = true;
  };

  const addTextChain = (clip) => {
    const content = clip?.text !== null && typeof clip?.text === 'object' ? String(clip.text.content ?? '') : '';
    if (content.length === 0) return;
    // The browser editor can pre-render each text clip to a transparent PNG
    // (Host route /text/render) so export works even when ffmpeg lacks
    // drawtext/libfreetype. Fall back to drawtext when no render exists.
    const rendered = path.join(projectRoot, 'renders', `${clip.id}.png`);
    if (typeof clip.id === 'string' && existsSync(rendered)) {
      const duration = Math.max(1, Number(clip.durationFrames) || 1);
      const index = addInput(['-loop', '1', '-t', formatSeconds(framesToSecondsForProject(duration))], rendered);
      addOverlayChain(clip, index);
      return;
    }
    const box = geometryFor(clip.transform, width, height);
    const startSeconds = framesToSecondsForProject(clip.startFrame ?? 0);
    const clipSeconds = framesToSecondsForProject(Math.max(1, Number(clip.durationFrames) || 1));
    const endSeconds = startSeconds + clipSeconds;
    const fonts = detectFonts();
    const fontWeight = String(clip.text.fontWeight ?? '400');
    const fontFile = fontWeight === '600' || fontWeight === '700' ? fonts.bold : fonts.regular;
    const fontSize = Math.max(1, Math.round(Number(clip.text.fontSize) || 48));
    const color = String(clip.text.color ?? '#ffffff');
    const align = clip.text.align;

    let xExpression = String(box.x);
    if (align === 'center') xExpression = `${box.x}+(${box.width}-text_w)/2`;
    else if (align === 'right') xExpression = `${box.x}+${box.width}-text_w`;

    const options = [];
    if (fontFile !== null) options.push(`fontfile=${escapeFilterValue(fontFile)}`);
    options.push(`text=${escapeFilterValue(content)}`);
    options.push(`fontcolor=${escapeFilterValue(color)}`);
    options.push(`fontsize=${fontSize}`);
    options.push('expansion=none');
    options.push(`x=${xExpression}`);
    options.push(`y=${box.y}`);
    options.push(
      `enable=${quoteFilterExpression(
        `between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`,
      )}`,
    );

    const outputLabel = `b${counter}`;
    counter += 1;
    chains.push(`[${baseLabel}]drawtext=${options.join(':')}[${outputLabel}]`);
    baseLabel = outputLabel;
    hasVisual = true;
  };

  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  for (const track of tracks) {
    if (track === null || typeof track !== 'object') continue;
    const clips = Array.isArray(track.clips) ? track.clips : [];
    const trackMuted = track.muted === true;
    const trackHidden = track.hidden === true;

    if (track.type === 'audio') {
      if (trackMuted) continue;
      for (const clip of clips) {
        if (clip?.type !== 'audio') continue;
        const media = findMedia(project, clip.mediaId);
        if (media === null) continue;
        const file = mediaFilePath(projectRoot, media);
        const duration = Math.max(1, Number(clip.durationFrames) || 1);
        const trim = Math.max(0, Number(clip.trimStartFrame) || 0);
        const index = addInput(
          ['-ss', formatSeconds(framesToSecondsForProject(trim)), '-t', formatSeconds(framesToSecondsForProject(duration))],
          file,
        );
        addAudioChain(clip, index);
      }
      continue;
    }

    if (track.type !== 'video') continue;

    for (const clip of clips) {
      if (clip === null || typeof clip !== 'object') continue;

      if (clip.type === 'text') {
        if (!trackHidden) addTextChain(clip);
        continue;
      }

      if (clip.type !== 'video' && clip.type !== 'image') continue;
      const media = findMedia(project, clip.mediaId);
      if (media === null) continue;
      const wantsVisual = !trackHidden;
      // Video clips carry their own audio into the mix when the source has it;
      // image clips never do.
      const wantsAudio = clip.type === 'video' && !trackMuted && media.hasAudio === true;
      if (!wantsVisual && !wantsAudio) continue;

      const file = mediaFilePath(projectRoot, media);
      const duration = Math.max(1, Number(clip.durationFrames) || 1);
      const trim = Math.max(0, Number(clip.trimStartFrame) || 0);
      const prefix = clip.type === 'image'
        ? ['-loop', '1', '-t', formatSeconds(framesToSecondsForProject(duration))]
        : ['-ss', formatSeconds(framesToSecondsForProject(trim)), '-t', formatSeconds(framesToSecondsForProject(duration))];
      const index = addInput(prefix, file);

      if (wantsVisual) addOverlayChain(clip, index);
      if (wantsAudio) addAudioChain(clip, index);
    }
  }

  // Always end the video chain with a stable label so the mapping never depends
  // on how many overlay/drawtext steps ran.
  if (hasVisual) {
    chains.push(`[${baseLabel}]null[vout]`);
  } else {
    chains.push('[0:v]null[vout]');
  }

  if (audioLabels.length > 0) {
    const mixedInputs = audioLabels.map((label) => `[${label}]`).join('');
    chains.push(
      `${mixedInputs}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,` +
      'aresample=48000[aout]',
    );
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '[vout]',
  ];

  if (audioLabels.length > 0) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-crf', '20',
    '-movflags', '+faststart',
    '-t', formatSeconds(durationSeconds),
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  );

  return { args, durationFrames };
}

// ---------------------------------------------------------------------------
// Export execution
// ---------------------------------------------------------------------------

/**
 * Render a project to `outputPath` with ffmpeg.
 *
 * @param {{ project: object, projectRoot: string, outputPath: string,
 *   onProgress?: (progress: number) => void, signal?: AbortSignal }} input
 * @returns {Promise<{ outputPath: string, durationFrames: number }>}
 */
export async function runExport({ project, projectRoot, outputPath, onProgress, signal } = {}) {
  if (signal?.aborted) {
    const error = new ExportError('The export was aborted', 'aborted');
    error.name = 'AbortError';
    throw error;
  }

  let built;
  try {
    built = buildExportArgs({ project, projectRoot, outputPath });
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError(`Could not build the export command: ${error.message}`, 'invalid-input', { cause: error });
  }

  if (built.durationFrames <= 0) {
    throw new ExportError('The project timeline is empty; add a clip before exporting', 'invalid-input');
  }

  const tools = resolveTools();
  if (tools.ffmpeg === null) {
    throw new ExportError(
      'ffmpeg is not available (set OPENTAKE_STUDIO_FFMPEG or install ffmpeg)',
      'ffmpeg-unavailable',
    );
  }

  const durationSeconds = framesToSeconds(built.durationFrames, normalizeFps(project));
  const existedBefore = existsSync(outputPath);

  const emitProgress = (value) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(Math.max(0, Math.min(1, value)));
    } catch {
      // Progress callbacks are advisory; never let one break the export.
    }
  };

  try {
    await runFfmpeg(built.args, {
      signal,
      onProgress: (progress) => {
        if (progress.outTimeSeconds === null) return;
        emitProgress(progress.outTimeSeconds / durationSeconds);
      },
    });
  } catch (error) {
    if (!existedBefore) await rm(outputPath, { force: true }).catch(() => {});
    if (error?.name === 'AbortError') throw error;
    if (error instanceof ExportError) throw error;
    const message = String(error?.message ?? error);
    const hint = /No such filter: ['"]?drawtext|Unknown filter ['"]?drawtext/i.test(message)
      ? ' — this ffmpeg build lacks the drawtext filter (libfreetype); install a full ffmpeg build to export text'
      : '';
    throw new ExportError(`Export failed: ${message}${hint}`, error?.code ?? 'ffmpeg-failed', { cause: error });
  }

  let outputInfo;
  try {
    outputInfo = await stat(outputPath);
  } catch (error) {
    throw new ExportError('ffmpeg reported success but produced no output file', 'ffmpeg-failed', { cause: error });
  }
  if (!outputInfo.isFile() || outputInfo.size === 0) {
    throw new ExportError('ffmpeg produced an empty output file', 'ffmpeg-failed');
  }

  emitProgress(1);
  return { outputPath, durationFrames: built.durationFrames };
}
