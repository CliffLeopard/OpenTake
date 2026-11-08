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
 *   - transitions: `fadeToBlack` is a true dip-to-black via fades. `dissolve`,
 *     `wipeLeft` and `wipeRight` use a true overlapping `xfade` when both clips
 *     are opaque, full-frame, static and same-track butt-joined: the outgoing
 *     clip is extended past its end, the incoming clip is extended before its
 *     start, and both overlap by the transition window. When one side has no
 *     source headroom the window is redistributed to the other side (a true
 *     one-sided crossfade). If either clip is transformed/rotated/keyed or has
 *     visual keyframes, the pair degrades to the Phase 1 fade approximation.
 *     `xfade` works on opaque yuv frames, so transparency is a fallback
 *     condition. Chained transitions (a clip with transitions on both sides)
 *     also fall back to fades. Audio is crossfaded with `afade` ramps over the
 *     same window, so `amix` produces a proper audio crossfade.
 *   - crop: `clip.crop` (normalized, frame-relative, independent of transform)
 *     is applied with `crop=iw*W:ih*H:iw*X:ih*Y` BEFORE scale/rotate, then the
 *     cropped region is scaled into the transform box. It applies to
 *     video/image and to browser-rendered text/caption PNGs; drawtext-only
 *     text/caption clips ignore crop (documented limitation). Cropped clips
 *     fall back from true xfade transitions to the fade approximation (xfade
 *     requires full-frame opaque layers).
 *   - mask: `clip.mask` (rect/ellipse, feather, invert; normalized to the
 *     transform box) replaces the RGBA alpha plane with a `geq` expression
 *     after crop/scale/rotation. It applies to video/image and to
 *     browser-rendered text/caption PNGs; drawtext-only clips cannot be
 *     masked. `geq` alpha values are 0..255, so the mask expression is scaled.
 *   - blend modes: `clip.blendMode` (screen/multiply/overlay/darken/lighten/
 *     add/difference) composites full-frame clips (transform 0,0,1,1) with
 *     `blend=all_mode=...`; clips with rotation/crop/mask, non-full-frame
 *     transforms, visual keyframes or alpha effects fall back to `overlay`.
 *     `normal` is unchanged. True xfade transitions also exclude blended clips.
 *   - track volume: `Track.volume` (0..2, default 1) multiplies every audio
 *     chain on that track after clip volume/keyframes; `muted` still wins.
 *   - rotation: static `transform.rotation` is applied with `rotate` on an
 *     expanded transparent canvas and then fitted back inside the transform
 *     box (letterboxed, centered). Rotation keyframes are NOT supported in
 *     export; the static rotation is used. drawtext-only text/caption clips
 *     cannot be rotated (PNG-rendered overlays can).
 *   - export options: `buildExportArgs`/`runExport` accept
 *     `{ codec?: 'h264'|'h265'|'prores'|'vp9', container?, width?, height?,
 *     fps?, crf?, bitrate? }`. Codecs: h264 (libx264, .mp4), h265 (libx265,
 *     .mp4), prores (prores_ks profile 3 / yuv422p10le + pcm_s16le, .mov) and
 *     vp9 / alias webm (libvpx-vp9 CRF `-b:v 0` or bitrate + libopus, .webm).
 *     ProRes ignores CRF (profile/bitrate based). `defaultExtensionForCodec`
 *     exposes the default output extension to the Host. Output resolution is
 *     scaled from the normalized transforms; fps is an output `-r` override
 *     while timeline timing stays on project fps. H.264 remains the default.
 *
 * Text rendering still depends on a system font (`drawtext` needs an ffmpeg
 * build with libfreetype).
 */

import { execFileSync } from 'node:child_process';
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

/** clip.blendMode -> ffmpeg blend `all_mode` (DESIGN §12). */
const BLEND_MODE_MAP = Object.freeze({
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'addition',
  difference: 'difference',
});
const TRUE_TRANSITION_TYPES = new Set(['dissolve', 'wipeLeft', 'wipeRight']);
const XFADE_NAMES = Object.freeze({
  dissolve: 'dissolve',
  wipeLeft: 'wipeleft',
  wipeRight: 'wiperight',
});

/** Codecs accepted by `options.codec`. */
export const EXPORT_CODECS = Object.freeze(['h264', 'h265', 'prores', 'vp9']);

const CODEC_ALIASES = new Map([
  ['h264', 'h264'], ['avc', 'h264'],
  ['h265', 'h265'], ['hevc', 'h265'],
  ['prores', 'prores'], ['prores_ks', 'prores'],
  ['vp9', 'vp9'], ['webm', 'vp9'], ['libvpx-vp9', 'vp9'],
]);

const DEFAULT_CONTAINER_FOR_CODEC = Object.freeze({
  h264: 'mp4',
  h265: 'mp4',
  prores: 'mov',
  vp9: 'webm',
});

const ALLOWED_CONTAINERS_FOR_CODEC = Object.freeze({
  h264: Object.freeze(['mp4', 'mov']),
  h265: Object.freeze(['mp4', 'mov']),
  prores: Object.freeze(['mov']),
  vp9: Object.freeze(['webm']),
});

function normalizeCodecName(value) {
  const raw = value === undefined || value === null ? 'h264' : String(value).toLowerCase();
  const codec = CODEC_ALIASES.get(raw);
  if (codec === undefined) {
    throw new ExportError(
      `Unsupported export codec: ${String(value)} (expected one of ${EXPORT_CODECS.join(', ')})`,
      'invalid-input',
    );
  }
  return codec;
}

