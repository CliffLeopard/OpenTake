/**
 * ffmpeg export pipeline for OpenTake Studio (docs/DESIGN.md §5 + §11.3).
 *
 * `buildExportArgs` is a pure argv builder: it never spawns a process, never
 * writes files and returns the complete ffmpeg argument vector for a project.
 * `runExport` validates the project, spawns ffmpeg with that argv and reports
 * progress parsed from `-progress pipe:1`.
 *
 * Phase 1 support (DESIGN §11.1/§11.3):
 *   - clip.speed (0.25..4): video `setpts=(PTS-STARTPTS)/speed` with a
 *     durationFrames*speed source window; audio gets an `atempo` chain.
 *   - clip.fadeInFrames/fadeOutFrames: `fade` / `afade`.
 *   - keyframes.volume: `volume=eval=frame` piecewise expression with
 *     linear/ease-in/ease-out/ease-in-out interpolation.
 *   - keyframes.x/y: overlay `x`/`y` expressions on timeline `t`. Values use
 *     the same normalized 0..1 space as `transform`, so they are scaled by the
 *     project width/height. width/height/rotation keyframes and opacity
 *     keyframes are NOT representable with this filter graph; the static
 *     transform/opacity is used instead (documented limitation).
 *   - clip.effects (ordered): eq (brightness/contrast/saturation),
 *     colorbalance (temperature), gblur, unsharp, chromakey, lut3d.
 *     Effects apply to video/image (and browser-rendered text/caption PNGs).
 *     The drawtext fallback for text/caption clips cannot apply per-clip
 *     effects, fades, opacity or keyframes; render PNGs to get them.
 *   - caption clips: browser-rendered `<root>/renders/<clipId>.png` (whole
 *     clip) or the Host's per-segment render `<clipId>-seg-<n>.png` is used
 *     when present, otherwise each `caption.segments[]` entry becomes a timed
 *     drawtext overlay.
 *   - transitions: `fadeToBlack` is a true dip-to-black via fades; `dissolve`
 *     and `wipeLeft`/`wipeRight` are approximated with the same outgoing fade
 *     out / incoming fade in because clips do not overlap on the timeline.
 *     True crossfades/wipes are not implemented.
 *
 * Text rendering still depends on a system font (`drawtext` needs an ffmpeg
 * build with libfreetype).
 */

import { existsSync, statSync } from 'node:fs';
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

const DEFAULT_TEXT_TRANSFORM = Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 0 });
const DEFAULT_CAPTION_TRANSFORM = Object.freeze({ x: 0.05, y: 0.8, width: 0.9, height: 0.15, rotation: 0 });

const TRANSITION_TYPES = new Set(['fadeToBlack', 'dissolve', 'wipeLeft', 'wipeRight']);

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

/** Format any finite scalar (including negatives) for a filter argument. */
function formatScalar(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  const fixed = number.toFixed(6).replace(/\.?0+$/, '');
  return fixed.length === 0 || fixed === '-0' ? '0' : fixed;
}

function formatNumber(value) {
  return formatScalar(value);
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

function clampScalar(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
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
 * (for example `between(t,1.5,3)` or `if(lt(t,1),...)`), protecting its commas
 * from the graph parser.
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
      const end = Math.max(0, Math.round(Number(clip?.startFrame) || 0)) +
        Math.max(1, Math.round(Number(clip?.durationFrames) || 0));
      if (Number.isFinite(end) && end > duration) duration = end;
    }
  }
  return duration;
}

function findMedia(project, mediaId) {
  if (typeof mediaId !== 'string') return null;
  const media = Array.isArray(project?.media) ? project.media : [];
  return media.find((entry) => entry !== null && typeof entry === 'object' && entry.id === mediaId) ?? null;
}

function findClipEntry(project, clipId) {
  if (typeof clipId !== 'string' || clipId.length === 0) return null;
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      if (clip !== null && typeof clip === 'object' && clip.id === clipId) {
        return { clip, track };
      }
    }
  }
  return null;
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

