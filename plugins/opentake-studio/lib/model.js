/**
 * OpenTake Studio — pure project/timeline model.
 *
 * Contract: `plugins/opentake-studio/docs/DESIGN.md` §3 and §11.1–§11.2
 * (Phase 1: speed, fades, keyframes, effects, markers, transitions, captions).
 *
 * Design principles:
 * - Pure data in / pure data out. `applyOperation` never mutates its inputs and
 *   never generates random values; every id is supplied by the caller.
 * - `applyOperation` deep-clones the project through `normalizeProject`, applies
 *   one operation, prunes transitions that no longer describe adjacent clips,
 *   stamps `updatedAt` and re-validates every invariant before returning the
 *   new Project.
 * - All failures are `ModelError` with a stable `code`.
 */

const PROJECT_VERSION = 1;
const ALLOWED_FPS = [24, 25, 30, 50, 60];
const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_PROJECT_NAME = 'Untitled';

/** Timeline frames used when an `add-clip` for an image omits `durationFrames`. */
const IMAGE_DEFAULT_DURATION_SECONDS = 5;

const CLIP_TYPES = ['video', 'image', 'audio', 'text', 'caption'];
const MEDIA_KINDS = ['video', 'audio', 'image'];
const TRACK_TYPES = ['video', 'audio'];
const FONT_WEIGHTS = ['400', '600', '700'];
const TEXT_ALIGNS = ['left', 'center', 'right'];

const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

const KEYFRAME_PROPERTIES = ['volume', 'opacity', 'x', 'y', 'width', 'height', 'rotation'];
const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];

const EFFECT_TYPES = [
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'blur',
  'sharpen',
  'chromaKey',
  'lut',
];

const TRANSITION_TYPES = ['dissolve', 'fadeToBlack', 'wipeLeft', 'wipeRight'];

const DEFAULT_MARKER_COLOR = '#ffcc00';

const DEFAULT_CAPTION_STYLE = Object.freeze({
  fontSize: 48,
  color: '#ffffff',
  fontWeight: '600',
  align: 'center',
  background: null,
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_CLIP_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
});

const DEFAULT_TEXT_TRANSFORM = Object.freeze({
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.2,
  rotation: 0,
});

const DEFAULT_TEXT = Object.freeze({
  content: '',
  fontSize: 48,
  color: '#ffffff',
  fontWeight: '600',
  align: 'center',
});