/** Default container for a codec ('mp4'|'mov'|'webm'). */
export function defaultContainerForCodec(codec) {
  return DEFAULT_CONTAINER_FOR_CODEC[normalizeCodecName(codec)];
}

/** Default output extension (with dot) for a codec: '.mp4', '.mov' or '.webm'. */
export function defaultExtensionForCodec(codec) {
  return `.${defaultContainerForCodec(codec)}`;
}

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
 * Add a fade contribution for a clip (used by `fadeToBlack` and by any
 * transition that cannot be rendered as a true overlap).
 */
function addTransitionFade(additions, clipId, key, frames) {
  const entry = additions.get(clipId) ?? { inFrames: 0, outFrames: 0 };
  entry[key] = Math.max(entry[key], frames);
  additions.set(clipId, entry);
}

function transformIsFullFrame(transform) {
  const normalized = normalizeTransform(transform);
  return (
    Math.abs(normalized.x) < 1e-6 &&
    Math.abs(normalized.y) < 1e-6 &&
    Math.abs(normalized.width - 1) < 1e-6 &&
    Math.abs(normalized.height - 1) < 1e-6
  );
}

function clipHasVisualKeyframes(clip) {
  const keyframes = clip?.keyframes;
  if (keyframes === null || typeof keyframes !== 'object') return false;
  // Volume keyframes do not change the rendered layer, so they do not block a
  // true visual transition.
  return ['opacity', 'x', 'y', 'width', 'height', 'rotation']
    .some((property) => Array.isArray(keyframes[property]) && keyframes[property].length > 0);
}

function clipEffectsProduceAlpha(clip) {
  const effects = Array.isArray(clip?.effects) ? clip.effects : [];
  return effects.some(
    (effect) => effect !== null && typeof effect === 'object' &&
      effect.enabled !== false && effect.type === 'chromaKey',
  );
}

function normalizeBlendMode(value) {
  if (typeof value !== 'string') return 'normal';
  const mode = value.toLowerCase();
  if (mode === 'normal') return 'normal';
  return Object.prototype.hasOwnProperty.call(BLEND_MODE_MAP, mode) ? mode : 'normal';
}

function blendFilterMode(value) {
  const mode = normalizeBlendMode(value);
  return mode === 'normal' ? null : BLEND_MODE_MAP[mode];
}

/** Track volume is 0..2, default 1 (mute handled separately). */
function normalizeTrackVolume(track) {
  const volume = Number(track?.volume);
  if (!Number.isFinite(volume)) return 1;
  return Math.min(2, Math.max(0, volume));
}

function clampAlphaExpression(expression) {
  return `min(1,max(0,${expression}))`;
}

function smoothstepExpression(progress) {
  return `(${progress})*(${progress})*(3-2*(${progress}))`;
}

/**
 * Alpha (0..1) expression for a clip mask in transform-box normalized space.
 * `rotation` supplies the pixel offset when the layer was fitted into the box.
 */
function maskAlphaExpression(mask, box, rotation) {
  const offsetX = rotation === null ? 0 : rotation.offsetX;
  const offsetY = rotation === null ? 0 : rotation.offsetY;
  const normalizedX = `((X+${formatScalar(offsetX)})/${formatScalar(box.width)})`;
  const normalizedY = `((Y+${formatScalar(offsetY)})/${formatScalar(box.height)})`;

  const minimum = 1e-6;
  const x = clampScalar(mask.x, 0, 1, 0);
  const y = clampScalar(mask.y, 0, 1, 0);
  let width = clampScalar(mask.width, minimum, 1, 1);
  let height = clampScalar(mask.height, minimum, 1, 1);
  if (x + width > 1) width = Math.max(minimum, 1 - x);
  if (y + height > 1) height = Math.max(minimum, 1 - y);
  const feather = clampScalar(mask.feather, 0, 1, 0);

  let alpha;
  if (mask.shape === 'ellipse') {
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const radiusX = width / 2;
    const radiusY = height / 2;
    const dx = `((${normalizedX}-${formatScalar(centerX)})/${formatScalar(radiusX)})`;
    const dy = `((${normalizedY}-${formatScalar(centerY)})/${formatScalar(radiusY)})`;
    const distance = `sqrt((${dx})*(${dx})+(${dy})*(${dy}))`;
    if (feather > 0) {
      alpha = smoothstepExpression(
        clampAlphaExpression(`(1-(${distance}))/${formatScalar(feather)}`),
      );
    } else {
      alpha = `lte(${distance},1)`;
    }
  } else if (mask.shape === 'rect') {
    const u = `((${normalizedX}-${formatScalar(x)})/${formatScalar(width)})`;
    const v = `((${normalizedY}-${formatScalar(y)})/${formatScalar(height)})`;
    if (feather > 0) {
      const edgeU = clampAlphaExpression(`min(${u},1-(${u}))/${formatScalar(feather)}`);
      const edgeV = clampAlphaExpression(`min(${v},1-(${v}))/${formatScalar(feather)}`);
      alpha = `${smoothstepExpression(edgeU)}*${smoothstepExpression(edgeV)}`;
    } else {
      alpha = `gte(${u},0)*lte(${u},1)*gte(${v},0)*lte(${v},1)`;
    }
  } else {
    return null;
  }

  if (mask.invert === true) alpha = `1-(${alpha})`;
  return clampAlphaExpression(alpha);
}