function clipDurationFrames(clip) {
  const duration = Number(clip?.durationFrames);
  return Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration)) : 1;
}

// ---------------------------------------------------------------------------
// Phase 1: speed, fades, keyframes, effects, transitions
// ---------------------------------------------------------------------------

function speedForClip(clip) {
  if (clip?.type !== 'video' && clip?.type !== 'audio') return 1;
  const speed = Number(clip.speed);
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(4, Math.max(0.25, speed));
}

/** Build the `atempo` factors (each 0.5..2) whose product is `speed`. */
function atempoFactors(speed) {
  if (!Number.isFinite(speed) || speed === 1) return [];
  let remaining = speed;
  const factors = [];
  let guard = 0;
  while (remaining > 2.000001 && guard < 8) {
    factors.push(2);
    remaining /= 2;
    guard += 1;
  }
  while (remaining < 0.499999 && guard < 8) {
    factors.push(0.5);
    remaining /= 0.5;
    guard += 1;
  }
  factors.push(Number(remaining.toFixed(6)));
  return factors;
}

function atempoChain(speed) {
  return atempoFactors(speed).map((factor) => `atempo=${formatScalar(factor)}`);
}

/**
 * Extra fade frames contributed by project.transitions. All four transition
 * types are approximated with an outgoing fade-out and incoming fade-in; the
 * `fadeToBlack` dip is exact, dissolve/wipe are documented approximations.
 */
function collectTransitionFades(project) {
  const additions = new Map();
  const transitions = Array.isArray(project?.transitions) ? project.transitions : [];
  for (const transition of transitions) {
    if (transition === null || typeof transition !== 'object') continue;
    if (!TRANSITION_TYPES.has(transition.type)) continue;
    const duration = Number(transition.durationFrames);
    if (!Number.isFinite(duration) || duration < 1) continue;
    const from = findClipEntry(project, transition.fromClipId);
    const to = findClipEntry(project, transition.toClipId);
    if (from === null || to === null) continue;
    // Transitions only connect non-text visual clips (DESIGN §11.1).
    if (!['video', 'image'].includes(from.clip.type)) continue;
    if (!['video', 'image'].includes(to.clip.type)) continue;
    const half = Math.max(1, Math.round(duration / 2));
    const fromFrames = Math.min(half, clipDurationFrames(from.clip));
    const toFrames = Math.min(half, clipDurationFrames(to.clip));
    const fromEntry = additions.get(from.clip.id) ?? { inFrames: 0, outFrames: 0 };
    fromEntry.outFrames = Math.max(fromEntry.outFrames, fromFrames);
    additions.set(from.clip.id, fromEntry);
    const toEntry = additions.get(to.clip.id) ?? { inFrames: 0, outFrames: 0 };
    toEntry.inFrames = Math.max(toEntry.inFrames, toFrames);
    additions.set(to.clip.id, toEntry);
  }
  return additions;
}

/** Effective fade frames for a clip (own fades + transition contribution). */
function fadesForClip(clip, transitionFades) {
  const duration = clipDurationFrames(clip);
  let inFrames = Math.max(0, Math.round(Number(clip?.fadeInFrames) || 0));
  let outFrames = Math.max(0, Math.round(Number(clip?.fadeOutFrames) || 0));
  inFrames = Math.min(inFrames, duration);
  outFrames = Math.min(outFrames, duration);

  const extra = transitionFades.get(clip.id);
  if (extra !== undefined) {
    inFrames = Math.max(inFrames, extra.inFrames);
    outFrames = Math.max(outFrames, extra.outFrames);
  }

  if (inFrames + outFrames > duration) {
    const total = inFrames + outFrames;
    inFrames = Math.floor((inFrames * duration) / total);
    outFrames = Math.floor((outFrames * duration) / total);
  }
  return { inFrames, outFrames };
}

