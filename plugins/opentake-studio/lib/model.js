/**
 * OpenTake Studio — pure project/timeline model.
 *
 * Contract: `plugins/opentake-studio/docs/DESIGN.md` §3.
 *
 * Design principles:
 * - Pure data in / pure data out. `applyOperation` never mutates its inputs and
 *   never generates random values; every id is supplied by the caller.
 * - `applyOperation` deep-clones the project through `normalizeProject`, applies
 *   one operation, stamps `updatedAt` and re-validates every invariant before
 *   returning the new Project.
 * - All failures are `ModelError` with a stable `code` (see README notes in the
 *   task report for the exact list).
 */

const PROJECT_VERSION = 1;
const ALLOWED_FPS = [24, 25, 30, 50, 60];
const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_PROJECT_NAME = 'Untitled';

/** Timeline frames used when an `add-clip` for an image omits `durationFrames`. */
const IMAGE_DEFAULT_DURATION_SECONDS = 5;

const CLIP_TYPES = ['video', 'image', 'audio', 'text'];
const MEDIA_KINDS = ['video', 'audio', 'image'];
const TRACK_TYPES = ['video', 'audio'];
const FONT_WEIGHTS = ['400', '600', '700'];
const TEXT_ALIGNS = ['left', 'center', 'right'];

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
    return clipType === 'video' || clipType === 'image' || clipType === 'text';
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