/** ffmpeg `geq` filter that replaces the alpha plane with the mask. */
function maskFilterFor(mask, box, rotation) {
  if (mask === null || typeof mask !== 'object') return null;
  const alpha = maskAlphaExpression(mask, box, rotation);
  if (alpha === null) return null;
  // geq works on 0..255 channel values for the 8-bit rgba format we force.
  return (
    `geq=r=${quoteFilterExpression('r(X,Y)')}` +
    `:g=${quoteFilterExpression('g(X,Y)')}` +
    `:b=${quoteFilterExpression('b(X,Y)')}` +
    `:a=${quoteFilterExpression(`255*(${alpha})`)}`
  );
}

/**
 * Blend mode applies only to full-frame clips with no rotation/crop/mask and no
 * visual keyframes (DESIGN §12.1); otherwise the normal overlay is used.
 */
function blendModeForClip(clip, { rotation, cropFilter, maskFilter }) {
  const mode = blendFilterMode(clip.blendMode);
  if (mode === null) return null;
  if (rotation !== null || cropFilter !== null || maskFilter !== null) return null;
  if (!transformIsFullFrame(clip.transform)) return null;
  if (clipHasVisualKeyframes(clip)) return null;
  if (clipEffectsProduceAlpha(clip)) return null;
  return mode;
}

/**
 * True overlap transitions need two opaque, full-frame, static layers so that
 * `xfade` (which works on yuv frames without alpha) cannot lose transparency or
 * have to reconcile different transform boxes.
 */
function canUseTrueTransition(fromEntry, toEntry) {
  for (const entry of [fromEntry, toEntry]) {
    const clip = entry.clip;
    if (!['video', 'image'].includes(clip.type)) return false;
    const rotation = Number(clip.transform?.rotation) || 0;
    if (Math.abs(rotation) > 1e-6) return false;
    if (clip.crop !== null && clip.crop !== undefined) return false;
    if (clip.mask !== null && clip.mask !== undefined) return false;
    if (blendFilterMode(clip.blendMode) !== null) return false;
    if (!transformIsFullFrame(clip.transform)) return false;
    if (clamp01(clip.opacity ?? 1) < 1) return false;
    if (clipHasVisualKeyframes(clip)) return false;
    if (clipEffectsProduceAlpha(clip)) return false;
  }
  return true;
}

/**
 * Decide how every project transition is rendered.
 *
 * Returns:
 *   truePlans: Map fromClipId -> { from, to, sideA, sideB, xfade, transition }
 *   fadeAdditions: Map clipId -> { inFrames, outFrames } (fallback/fadeToBlack)
 */
function planTransitions(project, fps) {
  const truePlans = new Map();
  const fadeAdditions = new Map();
  const transitions = Array.isArray(project?.transitions) ? project.transitions : [];

  const entries = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip !== null && typeof clip === 'object' && typeof clip.id === 'string') {
        entries.set(clip.id, { clip, track });
      }
    }
  }

  // First pass: validate transitions and count how many touch each clip.
  const validTransitions = [];
  const touchCounts = new Map();
  for (const transition of transitions) {
    if (transition === null || typeof transition !== 'object') continue;
    if (!TRANSITION_TYPES.has(transition.type)) continue;
    const duration = Number(transition.durationFrames);
    if (!Number.isFinite(duration) || duration < 1) continue;
    const from = entries.get(transition.fromClipId);
    const to = entries.get(transition.toClipId);
    if (from === undefined || to === undefined) continue;
    if (!['video', 'image'].includes(from.clip.type)) continue;
    if (!['video', 'image'].includes(to.clip.type)) continue;
    if (from.track.id !== to.track.id || from.track.type !== 'video') continue;
    if (from.clip.startFrame + from.clip.durationFrames !== to.clip.startFrame) continue;
    validTransitions.push({ transition, from, to, duration });
    touchCounts.set(from.clip.id, (touchCounts.get(from.clip.id) ?? 0) + 1);
    touchCounts.set(to.clip.id, (touchCounts.get(to.clip.id) ?? 0) + 1);
  }

  for (const item of validTransitions) {
    const { transition, from, to, duration } = item;
    const fallbackHalf = Math.max(1, Math.round(duration / 2));

    if (TRUE_TRANSITION_TYPES.has(transition.type)) {
      const plan = buildTrueTransitionPlan(project, item, touchCounts, fps);
      if (plan !== null) {
        truePlans.set(from.clip.id, plan);
        continue;
      }
    }

    addTransitionFade(fadeAdditions, from.clip.id, 'outFrames', Math.min(fallbackHalf, clipDurationFrames(from.clip)));
    addTransitionFade(fadeAdditions, to.clip.id, 'inFrames', Math.min(fallbackHalf, clipDurationFrames(to.clip)));
  }

  return { truePlans, fadeAdditions };
}

/**
 * Compute the overlap window for a true transition, clamping the source
 * extension to the headroom actually present in each media file. Returns null
 * when the pair must fall back to fades.
 */