function keyframeList(clip, property) {
  const list = clip?.keyframes !== null && typeof clip?.keyframes === 'object'
    ? clip.keyframes[property]
    : null;
  return Array.isArray(list) ? list : [];
}

function normalizeKeyframes(list) {
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const keyframe of list) {
    if (keyframe === null || typeof keyframe !== 'object') continue;
    const frame = Number(keyframe.frame);
    const value = Number(keyframe.value);
    if (!Number.isFinite(frame) || !Number.isFinite(value)) continue;
    entries.push({
      frame: Math.max(0, Math.round(frame)),
      value,
      easing: typeof keyframe.easing === 'string' ? keyframe.easing : 'linear',
    });
  }
  entries.sort((left, right) => left.frame - right.frame);
  const unique = [];
  for (const entry of entries) {
    if (unique.length > 0 && unique[unique.length - 1].frame === entry.frame) {
      unique[unique.length - 1] = entry;
    } else {
      unique.push(entry);
    }
  }
  return unique;
}

function easingExpression(easing, x) {
  switch (easing) {
    case 'ease-in':
      return `(${x})*(${x})`;
    case 'ease-out':
      return `1-(1-(${x}))*(1-(${x}))`;
    case 'ease-in-out':
      return `if(lt(${x},0.5),2*(${x})*(${x}),1-2*(1-(${x}))*(1-(${x})))`;
    case 'linear':
    default:
      return x;
  }
}

/**
 * Build a piecewise ffmpeg expression over `t` from relative-frame keyframes.
 * Values are multiplied by `scale` (e.g. project width for x keyframes) and
 * optionally clamped. The easing stored on a keyframe applies to the segment
 * that starts at that keyframe.
 *
 * @returns {string|null} expression, or null when there are no usable keyframes
 */
function buildKeyframeExpression(list, { fps, offsetSeconds = 0, scale = 1, clampMin = null, clampMax = null }) {
  const keyframes = normalizeKeyframes(list);
  if (keyframes.length === 0) return null;
  const points = keyframes.map((keyframe) => {
    let value = keyframe.value * scale;
    if (clampMin !== null) value = Math.max(clampMin, value);
    if (clampMax !== null) value = Math.min(clampMax, value);
    return {
      time: offsetSeconds + keyframe.frame / fps,
      value,
      easing: keyframe.easing,
    };
  });

  let expression = formatScalar(points[points.length - 1].value);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const from = points[index];
    const to = points[index + 1];
    const span = to.time - from.time;
    if (!(span > 0)) {
      expression = formatScalar(to.value);
      continue;
    }
    const progress = `(t-${formatSeconds(from.time)})/(${formatSeconds(span)})`;
    const eased = easingExpression(from.easing, progress);
    const segment = `${formatScalar(from.value)}+(${formatScalar(to.value)}-${formatScalar(from.value)})*(${eased})`;
    expression = `if(lt(t,${formatSeconds(to.time)}),${segment},${expression})`;
  }
  expression = `if(lt(t,${formatSeconds(points[0].time)}),${formatScalar(points[0].value)},${expression})`;
  return expression;
}

/** Resolve and validate `<projectRoot>/luts/<file>`; missing LUT is an error. */
function resolveLutPath(projectRoot, file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new ExportError('LUT effect requires params.file (a .cube file under <projectRoot>/luts/)', 'lut-missing');
  }
  const lutsDirectory = path.resolve(projectRoot, 'luts');
  const candidate = path.resolve(lutsDirectory, file);
  const relative = path.relative(lutsDirectory, candidate);
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ExportError(`LUT path escapes <projectRoot>/luts: ${file}`, 'invalid-input');
  }
  let info;
  try {
    info = statSync(candidate);
  } catch {
    throw new ExportError(`LUT file not found: ${file} (expected ${candidate})`, 'lut-missing');
  }
  if (!info.isFile()) {
    throw new ExportError(`LUT path is not a file: ${candidate}`, 'lut-missing');
  }
  return candidate;
}