/** Error type thrown for every invalid model input. */
export class ModelError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} [message] human-readable detail
   */
  constructor(code, message) {
    super(message === undefined ? code : message);
    this.name = 'ModelError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------

function fail(code, message) {
  throw new ModelError(code, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertObject(value, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`);
}

function requireString(value, code, label) {
  if (typeof value !== 'string') fail(code, `${label} must be a string`);
  return value;
}

function requireNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, code, label) {
  if (!isFiniteNumber(value)) fail(code, `${label} must be a finite number`);
  return value;
}

function requireInteger(value, code, label, min = -Infinity, max = Infinity) {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = `${min}..${max === Infinity ? 'Infinity' : max}`;
    fail(code, `${label} must be an integer in ${range} (got ${String(value)})`);
  }
  return value;
}

function requireNonNegativeInteger(value, code, label) {
  return requireInteger(value, code, label, 0);
}

function requirePositiveInteger(value, code, label) {
  return requireInteger(value, code, label, 1);
}

function requireUnitNumber(value, code, label) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    fail(code, `${label} must be a number in [0,1] (got ${String(value)})`);
  }
  return value;
}

function optionalBoolean(value, fallback, code, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(code, `${label} must be a boolean`);
  return value;
}

function requireBoolean(value, code, label) {
  if (typeof value !== 'boolean') fail(code, `${label} must be a boolean`);
  return value;
}

function requireId(value, code, label) {
  return requireNonEmptyString(value, code, label);
}

/** Set of non-empty string ids from a non-empty array. Duplicates are collapsed. */
function requireIdSet(value, code, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(code, `${label} must be a non-empty array of ids`);
  }
  const ids = new Set();
  for (const id of value) ids.add(requireId(id, code, `${label}[]`));
  return ids;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

function compareClips(a, b) {
  return a.startFrame - b.startFrame;
}

function sortTrackClips(track) {
  track.clips.sort(compareClips);
}

function allClipIds(project) {
  const ids = new Set();
  for (const track of project.tracks) {
    for (const clip of track.clips) ids.add(clip.id);
  }
  return ids;
}

function trackDefaultName(project, type) {
  const count = project.tracks.filter((track) => track.type === type).length + 1;
  return `${type === 'video' ? 'Video' : 'Audio'} ${count}`;
}

function clipTypeAllowedOnTrack(trackType, clipType) {
  if (trackType === 'video') {
    return (
      clipType === 'video' ||
      clipType === 'image' ||
      clipType === 'text' ||
      clipType === 'caption'
    );
  }
  return clipType === 'audio';
}

function assertTrackAcceptsClipType(track, clipType) {
  if (!clipTypeAllowedOnTrack(track.type, clipType)) {
    fail(
      'incompatible-track-type',
      `${clipType} clip cannot be placed on a ${track.type} track (${track.id})`,
    );
  }
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function rangeIsFree(clips, start, end) {
  for (const clip of clips) {
    const clipEnd = clip.startFrame + clip.durationFrames;
    if (rangesOverlap(start, end, clip.startFrame, clipEnd)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entity normalizers (field validation + defaults)
// ---------------------------------------------------------------------------

function normalizeTransform(value, code) {
  if (value === undefined) return { ...DEFAULT_CLIP_TRANSFORM };
  assertObject(value, code, 'transform');
  const transform = { ...DEFAULT_CLIP_TRANSFORM };
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULT_CLIP_TRANSFORM)) {
      fail(code, `unknown transform property: ${key}`);
    }
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (value[key] !== undefined) transform[key] = requireUnitNumber(value[key], code, `transform.${key}`);
  }
  if (value.rotation !== undefined) {
    transform.rotation = requireFiniteNumber(value.rotation, code, 'transform.rotation');
  }
  return transform;
}

/** Merge a partial transform patch onto an already valid transform. */
function mergeTransform(base, patch, code) {
  assertObject(patch, code, 'transform');
  const transform = {
    x: base.x,
    y: base.y,
    width: base.width,
    height: base.height,
    rotation: base.rotation,
  };
  for (const key of Object.keys(patch)) {
    if (!(key in transform)) fail(code, `unknown transform property: ${key}`);
    if (key === 'rotation') {
      transform.rotation = requireFiniteNumber(patch[key], code, 'transform.rotation');
    } else {
      transform[key] = requireUnitNumber(patch[key], code, `transform.${key}`);
    }
  }
  return transform;
}

function normalizeText(value, code) {
  if (typeof value === 'string') value = { content: value };
  assertObject(value, code, 'text');
  const text = {
    content:
      value.content === undefined ? DEFAULT_TEXT.content : requireString(value.content, code, 'text.content'),
    fontSize:
      value.fontSize === undefined
        ? DEFAULT_TEXT.fontSize
        : requireFiniteNumber(value.fontSize, code, 'text.fontSize'),
    color: value.color === undefined ? DEFAULT_TEXT.color : requireString(value.color, code, 'text.color'),
    fontWeight: value.fontWeight === undefined ? DEFAULT_TEXT.fontWeight : value.fontWeight,
    align: value.align === undefined ? DEFAULT_TEXT.align : value.align,
  };
  if (text.fontSize <= 0) fail(code, 'text.fontSize must be > 0');
  if (text.color.length === 0) fail(code, 'text.color must be a non-empty string');
  if (typeof text.fontWeight === 'number' && [400, 600, 700].includes(text.fontWeight)) {
    text.fontWeight = String(text.fontWeight);
  }
  if (!FONT_WEIGHTS.includes(text.fontWeight)) {
    fail(code, `text.fontWeight must be one of ${FONT_WEIGHTS.join('/')}`);
  }
  if (!TEXT_ALIGNS.includes(text.align)) {
    fail(code, `text.align must be one of ${TEXT_ALIGNS.join('/')}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Phase 1 normalizers: keyframes, effects, captions, markers, transitions
// ---------------------------------------------------------------------------

function normalizeKeyframeList(property, value, durationFrames, code) {
  if (!Array.isArray(value)) fail(code, `keyframes.${property} must be an array`);
  const byFrame = new Map();
  for (const item of value) {
    assertObject(item, code, `keyframes.${property}[]`);
    const frame = requireNonNegativeInteger(item.frame, code, 'keyframe.frame');
    if (frame > durationFrames) {
      fail(code, `keyframe frame ${frame} is outside clip duration ${durationFrames}`);
    }
    const keyframeValue = requireFiniteNumber(item.value, code, 'keyframe.value');
    if (property !== 'rotation' && (keyframeValue < 0 || keyframeValue > 1)) {
      fail(code, `keyframe value for ${property} must be in [0,1]`);
    }
    const easing = item.easing === undefined ? 'linear' : item.easing;
    if (!EASINGS.includes(easing)) {
      fail(code, `keyframe easing must be one of ${EASINGS.join('/')}`);
    }
    // Later entries at the same frame win; the map also drops duplicates.
    byFrame.set(frame, { frame, value: keyframeValue, easing });
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function normalizeKeyframes(value, durationFrames, code) {
  if (value === undefined || value === null) return {};
  assertObject(value, code, 'keyframes');
  const keyframes = {};
  for (const property of KEYFRAME_PROPERTIES) {
    if (value[property] === undefined) continue;
    const list = normalizeKeyframeList(property, value[property], durationFrames, code);
    if (list.length > 0) keyframes[property] = list;
  }
  return keyframes;
}

function normalizeCaptionStyle(value, code) {
  const style = value === undefined || value === null ? {} : value;
  assertObject(style, code, 'caption.style');
  const fontSize =
    style.fontSize === undefined
      ? DEFAULT_CAPTION_STYLE.fontSize
      : requireFiniteNumber(style.fontSize, code, 'caption.style.fontSize');
  const color =
    style.color === undefined
      ? DEFAULT_CAPTION_STYLE.color
      : requireNonEmptyString(style.color, code, 'caption.style.color');
  const fontWeight =
    style.fontWeight === undefined ? DEFAULT_CAPTION_STYLE.fontWeight : style.fontWeight;
  const align = style.align === undefined ? DEFAULT_CAPTION_STYLE.align : style.align;
  let background = DEFAULT_CAPTION_STYLE.background;
  if (style.background !== undefined && style.background !== null) {
    background = requireNonEmptyString(style.background, code, 'caption.style.background');
  }
  if (fontSize <= 0) fail(code, 'caption.style.fontSize must be > 0');
  if (typeof fontWeight === 'number' && [400, 600, 700].includes(fontWeight)) {
    // Accept numeric weights as a convenience and normalize them to strings.
    return buildCaptionStyle(fontSize, color, String(fontWeight), align, background, code);
  }
  return buildCaptionStyle(fontSize, color, fontWeight, align, background, code);
}

function buildCaptionStyle(fontSize, color, fontWeight, align, background, code) {
  if (!FONT_WEIGHTS.includes(fontWeight)) {
    fail(code, `caption.style.fontWeight must be one of ${FONT_WEIGHTS.join('/')}`);
  }
  if (!TEXT_ALIGNS.includes(align)) {
    fail(code, `caption.style.align must be one of ${TEXT_ALIGNS.join('/')}`);
  }
  return { fontSize, color, fontWeight, align, background };
}

function normalizeCaptionSegments(value, durationFrames, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(code, 'caption.segments must be an array');
  const segments = value.map((segment) => {
    assertObject(segment, code, 'caption.segments[]');
    const startFrame = requireNonNegativeInteger(segment.startFrame, code, 'segment.startFrame');
    const durationFramesValue = requirePositiveInteger(
      segment.durationFrames,
      code,
      'segment.durationFrames',
    );
    const text = requireString(segment.text, code, 'segment.text');
    const end = startFrame + durationFramesValue;
    if (end > durationFrames) {
      fail(
        code,
        `caption segment [${startFrame}, ${end}) exceeds clip duration ${durationFrames}`,
      );
    }
    return { startFrame, durationFrames: durationFramesValue, text };
  });
  segments.sort((a, b) => a.startFrame - b.startFrame);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    if (previous.startFrame + previous.durationFrames > segments[index].startFrame) {
      fail(code, `caption segments overlap at frame ${segments[index].startFrame}`);
    }
  }
  return segments;
}

function normalizeCaption(value, durationFrames, code) {
  assertObject(value, code, 'caption');
  return {
    segments: normalizeCaptionSegments(value.segments, durationFrames, code),
    style: normalizeCaptionStyle(value.style, code),
  };
}

function effectParamNumber(params, key, fallback, min, max, code) {
  if (params[key] === undefined) return fallback;
  const number = requireFiniteNumber(params[key], code, `effect.params.${key}`);
  if (number < min || number > max) {
    fail(code, `effect.params.${key} must be in [${min},${max}]`);
  }
  return number;
}

function normalizeLutFile(value, code) {
  const file = requireNonEmptyString(value, code, 'effect.params.file');
  if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file)) {
    fail(code, 'effect.params.file must be relative to <projectRoot>/luts/');
  }
  const parts = file.split(/[\\/]+/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(code, 'effect.params.file must not contain empty, "." or ".." segments');
  }
  if (!file.toLowerCase().endsWith('.cube')) {
    fail(code, 'effect.params.file must be a .cube file');
  }
  return file;
}

function normalizeEffectParams(type, value, code) {
  const params = value === undefined ? {} : value;
  assertObject(params, code, 'effect.params');
  switch (type) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
      return { amount: effectParamNumber(params, 'amount', 1, 0, 2, code) };
    case 'temperature':
      return { amount: effectParamNumber(params, 'amount', 0, -1, 1, code) };
    case 'blur':
      return { radius: effectParamNumber(params, 'radius', 0, 0, 30, code) };
    case 'sharpen':
      return { amount: effectParamNumber(params, 'amount', 0, 0, 2, code) };
    case 'chromaKey': {
      const keyColor =
        params.keyColor === undefined
          ? '#00ff00'
          : requireNonEmptyString(params.keyColor, code, 'effect.params.keyColor');
      if (!HEX_COLOR_RE.test(keyColor)) {
        fail(code, 'effect.params.keyColor must be a #rrggbb color');
      }
      return {
        keyColor,
        similarity: effectParamNumber(params, 'similarity', 0.1, 0.01, 0.5, code),
        blend: effectParamNumber(params, 'blend', 0.1, 0, 0.5, code),
      };
    }
    case 'lut':
      return { file: normalizeLutFile(params.file, code) };
    default:
      fail(code, `unknown effect type: ${String(type)}`);
  }
}

function normalizeEffect(value, code = 'invalid-effect') {
  assertObject(value, code, 'effect');
  const id = requireId(value.id, code, 'effect.id');
  if (!EFFECT_TYPES.includes(value.type)) {
    fail(code, `effect.type must be one of ${EFFECT_TYPES.join('/')}`);
  }
  const enabled = optionalBoolean(value.enabled, true, code, 'effect.enabled');
  return {
    id,
    type: value.type,
    enabled,
    params: normalizeEffectParams(value.type, value.params, code),
  };
}

function normalizeMarker(value, code = 'invalid-marker') {
  assertObject(value, code, 'marker');
  const id = requireId(value.id, code, 'marker.id');
  const frame = requireNonNegativeInteger(value.frame, code, 'marker.frame');
  const label = value.label === undefined ? '' : requireString(value.label, code, 'marker.label');
  const color =
    value.color === undefined ? DEFAULT_MARKER_COLOR : requireNonEmptyString(value.color, code, 'marker.color');
  if (!HEX_COLOR_RE.test(color)) fail(code, 'marker.color must be a #rrggbb color');
  return { id, frame, label, color };
}

function sortMarkers(markers) {
  markers.sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
}

function normalizeTransition(value, code = 'invalid-transition') {
  assertObject(value, code, 'transition');
  const id = requireId(value.id, code, 'transition.id');
  const trackId = requireId(value.trackId, code, 'transition.trackId');
  const fromClipId = requireId(value.fromClipId, code, 'transition.fromClipId');
  const toClipId = requireId(value.toClipId, code, 'transition.toClipId');
  if (!TRANSITION_TYPES.includes(value.type)) {
    fail(code, `transition.type must be one of ${TRANSITION_TYPES.join('/')}`);
  }
  const durationFrames = requirePositiveInteger(
    value.durationFrames,
    code,
    'transition.durationFrames',
  );
  return { id, trackId, fromClipId, toClipId, type: value.type, durationFrames };
}

/** Text-like clips cannot participate in transitions (DESIGN §11.1). */
function isTransitionableClip(clip) {
  return clip.type === 'video' || clip.type === 'image';
}

function transitionProblem(project, transition) {
  const track = findTrack(project, transition.trackId);
  if (!track) return `track ${transition.trackId} not found`;
  if (track.type !== 'video') return `transitions require a video track (${track.id} is audio)`;
  const from = track.clips.find((clip) => clip.id === transition.fromClipId);
  const to = track.clips.find((clip) => clip.id === transition.toClipId);
  if (!from || !to) return 'fromClipId/toClipId do not exist on the transition track';
  if (!isTransitionableClip(from) || !isTransitionableClip(to)) {
    return 'transitions require video/image clips (text and caption clips are excluded)';
  }
  if (from.startFrame + from.durationFrames !== to.startFrame) {
    return 'transition clips are not adjacent';
  }
  if (transition.durationFrames > Math.min(from.durationFrames, to.durationFrames)) {
    return `durationFrames exceeds the shorter adjacent clip (${Math.min(from.durationFrames, to.durationFrames)})`;
  }
  return null;
}

function validateTransition(project, transition) {
  const problem = transitionProblem(project, transition);
  if (problem !== null) fail('invalid-transition', `transition ${transition.id}: ${problem}`);
  for (const other of project.transitions) {
    if (other.id === transition.id) continue;
    if (
      other.trackId === transition.trackId &&
      other.fromClipId === transition.fromClipId &&
      other.toClipId === transition.toClipId
    ) {
      fail(
        'invalid-transition',
        `a transition already exists between ${transition.fromClipId} and ${transition.toClipId}`,
      );
    }
  }
}

function sortTransitions(project) {
  const trackIndex = new Map(project.tracks.map((track, index) => [track.id, index]));
  const clipStart = (trackId, clipId) => {
    const track = findTrack(project, trackId);
    const clip = track === null ? undefined : track.clips.find((item) => item.id === clipId);
    return clip === undefined ? Number.POSITIVE_INFINITY : clip.startFrame;
  };
  project.transitions.sort(
    (a, b) =>
      (trackIndex.get(a.trackId) ?? Number.POSITIVE_INFINITY) -
        (trackIndex.get(b.trackId) ?? Number.POSITIVE_INFINITY) ||
      clipStart(a.trackId, a.fromClipId) - clipStart(b.trackId, b.fromClipId) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Drop transitions that no longer describe two adjacent clips after an edit.
 * (Moving/trimming/splitting a clip invalidates the transition at that edge.)
 */
function pruneTransitions(project) {
  const seen = new Set();
  project.transitions = project.transitions.filter((transition) => {
    if (transitionProblem(project, transition) !== null) return false;
    const key = `${transition.trackId}\u0000${transition.fromClipId}\u0000${transition.toClipId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  sortTransitions(project);
}

function normalizeMedia(value, projectFps) {
  const code = 'invalid-media';
  const id = requireId(value.id, code, 'media.id');
  if (!MEDIA_KINDS.includes(value.kind)) {
    fail(code, `media.kind must be one of ${MEDIA_KINDS.join('/')}`);
  }
  const kind = value.kind;
  const fileName = requireNonEmptyString(value.fileName, code, 'media.fileName');
  const name = requireString(value.name === undefined ? fileName : value.name, code, 'media.name');

  let sourceDurationSeconds = null;
  if (value.sourceDurationSeconds !== undefined && value.sourceDurationSeconds !== null) {
    sourceDurationSeconds = requireFiniteNumber(
      value.sourceDurationSeconds,
      code,
      'media.sourceDurationSeconds',
    );
    if (sourceDurationSeconds < 0) fail(code, 'media.sourceDurationSeconds must be >= 0');
  }

  let durationFrames = null;
  if (kind === 'image') {
    if (value.durationFrames !== undefined && value.durationFrames !== null) {
      fail(code, 'image media must have durationFrames: null');
    }
  } else if (value.durationFrames === undefined || value.durationFrames === null) {
    if (sourceDurationSeconds === null) {
      fail(code, 'media.durationFrames is required for video/audio (or sourceDurationSeconds)');
    }
    durationFrames = Math.max(1, Math.round(sourceDurationSeconds * projectFps));
  } else {
    durationFrames = requirePositiveInteger(value.durationFrames, code, 'media.durationFrames');
  }

  let width = null;
  if (value.width !== undefined && value.width !== null) {
    width = requirePositiveInteger(value.width, code, 'media.width');
  }
  let height = null;
  if (value.height !== undefined && value.height !== null) {
    height = requirePositiveInteger(value.height, code, 'media.height');
  }

  const hasAudio =
    kind === 'image' ? false : optionalBoolean(value.hasAudio, false, code, 'media.hasAudio');
  const sizeBytes =
    value.sizeBytes === undefined ? 0 : requireInteger(value.sizeBytes, code, 'media.sizeBytes', 0);
  const importedAt = value.importedAt === undefined ? Date.now() : requireFiniteNumber(value.importedAt, code, 'media.importedAt');

  return {
    id,
    name,
    kind,
    fileName,
    durationFrames,
    sourceDurationSeconds,
    width,
    height,
    hasAudio,
    sizeBytes,
    importedAt,
  };
}

/** Source frames consumed by a clip on the timeline (`round(duration * speed)`). */
function sourceFramesConsumed(durationFrames, speed) {
  return Math.round(durationFrames * speed);
}

function isTextLikeClip(type) {
  return type === 'text' || type === 'caption';
}

function normalizeClip(value) {
  const code = 'invalid-clip';
  assertObject(value, code, 'clip');
  const id = requireId(value.id, code, 'clip.id');
  if (!CLIP_TYPES.includes(value.type)) {
    fail(code, `clip.type must be one of ${CLIP_TYPES.join('/')}`);
  }
  const type = value.type;

  let mediaId = null;
  if (isTextLikeClip(type)) {
    if (value.mediaId !== undefined && value.mediaId !== null) {
      fail(code, `${type} clip must have mediaId: null`);
    }
  } else {
    mediaId = requireId(value.mediaId, code, 'clip.mediaId');
  }

  const startFrame = requireNonNegativeInteger(value.startFrame, code, 'clip.startFrame');
  const durationFrames = requirePositiveInteger(value.durationFrames, code, 'clip.durationFrames');
  const trimStartFrame =
    value.trimStartFrame === undefined
      ? 0
      : requireNonNegativeInteger(value.trimStartFrame, code, 'clip.trimStartFrame');
  if (isTextLikeClip(type) && trimStartFrame !== 0) {
    fail(code, `${type} clip must have trimStartFrame: 0`);
  }

  const speed = value.speed === undefined ? 1 : value.speed;
  if (!isFiniteNumber(speed) || speed < SPEED_MIN || speed > SPEED_MAX) {
    fail(code, `clip.speed must be a number in [${SPEED_MIN},${SPEED_MAX}]`);
  }
  if ((type === 'image' || type === 'text' || type === 'caption') && speed !== 1) {
    fail(code, `${type} clips must keep speed 1`);
  }

  const volume =
    value.volume === undefined ? 1 : requireUnitNumber(value.volume, code, 'clip.volume');
  const opacity =
    value.opacity === undefined ? 1 : requireUnitNumber(value.opacity, code, 'clip.opacity');
  const transform = normalizeTransform(value.transform, code);

  // Fades may not exceed the clip length. Trimming/speed changes shorter clips
  // clamp stale fades instead of rejecting the project (upstream behaviour).
  const fadeInValue =
    value.fadeInFrames === undefined ? 0 : requireNonNegativeInteger(value.fadeInFrames, code, 'clip.fadeInFrames');
  const fadeOutValue =
    value.fadeOutFrames === undefined ? 0 : requireNonNegativeInteger(value.fadeOutFrames, code, 'clip.fadeOutFrames');
  const fadeInFrames = Math.min(fadeInValue, durationFrames);
  const fadeOutFrames = Math.min(fadeOutValue, durationFrames);

  const keyframes = normalizeKeyframes(value.keyframes, durationFrames, code);

  const effectsValue = value.effects === undefined ? [] : value.effects;
  if (!Array.isArray(effectsValue)) fail(code, 'clip.effects must be an array');
  const effects = effectsValue.map((effect) => normalizeEffect(effect, code));
  const effectIds = new Set();
  for (const effect of effects) {
    if (effectIds.has(effect.id)) fail('duplicate-id', `duplicate effect id: ${effect.id}`);
    effectIds.add(effect.id);
  }

  let text = null;
  if (type === 'text') {
    if (value.text === undefined || value.text === null) {
      fail(code, 'text clip requires a text object');
    }
    text = normalizeText(value.text, code);
  } else if (value.text !== undefined && value.text !== null) {
    fail(code, 'non-text clip must have text: null');
  }

  let caption = null;
  if (type === 'caption') {
    if (value.caption === undefined || value.caption === null) {
      fail(code, 'caption clip requires a caption object');
    }
    caption = normalizeCaption(value.caption, durationFrames, code);
  } else if (value.caption !== undefined && value.caption !== null) {
    fail(code, 'non-caption clip must have caption: null');
  }

  return {
    id,
    type,
    mediaId,
    startFrame,
    durationFrames,
    trimStartFrame,
    speed,
    volume,
    opacity,
    transform,
    text,
    fadeInFrames,
    fadeOutFrames,
    keyframes,
    effects,
    caption,
  };
}

function normalizeTrack(value) {
  const code = 'invalid-track';
  assertObject(value, code, 'track');
  const id = requireId(value.id, code, 'track.id');
  if (!TRACK_TYPES.includes(value.type)) {
    fail(code, `track.type must be one of ${TRACK_TYPES.join('/')}`);
  }
  const type = value.type;
  const name =
    value.name === undefined
      ? type === 'video'
        ? 'Video'
        : 'Audio'
      : requireNonEmptyString(value.name, code, 'track.name');
  const muted = optionalBoolean(value.muted, false, code, 'track.muted');
  const hidden = optionalBoolean(value.hidden, false, code, 'track.hidden');
  const clipsValue = value.clips === undefined ? [] : value.clips;
  if (!Array.isArray(clipsValue)) fail(code, 'track.clips must be an array');
  const clips = clipsValue.map(normalizeClip).sort(compareClips);
  return { id, type, name, muted, hidden, clips };
}

// ---------------------------------------------------------------------------
// Cross-entity invariant validation
// ---------------------------------------------------------------------------

function validateProject(project) {
  if (project.version !== PROJECT_VERSION) {
    fail('unsupported-version', `project.version must be ${PROJECT_VERSION}`);
  }
  if (!ALLOWED_FPS.includes(project.fps)) {
    fail('unsupported-fps', `project.fps must be one of ${ALLOWED_FPS.join('/')}`);
  }
  if (!Array.isArray(project.media)) fail('invalid-project', 'project.media must be an array');
  if (!Array.isArray(project.tracks)) fail('invalid-project', 'project.tracks must be an array');
  if (!Array.isArray(project.markers)) fail('invalid-project', 'project.markers must be an array');
  if (!Array.isArray(project.transitions)) {
    fail('invalid-project', 'project.transitions must be an array');
  }

  const mediaById = new Map();
  for (const media of project.media) {
    if (mediaById.has(media.id)) fail('duplicate-id', `duplicate media id: ${media.id}`);
    mediaById.set(media.id, media);
  }

  const trackIds = new Set();
  const clipIds = new Set();
  for (const track of project.tracks) {
    if (trackIds.has(track.id)) fail('duplicate-id', `duplicate track id: ${track.id}`);
    trackIds.add(track.id);

    for (let index = 0; index < track.clips.length; index += 1) {
      const clip = track.clips[index];
      if (clipIds.has(clip.id)) fail('duplicate-id', `duplicate clip id: ${clip.id}`);
      clipIds.add(clip.id);

      if (isTextLikeClip(clip.type)) {
        if (clip.mediaId !== null) {
          fail('invalid-clip', `${clip.type} clip ${clip.id} must have mediaId: null`);
        }
        if (clip.trimStartFrame !== 0) {
          fail('invalid-clip', `${clip.type} clip ${clip.id} must have trimStartFrame: 0`);
        }
        if (clip.speed !== 1) {
          fail('invalid-clip', `${clip.type} clip ${clip.id} must keep speed 1`);
        }
        if (clip.type === 'text' && (clip.text === null || clip.text === undefined)) {
          fail('invalid-clip', `text clip ${clip.id} requires a text object`);
        }
        if (clip.type === 'caption' && (clip.caption === null || clip.caption === undefined)) {
          fail('invalid-clip', `caption clip ${clip.id} requires a caption object`);
        }
      } else {
        const media = mediaById.get(clip.mediaId);
        if (!media) fail('media-not-found', `clip ${clip.id} references missing media ${String(clip.mediaId)}`);
        if (media.kind !== clip.type) {
          fail(
            'invalid-clip',
            `clip ${clip.id} has type ${clip.type} but media ${media.id} is ${media.kind}`,
          );
        }
        if (clip.type !== 'image') {
          const sourceEnd = clip.trimStartFrame + sourceFramesConsumed(clip.durationFrames, clip.speed);
          if (sourceEnd > media.durationFrames) {
            fail(
              'out-of-bounds',
              `clip ${clip.id} source window ${clip.trimStartFrame}+${sourceFramesConsumed(clip.durationFrames, clip.speed)} exceeds media ${media.id} (${media.durationFrames})`,
            );
          }
        }
      }

      if (!clipTypeAllowedOnTrack(track.type, clip.type)) {
        fail(
          'incompatible-track-type',
          `clip ${clip.id} (${clip.type}) cannot live on ${track.type} track ${track.id}`,
        );
      }

      // Keyframes must stay inside the (possibly edited) clip length.
      if (clip.keyframes !== undefined) {
        for (const property of Object.keys(clip.keyframes)) {
          for (const keyframe of clip.keyframes[property]) {
            if (keyframe.frame > clip.durationFrames) {
              fail(
                'invalid-keyframe',
                `clip ${clip.id} keyframe ${property}@${keyframe.frame} exceeds duration ${clip.durationFrames}`,
              );
            }
          }
        }
      }
      if (clip.fadeInFrames > clip.durationFrames || clip.fadeOutFrames > clip.durationFrames) {
        fail('invalid-clip', `clip ${clip.id} fades exceed duration ${clip.durationFrames}`);
      }

      if (index > 0) {
        const previous = track.clips[index - 1];
        const previousEnd = previous.startFrame + previous.durationFrames;
        if (clip.startFrame < previousEnd) {
          fail(
            'overlap',
            `clips ${previous.id} and ${clip.id} overlap on track ${track.id}`,
          );
        }
      }
    }
  }

  // Markers -----------------------------------------------------------------
  const markerIds = new Set();
  for (const marker of project.markers) {
    if (markerIds.has(marker.id)) fail('duplicate-id', `duplicate marker id: ${marker.id}`);
    markerIds.add(marker.id);
  }

  // Transitions -------------------------------------------------------------
  const transitionIds = new Set();
  const adjacency = new Set();
  for (const transition of project.transitions) {
    if (transitionIds.has(transition.id)) {
      fail('duplicate-id', `duplicate transition id: ${transition.id}`);
    }
    transitionIds.add(transition.id);
    const problem = transitionProblem(project, transition);
    if (problem !== null) {
      fail('invalid-transition', `transition ${transition.id}: ${problem}`);
    }
    const key = `${transition.trackId}\u0000${transition.fromClipId}\u0000${transition.toClipId}`;
    if (adjacency.has(key)) {
      fail(
        'invalid-transition',
        `a transition already exists between ${transition.fromClipId} and ${transition.toClipId}`,
      );
    }
    adjacency.add(key);
  }
}

// ---------------------------------------------------------------------------
// Public: project lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new empty Project.
 * @param {{name?: string, fps?: number, width?: number, height?: number}} [options]
 */
export function createProject(options = {}) {
  assertObject(options, 'invalid-input', 'options');
  const now = Date.now();
  return normalizeProject({
    version: PROJECT_VERSION,
    name: options.name,
    fps: options.fps,
    width: options.width,
    height: options.height,
    createdAt: now,
    updatedAt: now,
    media: [],
    tracks: [],
    markers: [],
    transitions: [],
  });
}

/**
 * Validate a raw project value, filling defaults and returning a clean deep copy.
 * Throws `ModelError` for any malformed structure or broken invariant.
 */
export function normalizeProject(value) {
  assertObject(value, 'invalid-project', 'project');

  const version = value.version === undefined ? PROJECT_VERSION : value.version;
  if (version !== PROJECT_VERSION) {
    fail('unsupported-version', `project.version must be ${PROJECT_VERSION} (got ${String(version)})`);
  }

  const fps = value.fps === undefined ? DEFAULT_FPS : value.fps;
  if (!ALLOWED_FPS.includes(fps)) {
    fail('unsupported-fps', `project.fps must be one of ${ALLOWED_FPS.join('/')} (got ${String(fps)})`);
  }

  const width =
    value.width === undefined ? DEFAULT_WIDTH : requirePositiveInteger(value.width, 'invalid-project', 'project.width');
  const height =
    value.height === undefined
      ? DEFAULT_HEIGHT
      : requirePositiveInteger(value.height, 'invalid-project', 'project.height');
  const name =
    value.name === undefined
      ? DEFAULT_PROJECT_NAME
      : requireString(value.name, 'invalid-project', 'project.name');
  if (name.length === 0) fail('invalid-project', 'project.name must be a non-empty string');

  const now = Date.now();
  const createdAt =
    value.createdAt === undefined ? now : requireFiniteNumber(value.createdAt, 'invalid-project', 'project.createdAt');
  const updatedAt =
    value.updatedAt === undefined ? createdAt : requireFiniteNumber(value.updatedAt, 'invalid-project', 'project.updatedAt');

  if (value.media !== undefined && !Array.isArray(value.media)) {
    fail('invalid-project', 'project.media must be an array');
  }
  if (value.tracks !== undefined && !Array.isArray(value.tracks)) {
    fail('invalid-project', 'project.tracks must be an array');
  }
  if (value.markers !== undefined && !Array.isArray(value.markers)) {
    fail('invalid-project', 'project.markers must be an array');
  }
  if (value.transitions !== undefined && !Array.isArray(value.transitions)) {
    fail('invalid-project', 'project.transitions must be an array');
  }

  const media = (value.media === undefined ? [] : value.media).map((item) => normalizeMedia(item, fps));
  const tracks = (value.tracks === undefined ? [] : value.tracks).map((item) => normalizeTrack(item));
  const markers = (value.markers === undefined ? [] : value.markers).map((item) => normalizeMarker(item));
  sortMarkers(markers);
  const transitions = (value.transitions === undefined ? [] : value.transitions).map((item) =>
    normalizeTransition(item),
  );

  const project = {
    version: PROJECT_VERSION,
    name,
    fps,
    width,
    height,
    createdAt,
    updatedAt,
    media,
    tracks,
    markers,
    transitions,
  };
  validateProject(project);
  sortTransitions(project);
  return project;
}

/** Deep copy of a project (no validation). */
export function cloneProject(project) {
  return deepClone(project);
}

// ---------------------------------------------------------------------------
// Public: lookup + derived values
// ---------------------------------------------------------------------------

/** Longest `startFrame + durationFrames` across all tracks; 0 for an empty project. */
export function timelineDurationFrames(project) {
  if (!project || !Array.isArray(project.tracks)) return 0;
  let duration = 0;
  for (const track of project.tracks) {
    if (!track || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (Number.isFinite(end) && end > duration) duration = end;
    }
  }
  return duration;
}

/** @returns {object|null} */
export function findMedia(project, mediaId) {
  if (!project || !Array.isArray(project.media) || typeof mediaId !== 'string') return null;
  for (const media of project.media) if (media.id === mediaId) return media;
  return null;
}

/** @returns {object|null} */
export function findTrack(project, trackId) {
  if (!project || !Array.isArray(project.tracks) || typeof trackId !== 'string') return null;
  for (const track of project.tracks) if (track.id === trackId) return track;
  return null;
}

/** @returns {{track: object, clip: object}|null} */
export function findClip(project, clipId) {
  if (!project || !Array.isArray(project.tracks) || typeof clipId !== 'string') return null;
  for (const track of project.tracks) {
    if (!track || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (clip.id === clipId) return { track, clip };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: time helpers
// ---------------------------------------------------------------------------

export function secondsToFrames(seconds, fps) {
  requireFiniteNumber(seconds, 'invalid-input', 'seconds');
  if (seconds < 0) fail('invalid-input', 'seconds must be >= 0');
  if (!ALLOWED_FPS.includes(fps)) {
    fail('unsupported-fps', `fps must be one of ${ALLOWED_FPS.join('/')}`);
  }
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames, fps) {
  requireFiniteNumber(frames, 'invalid-input', 'frames');
  if (frames < 0) fail('invalid-input', 'frames must be >= 0');
  if (!ALLOWED_FPS.includes(fps)) {
    fail('unsupported-fps', `fps must be one of ${ALLOWED_FPS.join('/')}`);
  }
  return frames / fps;
}

export function snapFrame(frame) {
  if (!isFiniteNumber(frame)) fail('invalid-input', 'frame must be a finite number');
  return Math.max(0, Math.round(frame));
}

// ---------------------------------------------------------------------------
// Public: Phase 1 keyframe evaluation / source-time mapping
// ---------------------------------------------------------------------------

function applyEasing(easing, t) {
  switch (easing) {
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 'linear':
    default:
      return t;
  }
}

function easingAtFrame(keyframes, frame) {
  let easing = keyframes[0].easing;
  for (const keyframe of keyframes) {
    if (keyframe.frame <= frame) easing = keyframe.easing;
    else break;
  }
  return easing;
}

/**
 * Evaluate a clip-relative keyframe list at `frame`, interpolating between the
 * surrounding keyframes. The left keyframe's `easing` shapes the segment.
 * Returns `fallback` when the list is missing/empty (the static property value).
 */
export function evaluateKeyframes(keyframes, frame, fallback) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return fallback;
  if (!isFiniteNumber(frame)) return fallback;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const current = keyframes[index];
    const next = keyframes[index + 1];
    if (frame >= current.frame && frame <= next.frame) {
      const span = next.frame - current.frame;
      if (span <= 0) return next.value;
      const progress = applyEasing(current.easing, (frame - current.frame) / span);
      return current.value + (next.value - current.value) * progress;
    }
  }
  return last.value;
}

/**
 * Map a project (timeline) frame to this clip's source frame:
 * `trimStartFrame + (frame - startFrame) * speed` (DESIGN §11.1).
 */
export function sourceFrameForTimeline(clip, frame) {
  assertObject(clip, 'invalid-input', 'clip');
  if (!isFiniteNumber(frame)) fail('invalid-input', 'frame must be a finite number');
  const speed = isFiniteNumber(clip.speed) ? clip.speed : 1;
  requireFiniteNumber(clip.trimStartFrame, 'invalid-input', 'clip.trimStartFrame');
  requireFiniteNumber(clip.startFrame, 'invalid-input', 'clip.startFrame');
  return clip.trimStartFrame + (frame - clip.startFrame) * speed;
}

// ---------------------------------------------------------------------------
// Internal: clip construction + overwrite/overlap resolution
// ---------------------------------------------------------------------------

function createClip({
  id,
  type,
  mediaId,
  startFrame,
  durationFrames,
  trimStartFrame = 0,
  speed = 1,
  volume = 1,
  opacity = 1,
  transform = DEFAULT_CLIP_TRANSFORM,
  text = null,
  fadeInFrames = 0,
  fadeOutFrames = 0,
  keyframes = {},
  effects = [],
  caption = null,
}) {
  return {
    id,
    type,
    mediaId,
    startFrame,
    durationFrames,
    trimStartFrame,
    speed,
    volume,
    opacity,
    transform: { ...transform },
    text: text === null ? null : { ...text },
    fadeInFrames,
    fadeOutFrames,
    keyframes: deepClone(keyframes),
    effects: deepClone(effects),
    caption: caption === null ? null : deepClone(caption),
  };
}

/** Keep only keyframes/caption content that fits in `durationFrames`. */
function truncateClipContent(clip, durationFrames) {
  const nextKeyframes = {};
  for (const property of Object.keys(clip.keyframes)) {
    const list = clip.keyframes[property].filter((keyframe) => keyframe.frame <= durationFrames);
    if (list.length > 0) nextKeyframes[property] = list;
  }
  clip.keyframes = nextKeyframes;
  if (clip.caption !== null) {
    const segments = [];
    for (const segment of clip.caption.segments) {
      if (segment.startFrame >= durationFrames) continue;
      const end = Math.min(segment.startFrame + segment.durationFrames, durationFrames);
      if (end <= segment.startFrame) continue;
      segments.push({
        startFrame: segment.startFrame,
        durationFrames: end - segment.startFrame,
        text: segment.text,
      });
    }
    clip.caption.segments = segments;
  }
}

/** Shift clip-relative keyframes/caption segments left by `delta` timeline frames. */
function shiftClipContent(clip, delta) {
  if (delta === 0) return;
  const nextKeyframes = {};
  for (const property of Object.keys(clip.keyframes)) {
    const sourceList = clip.keyframes[property];
    const list = sourceList
      .map((keyframe) => ({ ...keyframe, frame: keyframe.frame - delta }))
      .filter((keyframe) => keyframe.frame >= 0);
    if (delta > 0 && list.length > 0 && !list.some((keyframe) => keyframe.frame === 0)) {
      // Keep the value that was at the new clip start so animation is continuous.
      const value = evaluateKeyframes(sourceList, delta, sourceList[0].value);
      list.unshift({ frame: 0, value, easing: easingAtFrame(sourceList, delta) });
    }
    if (list.length > 0) nextKeyframes[property] = list;
  }
  clip.keyframes = nextKeyframes;
  if (clip.caption !== null) {
    const segments = [];
    for (const segment of clip.caption.segments) {
      const end = segment.startFrame + segment.durationFrames - delta;
      if (end <= 0) continue;
      const start = Math.max(0, segment.startFrame - delta);
      segments.push({ startFrame: start, durationFrames: end - start, text: segment.text });
    }
    clip.caption.segments = segments;
  }
}

/** Rescale clip-relative keyframes when a speed change alters the duration. */
function scaleClipKeyframes(clip, oldDuration, newDuration) {
  if (oldDuration === newDuration) return;
  const nextKeyframes = {};
  for (const property of Object.keys(clip.keyframes)) {
    const byFrame = new Map();
    for (const keyframe of clip.keyframes[property]) {
      const frame = Math.min(
        newDuration,
        Math.max(0, Math.round((keyframe.frame * newDuration) / oldDuration)),
      );
      byFrame.set(frame, { frame, value: keyframe.value, easing: keyframe.easing });
    }
    const list = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
    if (list.length > 0) nextKeyframes[property] = list;
  }
  clip.keyframes = nextKeyframes;
}

/** Source trim offset for the right half when the left half is removed. */
function rebaseTrimStartForHeadRemoval(clip, newDuration) {
  if (isTextLikeClip(clip.type)) return 0;
  const sourceEnd = clip.trimStartFrame + sourceFramesConsumed(clip.durationFrames, clip.speed);
  return Math.max(0, sourceEnd - sourceFramesConsumed(newDuration, clip.speed));
}

/**
 * Partition keyframes/caption segments of `source` into its `left`/`right`
 * halves at clip-relative `offset`, keeping animation continuous at the cut.
 */
function splitClipContent(left, right, offset, source) {
  const leftKeyframes = {};
  const rightKeyframes = {};
  for (const property of Object.keys(source.keyframes)) {
    const list = source.keyframes[property];
    const leftList = list
      .filter((keyframe) => keyframe.frame <= offset)
      .map((keyframe) => ({ ...keyframe }));
    const rightList = list
      .filter((keyframe) => keyframe.frame >= offset)
      .map((keyframe) => ({ ...keyframe, frame: keyframe.frame - offset }));
    if (list.length > 0 && !list.some((keyframe) => keyframe.frame === offset)) {
      const value = evaluateKeyframes(list, offset, list[0].value);
      const easing = easingAtFrame(list, offset);
      leftList.push({ frame: offset, value, easing });
      rightList.unshift({ frame: 0, value, easing });
    }
    if (leftList.length > 0) leftKeyframes[property] = leftList.sort((a, b) => a.frame - b.frame);
    if (rightList.length > 0) rightKeyframes[property] = rightList.sort((a, b) => a.frame - b.frame);
  }
  left.keyframes = leftKeyframes;
  right.keyframes = rightKeyframes;

  if (source.caption !== null && source.caption !== undefined) {
    const leftSegments = [];
    const rightSegments = [];
    for (const segment of source.caption.segments) {
      const end = segment.startFrame + segment.durationFrames;
      const leftEnd = Math.min(end, offset);
      if (leftEnd > segment.startFrame) {
        leftSegments.push({
          startFrame: segment.startFrame,
          durationFrames: leftEnd - segment.startFrame,
          text: segment.text,
        });
      }
      const rightStart = Math.max(segment.startFrame, offset);
      if (end > rightStart) {
        rightSegments.push({
          startFrame: rightStart - offset,
          durationFrames: end - rightStart,
          text: segment.text,
        });
      }
    }
    left.caption = { segments: leftSegments, style: deepClone(source.caption.style) };
    right.caption = { segments: rightSegments, style: deepClone(source.caption.style) };
  }

  // Split fades: the fade-in belongs to the left piece, the fade-out to the right.
  left.fadeInFrames = Math.min(source.fadeInFrames, left.durationFrames);
  left.fadeOutFrames = 0;
  right.fadeInFrames = 0;
  right.fadeOutFrames = Math.min(source.fadeOutFrames, right.durationFrames);
}

/**
 * Resolve same-track overlaps for a new interval `[start, end)`.
 *
 * Mirrors DESIGN §3 and the upstream overwrite engine:
 * - untouched clips are kept;
 * - fully covered clips are removed;
 * - a clip whose right side is covered is trimmed (`duration = start - clip.start`);
 * - a clip whose left side is covered is trimmed and re-based
 *   (`trimStart` advances by the consumed source frames, `start = end`);
 * - a clip spanning the whole interval is split, keeping its id for the left
 *   half and using `splitRightClipId` for the right half.
 */
function resolveTrackOverlaps(project, clips, start, end, splitRightClipId) {
  const resolved = [];
  for (const old of clips) {
    const oldStart = old.startFrame;
    const oldEnd = oldStart + old.durationFrames;
    if (!rangesOverlap(start, end, oldStart, oldEnd)) {
      resolved.push(old);
      continue;
    }
    if (oldStart >= start && oldEnd <= end) {
      // Fully covered — drop it.
      continue;
    }
    if (oldStart < start && oldEnd > end) {
      // New interval lives inside this clip — split it in two.
      if (!splitRightClipId) {
        fail(
          'invalid-input',
          `overlap with clip ${old.id} splits it; splitRightClipId is required`,
        );
      }
      if (findClip(project, splitRightClipId)) {
        fail('duplicate-id', `splitRightClipId already exists: ${splitRightClipId}`);
      }
      const offset = start - oldStart;
      const left = deepClone(old);
      left.durationFrames = offset;
      truncateClipContent(left, left.durationFrames);
      left.fadeOutFrames = 0;
      const right = deepClone(old);
      right.id = splitRightClipId;
      right.startFrame = end;
      right.durationFrames = oldEnd - end;
      right.trimStartFrame = rebaseTrimStartForHeadRemoval(old, right.durationFrames);
      // The right half loses the whole removed middle [start, end), so its
      // clip-relative content shifts by end - oldStart (not by offset).
      shiftClipContent(right, end - oldStart);
      truncateClipContent(right, right.durationFrames);
      right.fadeInFrames = 0;
      resolved.push(left, right);
      continue;
    }
    if (oldStart < start) {
      // Right part is covered — trim the clip's end.
      const left = deepClone(old);
      left.durationFrames = start - oldStart;
      truncateClipContent(left, left.durationFrames);
      resolved.push(left);
      continue;
    }
    // Left part is covered — trim the clip's start and rebase its source offset.
    const delta = end - oldStart;
    const right = deepClone(old);
    right.startFrame = end;
    right.durationFrames = oldEnd - end;
    right.trimStartFrame = rebaseTrimStartForHeadRemoval(old, right.durationFrames);
    shiftClipContent(right, delta);
    truncateClipContent(right, right.durationFrames);
    resolved.push(right);
  }
  return resolved;
}

function insertClipWithOverwrite(project, track, clip, splitRightClipId) {
  if (splitRightClipId !== undefined && splitRightClipId !== null) {
    requireId(splitRightClipId, 'invalid-input', 'splitRightClipId');
    if (splitRightClipId === clip.id) {
      fail('duplicate-id', 'splitRightClipId must differ from the new clip id');
    }
  }
  const start = clip.startFrame;
  const end = start + clip.durationFrames;
  const resolved = resolveTrackOverlaps(project, track.clips, start, end, splitRightClipId);
  track.clips = resolved.concat(clip);
  sortTrackClips(track);
}

// ---------------------------------------------------------------------------
// Internal: operations
// ---------------------------------------------------------------------------

function addTrackOperation(project, operation) {
  const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
  if (findTrack(project, trackId)) fail('duplicate-id', `track id already exists: ${trackId}`);
  const trackType = operation.trackType;
  if (!TRACK_TYPES.includes(trackType)) {
    fail('invalid-input', `trackType must be one of ${TRACK_TYPES.join('/')}`);
  }
  const name =
    operation.name === undefined
      ? trackDefaultName(project, trackType)
      : requireNonEmptyString(operation.name, 'invalid-input', 'name');
  project.tracks.push({ id: trackId, type: trackType, name, muted: false, hidden: false, clips: [] });
}

function removeTrackOperation(project, operation) {
  const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
  const index = project.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) fail('track-not-found', `track not found: ${trackId}`);
  project.tracks.splice(index, 1);
}

function addMediaOperation(project, operation) {
  if (operation.media === undefined) fail('invalid-input', 'media is required');
  const media = normalizeMedia(operation.media, project.fps);
  if (findMedia(project, media.id)) fail('duplicate-id', `media id already exists: ${media.id}`);
  project.media.push(media);
}

function removeMediaOperation(project, operation) {
  const mediaId = requireId(operation.mediaId, 'invalid-input', 'mediaId');
  const index = project.media.findIndex((media) => media.id === mediaId);
  if (index < 0) fail('media-not-found', `media not found: ${mediaId}`);
  project.media.splice(index, 1);
  for (const track of project.tracks) {
    track.clips = track.clips.filter((clip) => clip.mediaId !== mediaId);
  }
}

function addClipOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  if (findClip(project, clipId)) fail('duplicate-id', `clip id already exists: ${clipId}`);

  const mediaId = requireId(operation.mediaId, 'invalid-input', 'mediaId');
  const media = findMedia(project, mediaId);
  if (!media) fail('media-not-found', `media not found: ${mediaId}`);

  const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
  const track = findTrack(project, trackId);
  if (!track) fail('track-not-found', `track not found: ${trackId}`);
  assertTrackAcceptsClipType(track, media.kind);

  const startFrame = requireNonNegativeInteger(operation.startFrame, 'invalid-input', 'startFrame');
  const trimStartFrame =
    operation.trimStartFrame === undefined
      ? 0
      : requireNonNegativeInteger(operation.trimStartFrame, 'invalid-input', 'trimStartFrame');

  let durationFrames;
  if (media.kind === 'image') {
    durationFrames =
      operation.durationFrames === undefined
        ? Math.max(1, Math.round(project.fps * IMAGE_DEFAULT_DURATION_SECONDS))
        : requirePositiveInteger(operation.durationFrames, 'invalid-input', 'durationFrames');
  } else {
    const remaining = media.durationFrames - trimStartFrame;
    if (remaining < 1) {
      fail(
        'out-of-bounds',
        `trimStartFrame ${trimStartFrame} leaves no source frames in media ${media.id} (${media.durationFrames})`,
      );
    }
    durationFrames =
      operation.durationFrames === undefined
        ? remaining
        : requirePositiveInteger(operation.durationFrames, 'invalid-input', 'durationFrames');
    if (trimStartFrame + durationFrames > media.durationFrames) {
      fail(
        'out-of-bounds',
        `source window ${trimStartFrame}+${durationFrames} exceeds media ${media.id} (${media.durationFrames})`,
      );
    }
  }

  const clip = createClip({
    id: clipId,
    type: media.kind,
    mediaId: media.id,
    startFrame,
    durationFrames,
    trimStartFrame,
  });
  insertClipWithOverwrite(project, track, clip, operation.splitRightClipId);
}

function moveClipOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);

  const startFrame = requireNonNegativeInteger(operation.startFrame, 'invalid-input', 'startFrame');

  let targetTrack = entry.track;
  if (operation.trackId !== undefined) {
    const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
    const found = findTrack(project, trackId);
    if (!found) fail('track-not-found', `track not found: ${trackId}`);
    targetTrack = found;
  }
  assertTrackAcceptsClipType(targetTrack, entry.clip.type);

  // Detach first so re-inserting on the same track never collides with itself.
  entry.track.clips = entry.track.clips.filter((clip) => clip !== entry.clip);
  entry.clip.startFrame = startFrame;
  insertClipWithOverwrite(project, targetTrack, entry.clip, operation.splitRightClipId);
}

/**
 * Resize a clip in place, NLE style.
 *
 * `durationFrames` sets the visible length (right edge; start stays put).
 * `trimStartFrame` sets the source in-point and, exactly like the upstream
 * editor, moves the clip's start by the same delta while keeping the end
 * anchored (unless `durationFrames` is also supplied for an explicit length).
 */
function trimClipOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;

  const hasDuration = operation.durationFrames !== undefined;
  const hasTrimStart = operation.trimStartFrame !== undefined;
  if (!hasDuration && !hasTrimStart) {
    fail('invalid-input', 'trim-clip requires durationFrames and/or trimStartFrame');
  }

  const oldStart = clip.startFrame;
  const oldDuration = clip.durationFrames;
  const oldTrimStart = clip.trimStartFrame;

  let trimStartFrame = hasTrimStart
    ? requireNonNegativeInteger(operation.trimStartFrame, 'invalid-input', 'trimStartFrame')
    : oldTrimStart;
  let durationFrames = hasDuration
    ? requirePositiveInteger(operation.durationFrames, 'invalid-input', 'durationFrames')
    : oldDuration;

  if (isTextLikeClip(clip.type) && trimStartFrame !== 0) {
    fail('invalid-input', `${clip.type} clips cannot have a non-zero trimStartFrame`);
  }

  const speed = clip.speed;
  let startFrame = oldStart;
  if (hasTrimStart) {
    // trimStartFrame is a source-frame offset; translate its delta to timeline
    // frames (DESIGN §11.1 / upstream trimClipInternal).
    const deltaSource = trimStartFrame - oldTrimStart;
    const deltaTimeline = Math.round(deltaSource / speed);
    startFrame = oldStart + deltaTimeline;
    if (!hasDuration) durationFrames = oldDuration - deltaTimeline;
  }

  if (startFrame < 0) fail('invalid-input', 'trim would move clip startFrame below 0');
  if (durationFrames < 1) fail('invalid-input', 'trim would make durationFrames < 1');

  if (clip.type === 'video' || clip.type === 'audio') {
    const media = findMedia(project, clip.mediaId);
    if (!media) fail('media-not-found', `media not found: ${String(clip.mediaId)}`);
    const consumed = sourceFramesConsumed(durationFrames, speed);
    if (trimStartFrame + consumed > media.durationFrames) {
      fail(
        'out-of-bounds',
        `source window ${trimStartFrame}+${consumed} exceeds media ${media.id} (${media.durationFrames})`,
      );
    }
  }

  // Keep keyframes/caption segments aligned with the retained source region.
  const headDelta = startFrame - oldStart;
  if (headDelta !== 0) shiftClipContent(clip, headDelta);
  truncateClipContent(clip, durationFrames);

  clip.startFrame = startFrame;
  clip.durationFrames = durationFrames;
  clip.trimStartFrame = trimStartFrame;
  sortTrackClips(entry.track);
  // A widened duration / moved start can collide with neighbours; the final
  // normalizeProject pass rejects the resulting overlap with code "overlap".
}

function splitClipOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;

  const atFrame = requireNonNegativeInteger(operation.atFrame, 'invalid-input', 'atFrame');
  const clipEnd = clip.startFrame + clip.durationFrames;
  if (!(clip.startFrame < atFrame && atFrame < clipEnd)) {
    fail(
      'invalid-split',
      `atFrame ${atFrame} is not strictly inside clip [${clip.startFrame}, ${clipEnd})`,
    );
  }

  const leftClipId = requireId(operation.leftClipId, 'invalid-input', 'leftClipId');
  const rightClipId = requireId(operation.rightClipId, 'invalid-input', 'rightClipId');
  if (leftClipId === rightClipId) {
    fail('duplicate-id', 'leftClipId and rightClipId must differ');
  }
  const existingIds = allClipIds(project);
  existingIds.delete(clip.id);
  if (existingIds.has(leftClipId)) fail('duplicate-id', `leftClipId already exists: ${leftClipId}`);
  if (existingIds.has(rightClipId)) fail('duplicate-id', `rightClipId already exists: ${rightClipId}`);

  const offset = atFrame - clip.startFrame;
  const left = deepClone(clip);
  left.id = leftClipId;
  left.durationFrames = offset;

  const right = deepClone(clip);
  right.id = rightClipId;
  right.startFrame = atFrame;
  right.durationFrames = clipEnd - atFrame;
  right.trimStartFrame = rebaseTrimStartForHeadRemoval(clip, right.durationFrames);
  splitClipContent(left, right, offset, clip);

  entry.track.clips = entry.track.clips.filter((item) => item !== clip);
  entry.track.clips.push(left, right);
  sortTrackClips(entry.track);
}

function removeClipsOperation(project, operation) {
  const clipIds = requireIdSet(operation.clipIds, 'invalid-input', 'clipIds');
  for (const clipId of clipIds) {
    if (!findClip(project, clipId)) fail('clip-not-found', `clip not found: ${clipId}`);
  }
  for (const track of project.tracks) {
    track.clips = track.clips.filter((clip) => !clipIds.has(clip.id));
  }
}

function setClipPropertiesOperation(project, operation) {
  const clipIds = requireIdSet(operation.clipIds, 'invalid-input', 'clipIds');
  const hasVolume = operation.volume !== undefined;
  const hasOpacity = operation.opacity !== undefined;
  const hasTransform = operation.transform !== undefined;
  if (!hasVolume && !hasOpacity && !hasTransform) {
    fail('invalid-input', 'set-clip-properties requires volume, opacity and/or transform');
  }

  const volume = hasVolume
    ? requireUnitNumber(operation.volume, 'invalid-input', 'volume')
    : undefined;
  const opacity = hasOpacity
    ? requireUnitNumber(operation.opacity, 'invalid-input', 'opacity')
    : undefined;
  if (hasTransform) assertObject(operation.transform, 'invalid-input', 'transform');

  const entries = [];
  for (const clipId of clipIds) {
    const entry = findClip(project, clipId);
    if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
    entries.push(entry);
  }

  for (const { clip } of entries) {
    if (hasVolume) clip.volume = volume;
    if (hasOpacity) clip.opacity = opacity;
    if (hasTransform) clip.transform = mergeTransform(clip.transform, operation.transform, 'invalid-input');
  }
}

function addTextOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  if (findClip(project, clipId)) fail('duplicate-id', `clip id already exists: ${clipId}`);

  const startFrame = requireNonNegativeInteger(operation.startFrame, 'invalid-input', 'startFrame');
  const durationFrames = requirePositiveInteger(
    operation.durationFrames,
    'invalid-input',
    'durationFrames',
  );
  const text = normalizeText(operation.text, 'invalid-input');
  const transform =
    operation.transform === undefined
      ? { ...DEFAULT_TEXT_TRANSFORM }
      : mergeTransform(DEFAULT_TEXT_TRANSFORM, operation.transform, 'invalid-input');

  const track = pickVideoTrackForOverlay(
    project,
    operation,
    startFrame,
    durationFrames,
    clipId,
    'text',
  );

  const clip = createClip({
    id: clipId,
    type: 'text',
    mediaId: null,
    startFrame,
    durationFrames,
    trimStartFrame: 0,
    transform,
    text,
  });
  insertClipWithOverwrite(project, track, clip, operation.splitRightClipId);
}

function updateTextOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  if (entry.clip.type !== 'text' || entry.clip.text === null) {
    fail('not-text-clip', `clip ${clipId} is not a text clip`);
  }

  const patch = {};
  if (operation.content !== undefined) patch.content = operation.content;
  if (operation.fontSize !== undefined) patch.fontSize = operation.fontSize;
  if (operation.color !== undefined) patch.color = operation.color;
  if (operation.fontWeight !== undefined) patch.fontWeight = operation.fontWeight;
  if (operation.align !== undefined) patch.align = operation.align;
  if (Object.keys(patch).length === 0) {
    fail('invalid-input', 'update-text requires at least one text field');
  }

  entry.clip.text = normalizeText({ ...entry.clip.text, ...patch }, 'invalid-input');
}

function reorderTracksOperation(project, operation) {
  const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
  const track = findTrack(project, trackId);
  if (!track) fail('track-not-found', `track not found: ${trackId}`);
  if (!Number.isInteger(operation.toIndex)) {
    fail('invalid-input', 'toIndex must be an integer');
  }
  if (operation.toIndex < 0 || operation.toIndex >= project.tracks.length) {
    fail(
      'index-out-of-range',
      `toIndex ${operation.toIndex} is outside 0..${project.tracks.length - 1}`,
    );
  }
  const fromIndex = project.tracks.indexOf(track);
  project.tracks.splice(fromIndex, 1);
  project.tracks.splice(operation.toIndex, 0, track);
}

// ---------------------------------------------------------------------------
// Internal: Phase 1 operations (speed, keyframes, effects, fades, markers,
// transitions, captions)
// ---------------------------------------------------------------------------

function pickVideoTrackForOverlay(project, operation, startFrame, durationFrames, clipId, idPrefix) {
  if (operation.trackId !== undefined) {
    const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
    const found = findTrack(project, trackId);
    if (!found) fail('track-not-found', `track not found: ${trackId}`);
    if (found.type !== 'video') {
      fail('incompatible-track-type', `overlay clips require a video track (${trackId} is audio)`);
    }
    return found;
  }
  const freeTrack = project.tracks.find(
    (candidate) =>
      candidate.type === 'video' &&
      rangeIsFree(candidate.clips, startFrame, startFrame + durationFrames),
  );
  if (freeTrack !== undefined) return freeTrack;
  const baseId = `${idPrefix}-track-${clipId}`;
  let trackId = baseId;
  let suffix = 2;
  while (findTrack(project, trackId)) trackId = `${baseId}-${suffix++}`;
  const track = {
    id: trackId,
    type: 'video',
    name: trackDefaultName(project, 'video'),
    muted: false,
    hidden: false,
    clips: [],
  };
  project.tracks.push(track);
  return track;
}

function setSpeedOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;

  const speed = requireFiniteNumber(operation.speed, 'invalid-input', 'speed');
  if (speed < SPEED_MIN || speed > SPEED_MAX) {
    fail('invalid-input', `speed must be in [${SPEED_MIN},${SPEED_MAX}]`);
  }
  if (clip.type === 'image' || clip.type === 'text' || clip.type === 'caption') {
    fail('invalid-input', `${clip.type} clips must keep speed 1`);
  }

  const oldDuration = clip.durationFrames;
  const newDuration = Math.max(1, Math.round((oldDuration * clip.speed) / speed));

  if (clip.type === 'video' || clip.type === 'audio') {
    const media = findMedia(project, clip.mediaId);
    if (!media) fail('media-not-found', `media not found: ${String(clip.mediaId)}`);
    const consumed = sourceFramesConsumed(newDuration, speed);
    if (clip.trimStartFrame + consumed > media.durationFrames) {
      fail(
        'out-of-bounds',
        `source window ${clip.trimStartFrame}+${consumed} exceeds media ${media.id} (${media.durationFrames})`,
      );
    }
  }

  scaleClipKeyframes(clip, oldDuration, newDuration);
  clip.speed = speed;
  clip.durationFrames = newDuration;
  // Fades that no longer fit are clamped by the final normalize pass.
}

function setKeyframesOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;

  const property = operation.property;
  if (!KEYFRAME_PROPERTIES.includes(property)) {
    fail('invalid-input', `property must be one of ${KEYFRAME_PROPERTIES.join('/')}`);
  }
  const list = normalizeKeyframeList(
    property,
    operation.keyframes,
    clip.durationFrames,
    'invalid-keyframe',
  );
  const next = deepClone(clip.keyframes);
  if (list.length > 0) next[property] = list;
  else delete next[property];
  clip.keyframes = next;
}

function addEffectOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  if (operation.effect === undefined) fail('invalid-input', 'effect is required');
  const effect = normalizeEffect(operation.effect, 'invalid-effect');
  if (entry.clip.effects.some((existing) => existing.id === effect.id)) {
    fail('duplicate-id', `effect id already exists on clip: ${effect.id}`);
  }
  entry.clip.effects.push(effect);
}

function updateEffectOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const effectId = requireId(operation.effectId, 'invalid-input', 'effectId');
  const index = entry.clip.effects.findIndex((effect) => effect.id === effectId);
  if (index < 0) fail('effect-not-found', `effect not found: ${effectId}`);

  // DESIGN §11.2 spells this operation as `{ clipId, effectId, patch }`; the
  // nested patch avoids colliding with the operation-level `type` dispatcher key.
  const patch = operation.patch === undefined ? {} : operation.patch;
  assertObject(patch, 'invalid-input', 'patch');
  const hasType = patch.type !== undefined;
  const hasEnabled = patch.enabled !== undefined;
  const hasParams = patch.params !== undefined;
  if (!hasType && !hasEnabled && !hasParams) {
    fail('invalid-input', 'update-effect requires patch.type, patch.enabled and/or patch.params');
  }

  const current = entry.clip.effects[index];
  let type = current.type;
  if (hasType) {
    if (!EFFECT_TYPES.includes(patch.type)) {
      fail('invalid-input', `patch.type must be one of ${EFFECT_TYPES.join('/')}`);
    }
    type = patch.type;
  }

  let params;
  if (hasParams) {
    assertObject(patch.params, 'invalid-input', 'patch.params');
    const base = type === current.type ? current.params : {};
    params = normalizeEffectParams(type, { ...base, ...patch.params }, 'invalid-input');
  } else if (type !== current.type) {
    params = normalizeEffectParams(type, {}, 'invalid-input');
  } else {
    params = current.params;
  }
  const enabled = hasEnabled
    ? requireBoolean(patch.enabled, 'invalid-input', 'patch.enabled')
    : current.enabled;

  entry.clip.effects[index] = {
    id: effectId,
    type,
    enabled,
    params,
  };
}

function removeEffectOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const effectId = requireId(operation.effectId, 'invalid-input', 'effectId');
  const index = entry.clip.effects.findIndex((effect) => effect.id === effectId);
  if (index < 0) fail('effect-not-found', `effect not found: ${effectId}`);
  entry.clip.effects.splice(index, 1);
}

function reorderEffectsOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  if (!Array.isArray(operation.effectIds) || operation.effectIds.length === 0) {
    fail('invalid-input', 'effectIds must be a non-empty array');
  }
  const effectIds = operation.effectIds.map((id) => requireId(id, 'invalid-input', 'effectIds[]'));
  const current = entry.clip.effects.map((effect) => effect.id);
  if (effectIds.length !== current.length) {
    fail('invalid-input', 'effectIds must list every effect exactly once');
  }
  const wanted = new Set(effectIds);
  if (wanted.size !== effectIds.length || current.some((id) => !wanted.has(id))) {
    fail('invalid-input', 'effectIds must list every effect exactly once');
  }
  entry.clip.effects = effectIds.map((id) => entry.clip.effects.find((effect) => effect.id === id));
}

function setFadesOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;
  const hasFadeIn = operation.fadeInFrames !== undefined;
  const hasFadeOut = operation.fadeOutFrames !== undefined;
  if (!hasFadeIn && !hasFadeOut) {
    fail('invalid-input', 'set-fades requires fadeInFrames and/or fadeOutFrames');
  }
  const fadeInFrames = hasFadeIn
    ? requireNonNegativeInteger(operation.fadeInFrames, 'invalid-input', 'fadeInFrames')
    : clip.fadeInFrames;
  const fadeOutFrames = hasFadeOut
    ? requireNonNegativeInteger(operation.fadeOutFrames, 'invalid-input', 'fadeOutFrames')
    : clip.fadeOutFrames;
  if (fadeInFrames > clip.durationFrames) {
    fail('invalid-input', 'fadeInFrames must be <= clip.durationFrames');
  }
  if (fadeOutFrames > clip.durationFrames) {
    fail('invalid-input', 'fadeOutFrames must be <= clip.durationFrames');
  }
  clip.fadeInFrames = fadeInFrames;
  clip.fadeOutFrames = fadeOutFrames;
}

function addMarkerOperation(project, operation) {
  if (operation.marker === undefined) fail('invalid-input', 'marker is required');
  const marker = normalizeMarker(operation.marker, 'invalid-marker');
  if (project.markers.some((existing) => existing.id === marker.id)) {
    fail('duplicate-id', `marker id already exists: ${marker.id}`);
  }
  project.markers.push(marker);
  sortMarkers(project.markers);
}

function updateMarkerOperation(project, operation) {
  const markerId = requireId(operation.markerId, 'invalid-input', 'markerId');
  const index = project.markers.findIndex((marker) => marker.id === markerId);
  if (index < 0) fail('marker-not-found', `marker not found: ${markerId}`);
  const current = project.markers[index];
  const hasFrame = operation.frame !== undefined;
  const hasLabel = operation.label !== undefined;
  const hasColor = operation.color !== undefined;
  if (!hasFrame && !hasLabel && !hasColor) {
    fail('invalid-input', 'update-marker requires frame, label and/or color');
  }
  const candidate = {
    id: current.id,
    frame: hasFrame ? operation.frame : current.frame,
    label: hasLabel ? operation.label : current.label,
    color: hasColor ? operation.color : current.color,
  };
  project.markers[index] = normalizeMarker(candidate, 'invalid-marker');
  sortMarkers(project.markers);
}

function removeMarkerOperation(project, operation) {
  const markerId = requireId(operation.markerId, 'invalid-input', 'markerId');
  const index = project.markers.findIndex((marker) => marker.id === markerId);
  if (index < 0) fail('marker-not-found', `marker not found: ${markerId}`);
  project.markers.splice(index, 1);
}

function addTransitionOperation(project, operation) {
  if (operation.transition === undefined) fail('invalid-input', 'transition is required');
  const transition = normalizeTransition(operation.transition, 'invalid-transition');
  if (project.transitions.some((existing) => existing.id === transition.id)) {
    fail('duplicate-id', `transition id already exists: ${transition.id}`);
  }
  validateTransition(project, transition);
  project.transitions.push(transition);
  sortTransitions(project);
}

function updateTransitionOperation(project, operation) {
  const transitionId = requireId(operation.transitionId, 'invalid-input', 'transitionId');
  const index = project.transitions.findIndex((transition) => transition.id === transitionId);
  if (index < 0) fail('transition-not-found', `transition not found: ${transitionId}`);
  // `type` is the operation dispatcher key, so the new transition kind is
  // supplied as `transitionType` (documented Phase 1 deviation).
  const hasType = operation.transitionType !== undefined;
  const hasDuration = operation.durationFrames !== undefined;
  if (!hasType && !hasDuration) {
    fail('invalid-input', 'update-transition requires transitionType and/or durationFrames');
  }
  const current = project.transitions[index];
  const candidate = normalizeTransition(
    {
      id: current.id,
      trackId: current.trackId,
      fromClipId: current.fromClipId,
      toClipId: current.toClipId,
      type: hasType ? operation.transitionType : current.type,
      durationFrames: hasDuration ? operation.durationFrames : current.durationFrames,
    },
    'invalid-transition',
  );
  validateTransition(project, candidate);
  project.transitions[index] = candidate;
  sortTransitions(project);
}

function removeTransitionOperation(project, operation) {
  const transitionId = requireId(operation.transitionId, 'invalid-input', 'transitionId');
  const index = project.transitions.findIndex((transition) => transition.id === transitionId);
  if (index < 0) fail('transition-not-found', `transition not found: ${transitionId}`);
  project.transitions.splice(index, 1);
}

function addCaptionOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  if (findClip(project, clipId)) fail('duplicate-id', `clip id already exists: ${clipId}`);

  const startFrame = requireNonNegativeInteger(operation.startFrame, 'invalid-input', 'startFrame');
  const durationFrames = requirePositiveInteger(
    operation.durationFrames,
    'invalid-input',
    'durationFrames',
  );
  const segments = normalizeCaptionSegments(operation.segments, durationFrames, 'invalid-caption');
  const style = normalizeCaptionStyle(operation.style, 'invalid-caption');

  const track = pickVideoTrackForOverlay(
    project,
    operation,
    startFrame,
    durationFrames,
    clipId,
    'caption',
  );
  const clip = createClip({
    id: clipId,
    type: 'caption',
    mediaId: null,
    startFrame,
    durationFrames,
    trimStartFrame: 0,
    transform:
      operation.transform === undefined
        ? { x: 0.05, y: 0.78, width: 0.9, height: 0.16, rotation: 0 }
        : operation.transform,
    caption: { segments, style },
  });
  insertClipWithOverwrite(project, track, clip, operation.splitRightClipId);
}

function updateCaptionOperation(project, operation) {
  const clipId = requireId(operation.clipId, 'invalid-input', 'clipId');
  const entry = findClip(project, clipId);
  if (!entry) fail('clip-not-found', `clip not found: ${clipId}`);
  const clip = entry.clip;
  if (clip.type !== 'caption' || clip.caption === null) {
    fail('not-caption-clip', `clip ${clipId} is not a caption clip`);
  }
  const hasSegments = operation.segments !== undefined;
  const hasStyle = operation.style !== undefined;
  if (!hasSegments && !hasStyle) {
    fail('invalid-input', 'update-caption requires segments and/or style');
  }
  if (hasSegments) {
    clip.caption.segments = normalizeCaptionSegments(
      operation.segments,
      clip.durationFrames,
      'invalid-caption',
    );
  }
  if (hasStyle) {
    assertObject(operation.style, 'invalid-input', 'style');
    clip.caption.style = normalizeCaptionStyle(
      { ...clip.caption.style, ...operation.style },
      'invalid-caption',
    );
  }
}

const OPERATIONS = Object.freeze({
  'add-track': addTrackOperation,
  'remove-track': removeTrackOperation,
  'add-media': addMediaOperation,
  'remove-media': removeMediaOperation,
  'add-clip': addClipOperation,
  'move-clip': moveClipOperation,
  'trim-clip': trimClipOperation,
  'split-clip': splitClipOperation,
  'remove-clips': removeClipsOperation,
  'set-clip-properties': setClipPropertiesOperation,
  'add-text': addTextOperation,
  'update-text': updateTextOperation,
  'reorder-tracks': reorderTracksOperation,
  // Phase 1 (DESIGN §11.2)
  'set-speed': setSpeedOperation,
  'set-keyframes': setKeyframesOperation,
  'add-effect': addEffectOperation,
  'update-effect': updateEffectOperation,
  'remove-effect': removeEffectOperation,
  'reorder-effects': reorderEffectsOperation,
  'set-fades': setFadesOperation,
  'add-marker': addMarkerOperation,
  'update-marker': updateMarkerOperation,
  'remove-marker': removeMarkerOperation,
  'add-transition': addTransitionOperation,
  'update-transition': updateTransitionOperation,
  'remove-transition': removeTransitionOperation,
  'add-caption': addCaptionOperation,
  'update-caption': updateCaptionOperation,
});

/**
 * Apply one operation and return a brand new Project.
 *
 * Pure: the input project and operation are never mutated. Transitions whose
 * clip edge no longer exists/adjacent are pruned, `updatedAt` is stamped with
 * `Date.now()` and every invariant is re-validated before return.
 */
export function applyOperation(project, operation) {
  const next = normalizeProject(project);
  assertObject(operation, 'invalid-operation', 'operation');
  if (typeof operation.type !== 'string') {
    fail('invalid-operation', 'operation.type must be a string');
  }
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, operation.type)) {
    fail('unknown-operation', `unknown operation type: ${operation.type}`);
  }
  OPERATIONS[operation.type](next, operation);
  pruneTransitions(next);
  next.updatedAt = Date.now();
  return normalizeProject(next);
}