function buildTrueTransitionPlan(project, item, touchCounts, fps) {
  const { transition, from, to, duration } = item;

  // A clip in two transitions would need a chained xfade graph; fall back.
  if ((touchCounts.get(from.clip.id) ?? 0) !== 1) return null;
  if ((touchCounts.get(to.clip.id) ?? 0) !== 1) return null;
  if (from.track.hidden === true) return null;
  if (!canUseTrueTransition(from, to)) return null;
  if (duration < 2) return null;

  const mediaA = findMedia(project, from.clip.mediaId);
  const mediaB = findMedia(project, to.clip.mediaId);
  if (mediaA === null || mediaB === null) return null;

  const speedA = speedForClip(from.clip);
  const speedB = speedForClip(to.clip);
  const durationA = clipDurationFrames(from.clip);
  const durationB = clipDurationFrames(to.clip);
  const trimA = Math.max(0, Math.round(Number(from.clip.trimStartFrame) || 0));
  const trimB = Math.max(0, Math.round(Number(to.clip.trimStartFrame) || 0));
  const startB = Math.max(0, Math.round(Number(to.clip.startFrame) || 0));

  // Source headroom beyond the outgoing clip's source window and before the
  // incoming clip's source start (both in source frames).
  const sourceFramesA = Number(mediaA.durationFrames);
  const sourceFramesB = Number(mediaB.durationFrames);
  const availableA = Number.isFinite(sourceFramesA)
    ? Math.floor(Math.max(0, sourceFramesA - (trimA + Math.round(durationA * speedA))) / speedA)
    : 0;
  const availableB = Number.isFinite(sourceFramesB)
    ? Math.floor(Math.max(0, trimB) / speedB)
    : 0;

  const requestedA = Math.max(1, Math.floor(duration / 2));
  const requestedB = Math.max(1, duration - requestedA);
  // Keep the overlap inside both clips and inside the timeline. A side may be
  // clamped to 0 when the source has no headroom (e.g. trimStart 0 or the
  // media ends exactly at the cut).
  let sideA = Math.max(0, Math.min(requestedA, availableA, durationB));
  let sideB = Math.max(0, Math.min(requestedB, availableB, durationA, startB));

  // If one side lost frames to clamping, grow the other side so the rendered
  // transition still uses as much of the requested duration as possible.
  let deficit = duration - (sideA + sideB);
  if (deficit > 0) {
    const growA = Math.min(
      deficit,
      Math.max(0, availableA - sideA),
      Math.max(0, durationB - sideA),
    );
    sideA += growA;
    deficit -= growA;
  }
  if (deficit > 0) {
    const growB = Math.min(
      deficit,
      Math.max(0, availableB - sideB),
      Math.max(0, durationA - sideB),
      Math.max(0, startB - sideB),
    );
    sideB += growB;
    deficit -= growB;
  }
  if (deficit > 0) {
    const growA = Math.min(
      deficit,
      Math.max(0, availableA - sideA),
      Math.max(0, durationB - sideA),
    );
    sideA += growA;
  }

  if (sideA + sideB < 1) return null;

  return {
    transition,
    from,
    to,
    sideA,
    sideB,
    xfade: XFADE_NAMES[transition.type],
  };
}

/** Effective fade frames for a clip (own fades + transition fallback). */
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
// Export presets/options, encoder detection and rotation geometry
// ---------------------------------------------------------------------------

let encoderCache = null;

/**
 * Detect available video encoders once per ffmpeg binary. Kept out of the pure
 * core where possible: results are cached and only re-read when the resolved
 * ffmpeg path changes (tests manipulate PATH/OPENTAKE_STUDIO_FFMPEG).
 */
function detectEncoders() {
  const tools = resolveTools();
  if (encoderCache !== null && encoderCache.ffmpeg === tools.ffmpeg) return encoderCache;

  const names = new Set();
  if (tools.ffmpeg !== null) {
    try {
      const stdout = execFileSync(tools.ffmpeg, ['-hide_banner', '-encoders'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const line of String(stdout).split('\n')) {
        const match = /^\s*([VA])[A-Za-z.]*\s+(\S+)/.exec(line);
        if (match !== null) names.add(match[2]);
      }
    } catch {
      // Encoder probing is best-effort; unavailable tools are reported later.
    }
  }

  encoderCache = {
    ffmpeg: tools.ffmpeg,
    h264: names.has('libx264') ? 'libx264' : names.has('h264_videotoolbox') ? 'h264_videotoolbox' : null,
    h265: names.has('libx265') ? 'libx265' : names.has('hevc_videotoolbox') ? 'hevc_videotoolbox' : null,
    prores: names.has('prores_ks') ? 'prores_ks' : names.has('prores_videotoolbox') ? 'prores_videotoolbox' : null,
    vp9: names.has('libvpx-vp9') ? 'libvpx-vp9' : names.has('vp9_videotoolbox') ? 'vp9_videotoolbox' : null,
    libopus: names.has('libopus') ? 'libopus' : null,
  };
  return encoderCache;
}

function evenDimension(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 2) {
    throw new ExportError(`Export ${name} must be a number >= 2`, 'invalid-input');
  }
  const rounded = Math.round(number);
  return Math.max(2, rounded % 2 === 0 ? rounded : rounded + 1);
}

function validateExportFps(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 240) {
    throw new ExportError('Export fps must be a number between 1 and 240', 'invalid-input');
  }
  return number;
}

function validateExportCrf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 51) {
    throw new ExportError('Export crf must be a number between 0 and 51', 'invalid-input');
  }
  return number;
}

function normalizeExportBitrate(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ExportError('Export bitrate must be a positive number (kbps) or string like 5M', 'invalid-input');
    }
    return `${Math.round(value)}k`;
  }
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?[kKmM]?$/.test(text)) {
    throw new ExportError('Export bitrate must look like 800k, 5M or a kbps number', 'invalid-input');
  }
  return text;
}