function normalizeMedia(value, projectFps) {
  const code = 'invalid-media';
  assertObject(value, code, 'media');
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

function normalizeClip(value) {
  const code = 'invalid-clip';
  assertObject(value, code, 'clip');
  const id = requireId(value.id, code, 'clip.id');
  if (!CLIP_TYPES.includes(value.type)) {
    fail(code, `clip.type must be one of ${CLIP_TYPES.join('/')}`);
  }
  const type = value.type;

  let mediaId = null;
  if (type === 'text') {
    if (value.mediaId !== undefined && value.mediaId !== null) {
      fail(code, 'text clip must have mediaId: null');
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
  if (type === 'text' && trimStartFrame !== 0) {
    fail(code, 'text clip must have trimStartFrame: 0');
  }
  if (value.speed !== undefined && value.speed !== 1) {
    fail(code, 'clip.speed must be 1 in this version');
  }
  const volume =
    value.volume === undefined ? 1 : requireUnitNumber(value.volume, code, 'clip.volume');
  const opacity =
    value.opacity === undefined ? 1 : requireUnitNumber(value.opacity, code, 'clip.opacity');
  const transform = normalizeTransform(value.transform, code);

  let text = null;
  if (type === 'text') {
    if (value.text === undefined || value.text === null) {
      fail(code, 'text clip requires a text object');
    }
    text = normalizeText(value.text, code);
  } else if (value.text !== undefined && value.text !== null) {
    fail(code, 'non-text clip must have text: null');
  }

  return {
    id,
    type,
    mediaId,
    startFrame,
    durationFrames,
    trimStartFrame,
    speed: 1,
    volume,
    opacity,
    transform,
    text,
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

      if (clip.type === 'text') {
        if (clip.mediaId !== null) fail('invalid-clip', `text clip ${clip.id} must have mediaId: null`);
        if (clip.trimStartFrame !== 0) {
          fail('invalid-clip', `text clip ${clip.id} must have trimStartFrame: 0`);
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
          if (clip.trimStartFrame + clip.durationFrames > media.durationFrames) {
            fail(
              'out-of-bounds',
              `clip ${clip.id} source window ${clip.trimStartFrame}+${clip.durationFrames} exceeds media ${media.id} (${media.durationFrames})`,
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

  const media = (value.media === undefined ? [] : value.media).map((item) => normalizeMedia(item, fps));
  const tracks = (value.tracks === undefined ? [] : value.tracks).map((item) => normalizeTrack(item));

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
  };
  validateProject(project);
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
// Internal: clip construction + overwrite/overlap resolution
// ---------------------------------------------------------------------------

function createClip({
  id,
  type,
  mediaId,
  startFrame,
  durationFrames,
  trimStartFrame = 0,
  volume = 1,
  opacity = 1,
  transform = DEFAULT_CLIP_TRANSFORM,
  text = null,
}) {
  return {
    id,
    type,
    mediaId,
    startFrame,
    durationFrames,
    trimStartFrame,
    speed: 1,
    volume,
    opacity,
    transform: { ...transform },
    text: text === null ? null : { ...text },
  };
}

/**
 * Resolve same-track overlaps for a new interval `[start, end)`.
 *
 * Mirrors DESIGN §3 and the upstream overwrite engine:
 * - untouched clips are kept;
 * - fully covered clips are removed;
 * - a clip whose right side is covered is trimmed (`duration = start - clip.start`);
 * - a clip whose left side is covered is trimmed and re-based
 *   (`trimStart += end - clip.start`, `start = end`);
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
      const left = deepClone(old);
      left.durationFrames = start - oldStart;
      const right = deepClone(old);
      right.id = splitRightClipId;
      right.startFrame = end;
      right.durationFrames = oldEnd - end;
      // Text has no source window, so its trim offset stays 0 (DESIGN §3).
      right.trimStartFrame = old.type === 'text' ? 0 : old.trimStartFrame + (end - oldStart);
      resolved.push(left, right);
      continue;
    }
    if (oldStart < start) {
      // Right part is covered — trim the clip's end.
      const left = deepClone(old);
      left.durationFrames = start - oldStart;
      resolved.push(left);
      continue;
    }
    // Left part is covered — trim the clip's start and rebase its source offset.
    const right = deepClone(old);
    // Text has no source window, so its trim offset stays 0 (DESIGN §3).
    right.trimStartFrame = old.type === 'text' ? 0 : old.trimStartFrame + (end - oldStart);
    right.startFrame = end;
    right.durationFrames = oldEnd - end;
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

  if (clip.type === 'text' && trimStartFrame !== 0) {
    fail('invalid-input', 'text clips cannot have a non-zero trimStartFrame');
  }

  let startFrame = oldStart;
  if (hasTrimStart) {
    const delta = trimStartFrame - oldTrimStart;
    startFrame = oldStart + delta;
    if (!hasDuration) durationFrames = oldDuration - delta;
  }

  if (startFrame < 0) fail('invalid-input', 'trim would move clip startFrame below 0');
  if (durationFrames < 1) fail('invalid-input', 'trim would make durationFrames < 1');

  if (clip.type === 'video' || clip.type === 'audio') {
    const media = findMedia(project, clip.mediaId);
    if (!media) fail('media-not-found', `media not found: ${String(clip.mediaId)}`);
    if (trimStartFrame + durationFrames > media.durationFrames) {
      fail(
        'out-of-bounds',
        `source window ${trimStartFrame}+${durationFrames} exceeds media ${media.id} (${media.durationFrames})`,
      );
    }
  }

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
  // Text has no source window, so its trim offset stays 0 (DESIGN §3).
  right.trimStartFrame = clip.type === 'text' ? 0 : clip.trimStartFrame + offset;

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

  let track;
  if (operation.trackId !== undefined) {
    const trackId = requireId(operation.trackId, 'invalid-input', 'trackId');
    const found = findTrack(project, trackId);
    if (!found) fail('track-not-found', `track not found: ${trackId}`);
    if (found.type !== 'video') {
      fail('incompatible-track-type', `text clips require a video track (${trackId} is audio)`);
    }
    track = found;
  } else {
    track = project.tracks.find(
      (candidate) =>
        candidate.type === 'video' &&
        rangeIsFree(candidate.clips, startFrame, startFrame + durationFrames),
    );
    if (!track) {
      const baseId = `text-track-${clipId}`;
      let trackId = baseId;
      let suffix = 2;
      while (findTrack(project, trackId)) trackId = `${baseId}-${suffix++}`;
      track = {
        id: trackId,
        type: 'video',
        name: trackDefaultName(project, 'video'),
        muted: false,
        hidden: false,
        clips: [],
      };
      project.tracks.push(track);
    }
  }

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
});

/**
 * Apply one operation and return a brand new Project.
 *
 * Pure: the input project and operation are never mutated. `updatedAt` is
 * stamped with `Date.now()` and every invariant is re-validated before return.
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
  next.updatedAt = Date.now();
  return normalizeProject(next);
}