/** `<projectRoot>/renders/<clipId>.png` when a browser render exists. */
function resolveRenderPngPath(projectRoot, clipId) {
  if (typeof clipId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(clipId)) return null;
  const rendersDirectory = path.resolve(projectRoot, 'renders');
  const candidate = path.join(rendersDirectory, `${clipId}.png`);
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function normalizeKeyColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^(?:#|0x)?([0-9a-f]{6})$/.exec(text);
  return match === null ? null : `0x${match[1]}`;
}

/**
 * Ordered effect chain for a visual clip. Returns filter fragments plus
 * whether an alpha-capable format was already introduced (chromakey).
 */
function buildEffectFilters(effects, projectRoot) {
  const parts = [];
  let hasAlpha = false;
  if (!Array.isArray(effects)) return { parts, hasAlpha };

  for (const effect of effects) {
    if (effect === null || typeof effect !== 'object') continue;
    if (effect.enabled === false) continue;
    const params = effect.params !== null && typeof effect.params === 'object' ? effect.params : {};

    switch (effect.type) {
      case 'brightness': {
        const amount = clampScalar(params.amount, 0, 2, 1);
        parts.push(`eq=brightness=${formatScalar(amount - 1)}`);
        break;
      }
      case 'contrast': {
        const amount = clampScalar(params.amount, 0, 2, 1);
        parts.push(`eq=contrast=${formatScalar(amount)}`);
        break;
      }
      case 'saturation': {
        const amount = clampScalar(params.amount, 0, 2, 1);
        parts.push(`eq=saturation=${formatScalar(amount)}`);
        break;
      }
      case 'temperature': {
        const amount = clampScalar(params.amount, -1, 1, 0);
        parts.push(`colorbalance=rs=${formatScalar(amount)}:bs=${formatScalar(-amount)}`);
        break;
      }
      case 'blur': {
        const radius = clampScalar(params.radius, 0, 30, 0);
        if (radius > 0) parts.push(`gblur=sigma=${formatScalar(radius)}`);
        break;
      }
      case 'sharpen': {
        const amount = clampScalar(params.amount, 0, 2, 0);
        if (amount > 0) {
          parts.push(
            `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${formatScalar(amount)}`,
          );
        }
        break;
      }
      case 'chromaKey': {
        const color = normalizeKeyColor(params.keyColor) ?? '0x00ff00';
        const similarity = clampScalar(params.similarity, 0.01, 0.5, 0.1);
        const blend = clampScalar(params.blend, 0, 0.5, 0);
        if (!hasAlpha) {
          parts.push('format=rgba');
          hasAlpha = true;
        }
        parts.push(
          `chromakey=color=${color}:similarity=${formatScalar(similarity)}:blend=${formatScalar(blend)}`,
        );
        break;
      }
      case 'lut': {
        const lutPath = resolveLutPath(projectRoot, params.file);
        parts.push(`lut3d=file=${escapeFilterValue(lutPath)}`);
        break;
      }
      default:
        // Unknown effect types are ignored (forward compatibility).
        break;
    }
  }
  return { parts, hasAlpha };
}

// ---------------------------------------------------------------------------
// drawtext
// ---------------------------------------------------------------------------

function drawtextOptions({ content, style, box, startSeconds, endSeconds }) {
  const fonts = detectFonts();
  const fontWeight = String(style?.fontWeight ?? '400');
  const fontFile = fontWeight === '600' || fontWeight === '700' ? fonts.bold : fonts.regular;
  const fontSize = Math.max(1, Math.round(Number(style?.fontSize) || 48));
  const color = String(style?.color ?? '#ffffff');
  const align = style?.align;

  let xExpression = String(box.x);
  if (align === 'center') xExpression = `${box.x}+(${box.width}-text_w)/2`;
  else if (align === 'right') xExpression = `${box.x}+${box.width}-text_w`;

  const options = [];
  if (fontFile !== null) options.push(`fontfile=${escapeFilterValue(fontFile)}`);
  options.push(`text=${escapeFilterValue(content)}`);
  options.push(`fontcolor=${escapeFilterValue(color)}`);
  options.push(`fontsize=${fontSize}`);
  options.push('expansion=none');
  if (style?.background !== undefined && style?.background !== null && String(style.background).length > 0) {
    options.push('box=1', `boxcolor=${escapeFilterValue(String(style.background))}`, 'boxborderw=6');
  }
  options.push(`x=${xExpression}`);
  options.push(`y=${box.y}`);
  options.push(
    `enable=${quoteFilterExpression(`between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`)}`,
  );
  return options.join(':');
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

  const root = path.resolve(projectRoot);
  const fps = normalizeFps(project);
  const width = normalizeDimension(project.width, DEFAULT_WIDTH);
  const height = normalizeDimension(project.height, DEFAULT_HEIGHT);
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = framesToSeconds(durationFrames, fps);
  const transitionFades = collectTransitionFades(project);

  const inputs = [
    '-f', 'lavfi',
    '-i', `color=c=black:s=${width}x${height}:r=${formatScalar(fps)}:d=${formatSeconds(durationSeconds)}`,
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

  const appendDrawtext = ({ content, style, box, startSeconds, endSeconds }) => {
    if (String(content).length === 0) return;
    const outputLabel = `b${counter}`;
    counter += 1;
    chains.push(
      `[${baseLabel}]drawtext=${drawtextOptions({ content, style, box, startSeconds, endSeconds })}[${outputLabel}]`,
    );
    baseLabel = outputLabel;
    hasVisual = true;
  };

  const addAudioChain = (clip, index, speed) => {
    const duration = clipDurationFrames(clip);
    const durationSecondsForClip = framesToSeconds(duration, fps);
    const sourceSeconds = framesToSeconds(duration * speed, fps);
    const parts = [`atrim=duration=${formatSeconds(sourceSeconds)}`, 'asetpts=PTS-STARTPTS'];

    if (speed !== 1) parts.push(...atempoChain(speed));

    const fades = fadesForClip(clip, transitionFades);
    if (fades.inFrames > 0) {
      parts.push(`afade=t=in:st=0:d=${formatSeconds(framesToSeconds(fades.inFrames, fps))}`);
    }
    if (fades.outFrames > 0) {
      parts.push(
        `afade=t=out:st=${formatSeconds(durationSecondsForClip - framesToSeconds(fades.outFrames, fps))}` +
        `:d=${formatSeconds(framesToSeconds(fades.outFrames, fps))}`,
      );
    }

    const volumeExpression = buildKeyframeExpression(keyframeList(clip, 'volume'), {
      fps,
      offsetSeconds: 0,
      scale: 1,
      clampMin: 0,
      clampMax: 1,
    });
    if (volumeExpression !== null) {
      parts.push(`volume=eval=frame:volume=${quoteFilterExpression(volumeExpression)}`);
    } else {
      parts.push(`volume=${formatScalar(clamp01(clip.volume ?? 1))}`);
    }

    const startMilliseconds = Math.max(0, Math.round(framesToSeconds(clip.startFrame ?? 0, fps) * 1000));
    parts.push(`adelay=${startMilliseconds}:all=1`);

    const label = `a${audioCounter}`;
    audioCounter += 1;
    chains.push(`[${index}:a]${parts.join(',')}[${label}]`);
    audioLabels.push(label);
  };

  const addVisualOverlay = (clip, index, speed) => {
    const startSeconds = framesToSeconds(clip.startFrame ?? 0, fps);
    const clipSeconds = framesToSeconds(clipDurationFrames(clip), fps);
    const endSeconds = startSeconds + clipSeconds;
    const box = geometryFor(clip.transform, width, height);
    const opacity = clamp01(clip.opacity ?? 1);
    const effects = buildEffectFilters(clip.effects, root);

    const parts = [`scale=${box.width}:${box.height}`, 'setsar=1', `fps=${formatScalar(fps)}`];
    parts.push(...effects.parts);
    let hasAlpha = effects.hasAlpha;
    if (opacity < 1) {
      if (!hasAlpha) {
        parts.push('format=rgba');
        hasAlpha = true;
      }
      parts.push(`colorchannelmixer=aa=${formatScalar(opacity)}`);
    }

    // Speed: DESIGN §11.3. Keep the legacy string for speed=1 so existing
    // project exports are unchanged.
    if (speed === 1) {
      parts.push(`setpts=PTS-STARTPTS+${formatSeconds(startSeconds)}/TB`);
    } else {
      parts.push(`setpts=(PTS-STARTPTS)/${formatScalar(speed)}+${formatSeconds(startSeconds)}/TB`);
    }

    const fades = fadesForClip(clip, transitionFades);
    if (fades.inFrames > 0) {
      parts.push(
        `fade=t=in:st=${formatSeconds(startSeconds)}` +
        `:d=${formatSeconds(framesToSeconds(fades.inFrames, fps))}`,
      );
    }
    if (fades.outFrames > 0) {
      parts.push(
        `fade=t=out:st=${formatSeconds(endSeconds - framesToSeconds(fades.outFrames, fps))}` +
        `:d=${formatSeconds(framesToSeconds(fades.outFrames, fps))}`,
      );
    }

    const label = `v${counter}`;
    counter += 1;
    chains.push(`[${index}:v]${parts.join(',')}[${label}]`);

    const xExpression = buildKeyframeExpression(keyframeList(clip, 'x'), {
      fps,
      offsetSeconds: startSeconds,
      scale: width,
    });
    const yExpression = buildKeyframeExpression(keyframeList(clip, 'y'), {
      fps,
      offsetSeconds: startSeconds,
      scale: height,
    });
    const overlayX = xExpression === null ? String(box.x) : quoteFilterExpression(xExpression);
    const overlayY = yExpression === null ? String(box.y) : quoteFilterExpression(yExpression);

    const outputLabel = `b${counter}`;
    counter += 1;
    const window = quoteFilterExpression(
      `between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`,
    );
    chains.push(
      `[${baseLabel}][${label}]overlay=x=${overlayX}:y=${overlayY}:enable=${window}[${outputLabel}]`,
    );
    baseLabel = outputLabel;
    hasVisual = true;
  };

  const addTextClip = (clip) => {
    const content = clip?.text !== null && typeof clip?.text === 'object'
      ? String(clip.text.content ?? '')
      : '';
    const renderPng = resolveRenderPngPath(root, clip.id);
    if (renderPng !== null) {
      // Browser-rendered text (backgrounds, wrapping) wins over drawtext.
      const durationFramesForClip = clipDurationFrames(clip);
      const index = addInput(
        ['-loop', '1', '-t', formatSeconds(framesToSeconds(durationFramesForClip, fps))],
        renderPng,
      );
      addVisualOverlay(clip, index, 1);
      return;
    }
    const style = clip.text !== null && typeof clip.text === 'object' ? clip.text : {};
    const startSeconds = framesToSeconds(clip.startFrame ?? 0, fps);
    const endSeconds = startSeconds + framesToSeconds(clipDurationFrames(clip), fps);
    appendDrawtext({
      content,
      style,
      box: geometryFor(clip.transform ?? DEFAULT_TEXT_TRANSFORM, width, height),
      startSeconds,
      endSeconds,
    });
  };

  const addCaptionClip = (clip) => {
    const renderPng = resolveRenderPngPath(root, clip.id);
    if (renderPng !== null) {
      const durationFramesForClip = clipDurationFrames(clip);
      const index = addInput(
        ['-loop', '1', '-t', formatSeconds(framesToSeconds(durationFramesForClip, fps))],
        renderPng,
      );
      addVisualOverlay(clip, index, 1);
      return;
    }

    const caption = clip.caption !== null && typeof clip.caption === 'object' ? clip.caption : {};
    const segments = Array.isArray(caption.segments) ? caption.segments : [];
    const style = caption.style !== null && typeof caption.style === 'object' ? caption.style : {};
    const box = geometryFor(clip.transform ?? DEFAULT_CAPTION_TRANSFORM, width, height);
    const clipStartFrame = Math.max(0, Math.round(Number(clip.startFrame) || 0));
    const clipDuration = clipDurationFrames(clip);
    const clipStartSeconds = framesToSeconds(clipStartFrame, fps);
    const clipEndSeconds = clipStartSeconds + framesToSeconds(clipDuration, fps);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === null || typeof segment !== 'object') continue;
      const segmentStartFrame = Math.max(0, Math.round(Number(segment.startFrame) || 0));
      const segmentDurationFrames = Math.min(
        Math.max(0, Math.round(Number(segment.durationFrames) || 0)),
        clipDuration - segmentStartFrame,
      );
      if (segmentDurationFrames <= 0) continue;
      const absoluteStartFrame = clipStartFrame + segmentStartFrame;

      // Host route /render also accepts one PNG per caption segment
      // (<clipId>-seg-<index>.png); prefer it over drawing the segment text.
      const segmentPng = resolveRenderPngPath(root, `${clip.id}-seg-${index}`);
      if (segmentPng !== null) {
        const segmentClip = {
          ...clip,
          startFrame: absoluteStartFrame,
          durationFrames: segmentDurationFrames,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          keyframes: {},
        };
        const inputIndex = addInput(
          ['-loop', '1', '-t', formatSeconds(framesToSeconds(segmentDurationFrames, fps))],
          segmentPng,
        );
        addVisualOverlay(segmentClip, inputIndex, 1);
        continue;
      }

      const content = String(segment.text ?? '');
      if (content.length === 0) continue;
      const startSeconds = framesToSeconds(absoluteStartFrame, fps);
      const endSeconds = Math.min(
        clipEndSeconds,
        startSeconds + framesToSeconds(segmentDurationFrames, fps),
      );
      if (!(endSeconds > startSeconds)) continue;
      appendDrawtext({ content, style, box, startSeconds, endSeconds });
    }
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
        const speed = speedForClip(clip);
        const durationFramesForClip = clipDurationFrames(clip);
        const sourceSeconds = framesToSeconds(durationFramesForClip * speed, fps);
        const trimSeconds = framesToSeconds(Math.max(0, Number(clip.trimStartFrame) || 0), fps);
        const index = addInput(
          ['-ss', formatSeconds(trimSeconds), '-t', formatSeconds(sourceSeconds)],
          mediaFilePath(root, media),
        );
        addAudioChain(clip, index, speed);
      }
      continue;
    }

    if (track.type !== 'video') continue;

    for (const clip of clips) {
      if (clip === null || typeof clip !== 'object') continue;

      if (clip.type === 'text') {
        if (!trackHidden) addTextClip(clip);
        continue;
      }

      if (clip.type === 'caption') {
        if (!trackHidden) addCaptionClip(clip);
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

      const speed = clip.type === 'video' ? speedForClip(clip) : 1;
      const durationFramesForClip = clipDurationFrames(clip);
      const sourceSeconds = framesToSeconds(durationFramesForClip * speed, fps);
      const trimSeconds = framesToSeconds(Math.max(0, Number(clip.trimStartFrame) || 0), fps);
      const prefix = clip.type === 'image'
        ? ['-loop', '1', '-t', formatSeconds(framesToSeconds(durationFramesForClip, fps))]
        : ['-ss', formatSeconds(trimSeconds), '-t', formatSeconds(sourceSeconds)];
      const index = addInput(prefix, mediaFilePath(root, media));

      if (wantsVisual) addVisualOverlay(clip, index, speed);
      if (wantsAudio) addAudioChain(clip, index, speed);
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