/**
 * Normalize export settings; `null`/undefined fields fall back to project
 * defaults so existing exports are byte-for-byte unchanged.
 */
function normalizeExportOptions(project, rawOptions) {
  const options = rawOptions !== null && typeof rawOptions === 'object' ? rawOptions : {};
  const projectFps = normalizeFps(project);
  const projectWidth = normalizeDimension(project.width, DEFAULT_WIDTH);
  const projectHeight = normalizeDimension(project.height, DEFAULT_HEIGHT);

  const codec = normalizeCodecName(options.codec);
  const allowedContainers = ALLOWED_CONTAINERS_FOR_CODEC[codec];
  let container = DEFAULT_CONTAINER_FOR_CODEC[codec];
  const containerExplicit = options.container !== undefined;
  if (containerExplicit) {
    container = String(options.container).toLowerCase();
    if (!allowedContainers.includes(container)) {
      throw new ExportError(
        `Container ${String(options.container)} is not supported for ${codec} ` +
        `(expected ${allowedContainers.join(' or ')})`,
        'invalid-input',
      );
    }
  }

  const defaultCrf = codec === 'h265' ? 23 : codec === 'vp9' ? 31 : 20;

  return {
    codec,
    container,
    containerExplicit,
    width: options.width === undefined ? projectWidth : evenDimension(options.width, 'width'),
    height: options.height === undefined ? projectHeight : evenDimension(options.height, 'height'),
    fps: options.fps === undefined ? projectFps : validateExportFps(options.fps),
    fpsProvided: options.fps !== undefined,
    // For prores the CRF is accepted but ignored (ProRes is profile/bitrate based).
    crf: options.crf === undefined ? defaultCrf : validateExportCrf(options.crf),
    bitrate: options.bitrate === undefined ? null : normalizeExportBitrate(options.bitrate),
  };
}

const ENCODER_LABELS = Object.freeze({
  h264: 'H.264', h265: 'H.265', prores: 'ProRes', vp9: 'VP9',
});

const ENCODER_FALLBACKS = Object.freeze({
  h264: 'libx264',
  h265: 'libx265',
  prores: 'prores_ks',
  vp9: 'libvpx-vp9',
});

function requireVideoEncoder(settings) {
  const encoders = detectEncoders();
  const encoder = encoders[settings.codec];
  if (encoder !== null) return encoder;
  if (resolveTools().ffmpeg === null) {
    // Keep the argv buildable; runExport reports ffmpeg-unavailable.
    return ENCODER_FALLBACKS[settings.codec];
  }
  throw new ExportError(
    `No ${ENCODER_LABELS[settings.codec] ?? settings.codec} encoder available in the installed ffmpeg`,
    'encoder-unavailable',
  );
}

/** Video encoder argv for the normalized settings. */
function videoEncodeArgs(settings) {
  const encoder = requireVideoEncoder(settings);
  const args = ['-c:v', encoder];

  switch (settings.codec) {
    case 'prores': {
      // ProRes is profile/bitrate based; CRF is accepted but ignored.
      args.push('-profile:v', '3', '-pix_fmt', 'yuv422p10le');
      if (settings.bitrate !== null) args.push('-b:v', settings.bitrate);
      break;
    }
    case 'vp9': {
      args.push('-pix_fmt', 'yuv420p');
      if (settings.bitrate !== null) {
        // Bitrate mode: no constant-quality -crf.
        args.push('-b:v', settings.bitrate);
      } else {
        // libvpx constant-quality mode.
        args.push('-crf', formatScalar(settings.crf), '-b:v', '0');
      }
      break;
    }
    case 'h264':
    case 'h265':
    default: {
      if (encoder === 'libx265') args.push('-tag:v', 'hvc1');
      args.push('-pix_fmt', 'yuv420p');
      if (encoder === 'libx264' || encoder === 'libx265') {
        args.push('-preset', 'veryfast');
        if (settings.bitrate !== null) args.push('-b:v', settings.bitrate);
        else args.push('-crf', formatScalar(settings.crf));
      } else {
        // VideoToolbox encoders do not accept -crf/-preset.
        args.push('-b:v', settings.bitrate ?? '8M');
      }
      break;
    }
  }
  return args;
}

/** Audio encoder/maps for the effective container and codec. */
function audioEncodeArgs(settings, hasAudio) {
  if (!hasAudio) return ['-an'];
  const args = ['-map', '[aout]'];
  switch (settings.codec) {
    case 'prores':
      args.push('-c:a', 'pcm_s16le');
      break;
    case 'vp9': {
      const encoders = detectEncoders();
      if (encoders.libopus === null && resolveTools().ffmpeg !== null) {
        throw new ExportError(
          'No Opus (libopus) audio encoder available for WebM export',
          'encoder-unavailable',
        );
      }
      args.push('-c:a', 'libopus', '-b:a', '128k');
      break;
    }
    case 'h264':
    case 'h265':
    default:
      args.push('-c:a', 'aac', '-b:a', '192k');
      break;
  }
  return args;
}

/**
 * Normalized crop -> `crop` filter. The rect is relative to the source frame
 * (or to a browser-rendered PNG for text/caption clips) and is independent of
 * `transform`: the crop happens first, then the cropped region is scaled into
 * the transform box (and rotated if needed).
 *
 * Values are clamped defensively even though model.js validates them.
 */
function cropFilterFor(crop) {
  if (crop === null || typeof crop !== 'object') return null;
  const minimum = 1e-6;
  let x = clampScalar(crop.x, 0, 1, 0);
  let y = clampScalar(crop.y, 0, 1, 0);
  let width = clampScalar(crop.width, minimum, 1, 1);
  let height = clampScalar(crop.height, minimum, 1, 1);
  if (x + width > 1) width = Math.max(minimum, 1 - x);
  if (y + height > 1) height = Math.max(minimum, 1 - y);
  if (x > 1 - minimum) x = 1 - minimum;
  if (y > 1 - minimum) y = 1 - minimum;
  return `crop=w=iw*${formatScalar(width)}:h=ih*${formatScalar(height)}` +
    `:x=iw*${formatScalar(x)}:y=ih*${formatScalar(y)}`;
}

/**
 * Rotation geometry for one visual clip. Rotates on an expanded transparent
 * canvas (so nothing is clipped) and then fits the result inside the transform
 * box, centered. Returns null for an unrotated clip.
 */
function rotationPlan(box, rotationDegrees) {
  const rotation = Number(rotationDegrees);
  if (!Number.isFinite(rotation) || Math.abs(rotation) < 1e-6) return null;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const rotatedWidth = Math.max(1, Math.ceil(box.width * cos + box.height * sin - 1e-6));
  const rotatedHeight = Math.max(1, Math.ceil(box.width * sin + box.height * cos - 1e-6));
  const fit = Math.min(box.width / rotatedWidth, box.height / rotatedHeight);
  const width = Math.max(1, Math.round(rotatedWidth * fit));
  const height = Math.max(1, Math.round(rotatedHeight * fit));
  return {
    radians,
    rotatedWidth,
    rotatedHeight,
    width,
    height,
    offsetX: Math.round((box.width - width) / 2),
    offsetY: Math.round((box.height - height) / 2),
  };
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
 * @param {{ project: object, projectRoot: string, outputPath: string,
 *   options?: { codec?: string, container?: string, width?: number,
 *   height?: number, fps?: number, crf?: number, bitrate?: string|number } }} input
 * @returns {{ args: string[], durationFrames: number, codec: string, container: string }}
 */
export function buildExportArgs({ project, projectRoot, outputPath, options, ...inlineOptions } = {}) {
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
  const settings = normalizeExportOptions(project, options ?? inlineOptions);
  // All normalized geometry is expressed against the *output* resolution.
  const width = settings.width;
  const height = settings.height;
  const durationFrames = timelineDurationFrames(project);
  const durationSeconds = framesToSeconds(durationFrames, fps);
  const transitionPlan = planTransitions(project, fps);
  const transitionFades = transitionPlan.fadeAdditions;
  const trueTransitions = transitionPlan.truePlans;
  const coveredClipIds = new Set();

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

  const appendClipVolume = (parts, clip, trackVolume) => {
    const volumeExpression = buildKeyframeExpression(keyframeList(clip, 'volume'), {
      fps,
      offsetSeconds: 0,
      scale: 1,
      clampMin: 0,
      clampMax: 1,
    });
    if (volumeExpression !== null) {
      const scaled = trackVolume === 1
        ? volumeExpression
        : `(${volumeExpression})*${formatScalar(trackVolume)}`;
      parts.push(`volume=eval=frame:volume=${quoteFilterExpression(scaled)}`);
    } else {
      parts.push(`volume=${formatScalar(clamp01(clip.volume ?? 1) * trackVolume)}`);
    }
  };

  const addAudioChain = (clip, index, speed, trackVolume = 1) => {
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

    appendClipVolume(parts, clip, trackVolume);

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
    const rotation = rotationPlan(box, clip.transform?.rotation);
    const cropFilter = cropFilterFor(clip.crop);
    const maskFilter = maskFilterFor(clip.mask, box, rotation);
    const blendMode = blendModeForClip(clip, {
      rotation,
      cropFilter,
      maskFilter,
    });

    const parts = [];
    if (cropFilter !== null) parts.push(cropFilter);
    parts.push(`scale=${box.width}:${box.height}`, 'setsar=1', `fps=${formatScalar(fps)}`);
    parts.push(...effects.parts);
    let hasAlpha = effects.hasAlpha;

    if (rotation !== null) {
      if (!hasAlpha) {
        parts.push('format=rgba');
        hasAlpha = true;
      }
      parts.push(
        `rotate=${formatScalar(rotation.radians)}` +
        `:ow=${rotation.rotatedWidth}:oh=${rotation.rotatedHeight}:fillcolor=none`,
      );
      // Fit the rotated bounding box back inside the transform box (no crop).
      if (rotation.width !== box.width || rotation.height !== box.height) {
        parts.push(`scale=${rotation.width}:${rotation.height}`);
      }
    }

    if (maskFilter !== null) {
      // Mask alpha is applied after crop/scale/rotation, before opacity/overlay.
      if (!hasAlpha) {
        parts.push('format=rgba');
        hasAlpha = true;
      }
      parts.push(maskFilter);
    }

    if (opacity < 1 && blendMode === null) {
      if (!hasAlpha) {
        parts.push('format=rgba');
        hasAlpha = true;
      }
      parts.push(`colorchannelmixer=aa=${formatScalar(opacity)}`);
    }

    if (blendMode !== null) {
      // blend needs matching yuv420p frames from both inputs.
      parts.push('format=yuv420p');
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
    const offsetX = rotation === null ? 0 : rotation.offsetX;
    const offsetY = rotation === null ? 0 : rotation.offsetY;
    const overlayX = xExpression === null
      ? String(box.x + offsetX)
      : quoteFilterExpression(offsetX === 0 ? xExpression : `(${xExpression})+${offsetX}`);
    const overlayY = yExpression === null
      ? String(box.y + offsetY)
      : quoteFilterExpression(offsetY === 0 ? yExpression : `(${yExpression})+${offsetY}`);

    const outputLabel = `b${counter}`;
    counter += 1;
    const window = quoteFilterExpression(
      `between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`,
    );
    if (blendMode !== null) {
      const blendOptions = [`all_mode=${blendMode}`];
      if (opacity < 1) blendOptions.push(`all_opacity=${formatScalar(opacity)}`);
      blendOptions.push(`enable=${window}`);
      chains.push(
        `[${baseLabel}][${label}]blend=${blendOptions.join(':')}[${outputLabel}]`,
      );
    } else {
      chains.push(
        `[${baseLabel}][${label}]overlay=x=${overlayX}:y=${overlayY}:enable=${window}[${outputLabel}]`,
      );
    }
    baseLabel = outputLabel;
    hasVisual = true;
  };

  /**
   * True overlapping transition: both clips are opaque full-frame layers, so
   * they can be fused with `xfade` (dissolve/wipe). The outgoing clip's source
   * is extended past its end and the incoming clip's source is extended before
   * its start; the pair then replaces both clips as one overlay layer.
   */
  const addTrueTransition = (plan) => {
    const { from, to, sideA, sideB, xfade } = plan;
    const clipA = from.clip;
    const clipB = to.clip;
    const mediaA = findMedia(project, clipA.mediaId);
    const mediaB = findMedia(project, clipB.mediaId);
    if (mediaA === null || mediaB === null) return false;

    const speedA = speedForClip(clipA);
    const speedB = speedForClip(clipB);
    const framesA = clipDurationFrames(clipA);
    const framesB = clipDurationFrames(clipB);
    const layerFramesA = framesA + sideA;
    const layerFramesB = framesB + sideB;
    const trimA = Math.max(0, Math.round(Number(clipA.trimStartFrame) || 0));
    const trimB = Math.max(0, Math.round(Number(clipB.trimStartFrame) || 0) - Math.round(sideB * speedB));
    const transitionSeconds = framesToSeconds(sideA + sideB, fps);
    const offsetSeconds = framesToSeconds(framesA - sideB, fps);

    const inputPrefix = (clip, layerFrames, speed, trimFrames) => (
      clip.type === 'image'
        ? ['-loop', '1', '-t', formatSeconds(framesToSeconds(layerFrames, fps))]
        : ['-ss', formatSeconds(framesToSeconds(trimFrames, fps)), '-t', formatSeconds(framesToSeconds(layerFrames * speed, fps))]
    );
    const indexA = addInput(inputPrefix(clipA, layerFramesA, speedA, trimA), mediaFilePath(root, mediaA));
    const indexB = addInput(inputPrefix(clipB, layerFramesB, speedB, trimB), mediaFilePath(root, mediaB));

    const addTransitionLayer = (clip, index, layerFrames, leadFrames, speed) => {
      const box = geometryFor(clip.transform, width, height);
      const effects = buildEffectFilters(clip.effects, root);
      const parts = [
        `scale=${box.width}:${box.height}`,
        'setsar=1',
        `fps=${formatScalar(fps)}`,
        ...effects.parts,
        'format=yuv420p',
        speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${formatScalar(speed)}`,
      ];
      // True layers are opaque by construction (eligibility check), so only
      // the clip's own fades are applied.
      const ownFades = fadesForClip(clip, new Map());
      if (ownFades.inFrames > 0) {
        parts.push(`fade=t=in:st=${formatSeconds(framesToSeconds(leadFrames, fps))}` +
          `:d=${formatSeconds(framesToSeconds(ownFades.inFrames, fps))}`);
      }
      if (ownFades.outFrames > 0) {
        parts.push(
          `fade=t=out:st=${formatSeconds(framesToSeconds(leadFrames + clipDurationFrames(clip) - ownFades.outFrames, fps))}` +
          `:d=${formatSeconds(framesToSeconds(ownFades.outFrames, fps))}`,
        );
      }
      const label = `v${counter}`;
      counter += 1;
      chains.push(`[${index}:v]${parts.join(',')}[${label}]`);
      return label;
    };

    const layerALabel = addTransitionLayer(clipA, indexA, layerFramesA, 0, speedA);
    const layerBLabel = addTransitionLayer(clipB, indexB, layerFramesB, sideB, speedB);

    const fused = `t${counter}`;
    counter += 1;
    chains.push(
      `[${layerALabel}][${layerBLabel}]xfade=transition=${xfade}` +
      `:duration=${formatSeconds(transitionSeconds)}:offset=${formatSeconds(offsetSeconds)}[${fused}]`,
    );

    const shifted = `t${counter}`;
    counter += 1;
    const startSeconds = framesToSeconds(clipA.startFrame ?? 0, fps);
    const endSeconds = framesToSeconds((Number(clipB.startFrame) || 0) + framesB, fps);
    chains.push(
      `[${fused}]setpts=PTS-STARTPTS+${formatSeconds(startSeconds)}/TB[${shifted}]`,
    );
    const outputLabel = `b${counter}`;
    counter += 1;
    chains.push(
      `[${baseLabel}][${shifted}]overlay=x=0:y=0:` +
      `enable=${quoteFilterExpression(`between(t,${formatSeconds(startSeconds)},${formatSeconds(endSeconds)})`)}` +
      `[${outputLabel}]`,
    );
    baseLabel = outputLabel;
    hasVisual = true;

    // Audio: reuse the two video inputs (they already carry the extended
    // source windows) and ramp `afade` down/up across the same overlap, so
    // `amix` sums to a linear audio crossfade.
    if (from.track.muted !== true) {
      const trackVolume = normalizeTrackVolume(from.track);
      const addCrossfadeAudio = (clip, index, layerFrames, leadFrames, delayedStartFrames, outgoing) => {
        const media = findMedia(project, clip.mediaId);
        if (media === null || media.hasAudio !== true) return;
        const speed = speedForClip(clip);
        const parts = [
          `atrim=duration=${formatSeconds(framesToSeconds(layerFrames * speed, fps))}`,
          'asetpts=PTS-STARTPTS',
        ];
        if (speed !== 1) parts.push(...atempoChain(speed));
        parts.push(
          outgoing
            ? `afade=t=out:st=${formatSeconds(offsetSeconds)}:d=${formatSeconds(transitionSeconds)}`
            : `afade=t=in:st=0:d=${formatSeconds(transitionSeconds)}`,
        );
        const ownFades = fadesForClip(clip, new Map());
        if (ownFades.inFrames > 0) {
          parts.push(`afade=t=in:st=${formatSeconds(framesToSeconds(leadFrames, fps))}` +
            `:d=${formatSeconds(framesToSeconds(ownFades.inFrames, fps))}`);
        }
        if (ownFades.outFrames > 0) {
          parts.push(
            `afade=t=out:st=${formatSeconds(framesToSeconds(leadFrames + clipDurationFrames(clip) - ownFades.outFrames, fps))}` +
            `:d=${formatSeconds(framesToSeconds(ownFades.outFrames, fps))}`,
          );
        }
        appendClipVolume(parts, clip, trackVolume);
        const delay = Math.max(0, Math.round(framesToSeconds(delayedStartFrames, fps) * 1000));
        parts.push(`adelay=${delay}:all=1`);
        const audioLabel = `a${audioCounter}`;
        audioCounter += 1;
        chains.push(`[${index}:a]${parts.join(',')}[${audioLabel}]`);
        audioLabels.push(audioLabel);
      };

      addCrossfadeAudio(clipA, indexA, layerFramesA, 0, Number(clipA.startFrame) || 0, true);
      addCrossfadeAudio(
        clipB,
        indexB,
        layerFramesB,
        sideB,
        (Number(clipB.startFrame) || 0) - sideB,
        false,
      );
    }

    return true;
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
      const trackVolume = normalizeTrackVolume(track);
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
        addAudioChain(clip, index, speed, trackVolume);
      }
      continue;
    }

    if (track.type !== 'video') continue;
    const trackVolume = normalizeTrackVolume(track);

    for (const clip of clips) {
      if (clip === null || typeof clip !== 'object') continue;
      if (coveredClipIds.has(clip.id)) continue;

      if (clip.type === 'text') {
        if (!trackHidden) addTextClip(clip);
        continue;
      }

      if (clip.type === 'caption') {
        if (!trackHidden) addCaptionClip(clip);
        continue;
      }

      if (clip.type !== 'video' && clip.type !== 'image') continue;

      const trueTransition = trueTransitions.get(clip.id);
      if (trueTransition !== undefined) {
        coveredClipIds.add(trueTransition.to.clip.id);
        if (addTrueTransition(trueTransition)) continue;
        coveredClipIds.delete(trueTransition.to.clip.id);
      }

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
      if (wantsAudio) addAudioChain(clip, index, speed, trackVolume);
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

  args.push(...audioEncodeArgs(settings, audioLabels.length > 0));
  args.push(...videoEncodeArgs(settings));

  if (settings.container === 'mp4' || settings.container === 'mov') {
    args.push('-movflags', '+faststart');
  }
  // New formats always force their muxer so the explicit output path may use
  // any extension; mp4/mov do so when a container was explicitly requested.
  if (settings.containerExplicit || settings.codec === 'prores' || settings.codec === 'vp9') {
    args.push('-f', settings.container);
  }
  if (settings.fpsProvided) args.push('-r', formatScalar(settings.fps));
  args.push(
    '-t', formatSeconds(durationSeconds),
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  );

  return {
    args,
    durationFrames,
    codec: settings.codec,
    container: settings.container,
  };
}

// ---------------------------------------------------------------------------
// Export execution
// ---------------------------------------------------------------------------

/**
 * Render a project to `outputPath` with ffmpeg.
 *
 * @param {{ project: object, projectRoot: string, outputPath: string,
 *   onProgress?: (progress: number) => void, signal?: AbortSignal, options?: object }} input
 * @returns {Promise<{ outputPath: string, durationFrames: number, codec: string, container: string }>}
 */
export async function runExport({
  project,
  projectRoot,
  outputPath,
  onProgress,
  signal,
  options,
  ...inlineOptions
} = {}) {
  if (signal?.aborted) {
    const error = new ExportError('The export was aborted', 'aborted');
    error.name = 'AbortError';
    throw error;
  }

  let built;
  try {
    built = buildExportArgs({
      project,
      projectRoot,
      outputPath,
      ...(options !== undefined ? { options } : inlineOptions),
    });
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
  return {
    outputPath,
    durationFrames: built.durationFrames,
    codec: built.codec,
    container: built.container,
  };
}
