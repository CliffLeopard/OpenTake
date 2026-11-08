/**
 * OpenTake Studio — model tests (node:test).
 * Run: node --test plugins/opentake-studio/test/model.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelError,
  createProject,
  normalizeProject,
  cloneProject,
  timelineDurationFrames,
  findMedia,
  findTrack,
  findClip,
  applyOperation,
  secondsToFrames,
  framesToSeconds,
  snapFrame,
  evaluateKeyframes,
  sourceFrameForTimeline,
} from '../lib/model.js';

const FPS = 30;
const DEFAULT_TRANSFORM = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
const TEXT_TRANSFORM = { x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 0 };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function media(overrides = {}) {
  const id = overrides.id ?? 'm-video';
  const kind = overrides.kind ?? 'video';
  const durationSeconds = overrides.durationSeconds ?? (kind === 'image' ? null : 10);
  const durationFrames =
    overrides.durationFrames !== undefined
      ? overrides.durationFrames
      : kind === 'image'
        ? null
        : Math.round(durationSeconds * FPS);
  return {
    id,
    name: overrides.name ?? id,
    kind,
    fileName: overrides.fileName ?? `${id}.mp4`,
    durationFrames,
    sourceDurationSeconds:
      overrides.sourceDurationSeconds !== undefined
        ? overrides.sourceDurationSeconds
        : kind === 'image'
          ? null
          : durationSeconds,
    width: overrides.width !== undefined ? overrides.width : 1920,
    height: overrides.height !== undefined ? overrides.height : 1080,
    hasAudio: overrides.hasAudio !== undefined ? overrides.hasAudio : kind !== 'image',
    sizeBytes: overrides.sizeBytes ?? 1024,
    importedAt: overrides.importedAt ?? 1700000000000,
  };
}

function emptyProject() {
  return createProject({ name: 'Fixture', fps: FPS, width: 1920, height: 1080 });
}

function fixture({ tracks = true } = {}) {
  let project = emptyProject();
  project = applyOperation(project, {
    type: 'add-media',
    media: media({ id: 'm-video', durationFrames: 300 }),
  });
  project = applyOperation(project, {
    type: 'add-media',
    media: media({ id: 'm-video2', durationFrames: 300 }),
  });
  project = applyOperation(project, {
    type: 'add-media',
    media: media({ id: 'm-audio', kind: 'audio', durationFrames: 600 }),
  });
  project = applyOperation(project, {
    type: 'add-media',
    media: media({ id: 'm-image', kind: 'image' }),
  });
  if (tracks) {
    project = applyOperation(project, {
      type: 'add-track',
      trackId: 't-video',
      trackType: 'video',
    });
    project = applyOperation(project, {
      type: 'add-track',
      trackId: 't-video2',
      trackType: 'video',
    });
    project = applyOperation(project, {
      type: 'add-track',
      trackId: 't-audio',
      trackType: 'audio',
    });
  }
  return project;
}

function addClip(project, options = {}) {
  const operation = {
    type: 'add-clip',
    clipId: options.clipId,
    mediaId: options.mediaId ?? 'm-video',
    trackId: options.trackId ?? 't-video',
    startFrame: options.startFrame ?? 0,
  };
  if (options.durationFrames !== undefined) operation.durationFrames = options.durationFrames;
  if (options.trimStartFrame !== undefined) operation.trimStartFrame = options.trimStartFrame;
  if (options.splitRightClipId !== undefined) operation.splitRightClipId = options.splitRightClipId;
  return applyOperation(project, operation);
}

function addText(project, options = {}) {
  const operation = {
    type: 'add-text',
    clipId: options.clipId,
    startFrame: options.startFrame ?? 0,
    durationFrames: options.durationFrames ?? 60,
    text: options.text ?? { content: 'Hello' },
  };
  if (options.trackId !== undefined) operation.trackId = options.trackId;
  if (options.transform !== undefined) operation.transform = options.transform;
  if (options.splitRightClipId !== undefined) operation.splitRightClipId = options.splitRightClipId;
  return applyOperation(project, operation);
}

function expectModelError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ModelError, `expected ModelError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function trackClips(project, trackId) {
  const track = findTrack(project, trackId);
  assert.ok(track, `track ${trackId} should exist`);
  return track.clips;
}

function clipById(project, clipId) {
  const entry = findClip(project, clipId);
  assert.ok(entry, `clip ${clipId} should exist`);
  return entry.clip;
}

function rawProject() {
  return {
    version: 1,
    name: 'Raw',
    fps: 30,
    width: 640,
    height: 360,
    createdAt: 1000,
    updatedAt: 2000,
    media: [{ id: 'm', kind: 'video', fileName: 'm.mp4', durationFrames: 300 }],
    tracks: [
      {
        id: 't',
        type: 'video',
        clips: [
          { id: 'c2', type: 'video', mediaId: 'm', startFrame: 200, durationFrames: 50 },
          { id: 'c1', type: 'video', mediaId: 'm', startFrame: 0, durationFrames: 50 },
        ],
      },
    ],
  };
}

function mutatedRaw(mutator) {
  const raw = rawProject();
  mutator(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

describe('time helpers', () => {
  it('secondsToFrames converts and rounds at the project fps', () => {
    assert.equal(secondsToFrames(1, 30), 30);
    assert.equal(secondsToFrames(1.5, 30), 45);
    assert.equal(secondsToFrames(2, 24), 48);
    assert.equal(secondsToFrames(0, 30), 0);
    assert.equal(secondsToFrames(1 / 30, 30), 1);
    assert.equal(secondsToFrames(0.5, 30), 15);
  });

  it('framesToSeconds converts back', () => {
    assert.equal(framesToSeconds(45, 30), 1.5);
    assert.equal(framesToSeconds(24, 24), 1);
    assert.equal(framesToSeconds(0, 60), 0);
  });

  it('snapFrame rounds and clamps at 0', () => {
    assert.equal(snapFrame(12.4), 12);
    assert.equal(snapFrame(12.6), 13);
    assert.equal(snapFrame(-5), 0);
  });

  it('rejects invalid inputs', () => {
    expectModelError(() => secondsToFrames(-1, 30), 'invalid-input');
    expectModelError(() => secondsToFrames(Number.NaN, 30), 'invalid-input');
    expectModelError(() => secondsToFrames(1, 29), 'unsupported-fps');
    expectModelError(() => framesToSeconds(1, 29), 'unsupported-fps');
    expectModelError(() => snapFrame(Number.POSITIVE_INFINITY), 'invalid-input');
  });
});

// ---------------------------------------------------------------------------
// Project creation / normalize
// ---------------------------------------------------------------------------

describe('createProject', () => {
  it('creates an empty project with defaults', () => {
    const project = createProject();
    assert.equal(project.version, 1);
    assert.equal(project.name, 'Untitled');
    assert.equal(project.fps, 30);
    assert.equal(project.width, 1920);
    assert.equal(project.height, 1080);
    assert.deepEqual(project.media, []);
    assert.deepEqual(project.tracks, []);
    assert.equal(typeof project.createdAt, 'number');
    assert.equal(typeof project.updatedAt, 'number');
    assert.equal(project.createdAt, project.updatedAt);
  });

  it('accepts name/fps/width/height overrides', () => {
    const project = createProject({ name: 'My Film', fps: 24, width: 1280, height: 720 });
    assert.equal(project.name, 'My Film');
    assert.equal(project.fps, 24);
    assert.equal(project.width, 1280);
    assert.equal(project.height, 720);
  });

  it('does not pre-create tracks', () => {
    assert.equal(createProject().tracks.length, 0);
  });

  it('rejects unsupported fps', () => {
    expectModelError(() => createProject({ fps: 29 }), 'unsupported-fps');
  });

  it('rejects invalid dimensions and name', () => {
    expectModelError(() => createProject({ width: 0 }), 'invalid-project');
    expectModelError(() => createProject({ height: -10 }), 'invalid-project');
    expectModelError(() => createProject({ name: '' }), 'invalid-project');
  });
});

describe('normalizeProject', () => {
  it('fills every default from a bare object', () => {
    const project = normalizeProject({});
    assert.equal(project.version, 1);
    assert.equal(project.name, 'Untitled');
    assert.equal(project.fps, 30);
    assert.equal(project.width, 1920);
    assert.equal(project.height, 1080);
    assert.deepEqual(project.media, []);
    assert.deepEqual(project.tracks, []);
    assert.equal(typeof project.createdAt, 'number');
    assert.equal(typeof project.updatedAt, 'number');
  });

  it('normalizes media, track and clip defaults and sorts clips', () => {
    const project = normalizeProject(rawProject());
    // media defaults
    const media = project.media[0];
    assert.equal(media.name, 'm.mp4');
    assert.equal(media.sourceDurationSeconds, null);
    assert.equal(media.width, null);
    assert.equal(media.height, null);
    assert.equal(media.hasAudio, false);
    assert.equal(media.sizeBytes, 0);
    assert.equal(typeof media.importedAt, 'number');
    // track defaults
    const track = project.tracks[0];
    assert.equal(track.name, 'Video');
    assert.equal(track.muted, false);
    assert.equal(track.hidden, false);
    // clips sorted by startFrame
    assert.deepEqual(
      track.clips.map((clip) => clip.id),
      ['c1', 'c2'],
    );
    // clip defaults
    const clip = track.clips[0];
    assert.equal(clip.trimStartFrame, 0);
    assert.equal(clip.speed, 1);
    assert.equal(clip.volume, 1);
    assert.equal(clip.opacity, 1);
    assert.deepEqual(clip.transform, DEFAULT_TRANSFORM);
    assert.equal(clip.text, null);
  });

  it('derives durationFrames from sourceDurationSeconds', () => {
    const project = normalizeProject({
      media: [
        {
          id: 'm2',
          kind: 'video',
          fileName: 'm2.mp4',
          sourceDurationSeconds: 2.5,
        },
      ],
    });
    assert.equal(project.media[0].durationFrames, 75);
  });

  it('strips unknown properties', () => {
    const raw = rawProject();
    raw.bogus = true;
    raw.media[0].bogus = true;
    raw.tracks[0].clips[0].bogus = true;
    const project = normalizeProject(raw);
    assert.equal('bogus' in project, false);
    assert.equal('bogus' in project.media[0], false);
    assert.equal('bogus' in project.tracks[0].clips[0], false);
  });

  it('rejects unsupported versions and fps', () => {
    expectModelError(() => normalizeProject({ version: 2 }), 'unsupported-version');
    expectModelError(() => normalizeProject({ fps: 29 }), 'unsupported-fps');
  });

  it('rejects malformed containers', () => {
    expectModelError(() => normalizeProject(null), 'invalid-project');
    expectModelError(() => normalizeProject([]), 'invalid-project');
    expectModelError(() => normalizeProject({ media: 'nope' }), 'invalid-project');
    expectModelError(() => normalizeProject({ tracks: {} }), 'invalid-project');
  });

  it('rejects duplicate ids', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.media.push({ ...raw.media[0] });
          }),
        ),
      'duplicate-id',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.tracks.push({ ...raw.tracks[0], clips: [] });
          }),
        ),
      'duplicate-id',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.tracks.push({
              id: 't2',
              type: 'video',
              clips: [{ ...raw.tracks[0].clips[1] }],
            });
          }),
        ),
      'duplicate-id',
    );
  });

  it('rejects overlapping clips on a track', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.tracks[0].clips[0].startFrame = 40;
          }),
        ),
      'overlap',
    );
  });

  it('rejects broken media references and mismatched clip kinds', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.tracks[0].clips[0].mediaId = 'ghost';
          }),
        ),
      'media-not-found',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.media[0].kind = 'audio';
          }),
        ),
      'invalid-clip',
    );
  });

  it('rejects clips that exceed their media bounds', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((raw) => {
            raw.tracks[0].clips[0].durationFrames = 301;
          }),
        ),
      'out-of-bounds',
    );
  });

  it('enforces text clip invariants', () => {
    const textClip = {
      id: 'txt',
      type: 'text',
      mediaId: null,
      startFrame: 0,
      durationFrames: 30,
      text: { content: 'Hi' },
    };
    const base = () => ({
      tracks: [{ id: 't', type: 'video', clips: [textClip] }],
    });
    assert.doesNotThrow(() => normalizeProject(base()));
    expectModelError(
      () =>
        normalizeProject({
          tracks: [{ id: 't', type: 'video', clips: [{ ...textClip, mediaId: 'm' }] }],
        }),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject({
          tracks: [{ id: 't', type: 'video', clips: [{ ...textClip, trimStartFrame: 3 }] }],
        }),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject({
          tracks: [{ id: 't', type: 'video', clips: [{ ...textClip, text: null }] }],
        }),
      'invalid-clip',
    );
  });

  it('rejects invalid media and track records', () => {
    expectModelError(
      () => normalizeProject({ media: [{ id: 'x', kind: 'pdf', fileName: 'x.pdf' }] }),
      'invalid-media',
    );
    expectModelError(
      () =>
        normalizeProject({
          media: [{ id: 'x', kind: 'image', fileName: 'x.png', durationFrames: 10 }],
        }),
      'invalid-media',
    );
    expectModelError(
      () => normalizeProject({ tracks: [{ id: 't', type: 'subtitle', clips: [] }] }),
      'invalid-track',
    );
    expectModelError(
      () => normalizeProject({ tracks: [{ id: 't', type: 'video', clips: 'nope' }] }),
      'invalid-track',
    );
  });

  it('rejects invalid clip fields', () => {
    const withClip = (patch) =>
      normalizeProject(
        mutatedRaw((raw) => {
          Object.assign(raw.tracks[0].clips[0], patch);
        }),
      );
    expectModelError(() => withClip({ transform: { x: 2 } }), 'invalid-clip');
    expectModelError(() => withClip({ volume: 1.5 }), 'invalid-clip');
    expectModelError(() => withClip({ opacity: -0.1 }), 'invalid-clip');
    expectModelError(() => withClip({ speed: 0.1 }), 'invalid-clip');
    expectModelError(() => withClip({ startFrame: 1.5 }), 'invalid-clip');
    expectModelError(() => withClip({ startFrame: -1 }), 'invalid-clip');
    expectModelError(() => withClip({ durationFrames: 0 }), 'invalid-clip');
    expectModelError(() => withClip({ trimStartFrame: -1 }), 'invalid-clip');
    expectModelError(() => withClip({ text: { content: 'nope' } }), 'invalid-clip');
  });
});

// ---------------------------------------------------------------------------
// Clone, lookups, duration
// ---------------------------------------------------------------------------

describe('cloneProject', () => {
  it('deep clones without sharing references', () => {
    const project = fixture();
    const copy = cloneProject(project);
    assert.deepEqual(copy, project);
    assert.notEqual(copy, project);
    assert.notEqual(copy.tracks, project.tracks);
    assert.notEqual(copy.tracks[0], project.tracks[0]);
    assert.notEqual(copy.tracks[0].clips, project.tracks[0].clips);
  });

  it('mutating a clone does not touch the original', () => {
    const project = fixture();
    project.tracks[0].clips.push({ id: 'ghost' });
    const copy = cloneProject(project);
    copy.tracks[0].clips[0].id = 'changed';
    assert.equal(project.tracks[0].clips[0].id, 'ghost');
  });
});

describe('findMedia / findTrack / findClip / timelineDurationFrames', () => {
  it('finds media by id', () => {
    const project = fixture();
    assert.equal(findMedia(project, 'm-video').id, 'm-video');
    assert.equal(findMedia(project, 'nope'), null);
  });

  it('finds tracks by id', () => {
    const project = fixture();
    assert.equal(findTrack(project, 't-audio').type, 'audio');
    assert.equal(findTrack(project, 'nope'), null);
  });

  it('findClip returns { track, clip }', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    const entry = findClip(project, 'c1');
    assert.equal(entry.clip.id, 'c1');
    assert.equal(entry.track.id, 't-video');
    assert.equal(findClip(project, 'nope'), null);
  });

  it('timelineDurationFrames is 0 for an empty project', () => {
    assert.equal(timelineDurationFrames(createProject()), 0);
  });

  it('timelineDurationFrames is the max end across tracks', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'v1',
      mediaId: 'm-video',
      trackId: 't-video',
      startFrame: 0,
      durationFrames: 100,
    });
    project = addClip(project, {
      clipId: 'a1',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 500,
      durationFrames: 200,
    });
    assert.equal(timelineDurationFrames(project), 700);
  });
});

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

describe('add-track / remove-track', () => {
  it('adds video and audio tracks with sensible default names', () => {
    let project = emptyProject();
    project = applyOperation(project, { type: 'add-track', trackId: 'v1', trackType: 'video' });
    project = applyOperation(project, { type: 'add-track', trackId: 'v2', trackType: 'video' });
    project = applyOperation(project, { type: 'add-track', trackId: 'a1', trackType: 'audio' });
    const names = project.tracks.map((track) => track.name);
    assert.deepEqual(names, ['Video 1', 'Video 2', 'Audio 1']);
    const track = findTrack(project, 'v1');
    assert.equal(track.muted, false);
    assert.equal(track.hidden, false);
    assert.deepEqual(track.clips, []);
  });

  it('rejects duplicate track ids', () => {
    const project = fixture();
    expectModelError(
      () => applyOperation(project, { type: 'add-track', trackId: 't-video', trackType: 'video' }),
      'duplicate-id',
    );
  });

  it('rejects invalid track types and missing ids', () => {
    const project = emptyProject();
    expectModelError(
      () => applyOperation(project, { type: 'add-track', trackId: 'x', trackType: 'subtitle' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'add-track', trackType: 'video' }),
      'invalid-input',
    );
  });

  it('remove-track drops its clips', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = applyOperation(project, { type: 'remove-track', trackId: 't-video' });
    assert.equal(findTrack(project, 't-video'), null);
    assert.equal(findClip(project, 'c1'), null);
  });

  it('remove-track rejects unknown tracks', () => {
    expectModelError(
      () => applyOperation(emptyProject(), { type: 'remove-track', trackId: 'ghost' }),
      'track-not-found',
    );
  });

  it('does not mutate the input project', () => {
    const project = fixture();
    const before = JSON.stringify(project);
    applyOperation(project, { type: 'add-track', trackId: 'extra', trackType: 'video' });
    assert.equal(JSON.stringify(project), before);
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

describe('add-media / remove-media', () => {
  it('adds media with defaults', () => {
    let project = emptyProject();
    project = applyOperation(project, {
      type: 'add-media',
      media: { id: 'm1', kind: 'video', fileName: 'm1.mp4', durationFrames: 90 },
    });
    const added = findMedia(project, 'm1');
    assert.equal(added.name, 'm1.mp4');
    assert.equal(added.sourceDurationSeconds, null);
    assert.equal(added.hasAudio, false);
    assert.equal(added.sizeBytes, 0);
  });

  it('rejects duplicate ids and malformed media', () => {
    const project = fixture();
    expectModelError(
      () => applyOperation(project, { type: 'add-media', media: media({ id: 'm-video' }) }),
      'duplicate-id',
    );
    expectModelError(
      () => applyOperation(project, { type: 'add-media', media: { id: 'x', kind: 'video' } }),
      'invalid-media',
    );
    expectModelError(() => applyOperation(project, { type: 'add-media' }), 'invalid-input');
  });

  it('remove-media cascades to every referencing clip', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'v1',
      mediaId: 'm-video',
      trackId: 't-video',
      startFrame: 0,
      durationFrames: 50,
    });
    project = addClip(project, {
      clipId: 'v2',
      mediaId: 'm-video',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 50,
    });
    project = addClip(project, {
      clipId: 'a1',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 0,
      durationFrames: 50,
    });
    project = applyOperation(project, { type: 'remove-media', mediaId: 'm-video' });
    assert.equal(findMedia(project, 'm-video'), null);
    assert.equal(findClip(project, 'v1'), null);
    assert.equal(findClip(project, 'v2'), null);
    assert.ok(findClip(project, 'a1'));
    assert.ok(findMedia(project, 'm-audio'));
  });

  it('remove-media rejects unknown media', () => {
    expectModelError(
      () => applyOperation(fixture(), { type: 'remove-media', mediaId: 'ghost' }),
      'media-not-found',
    );
  });
});

// ---------------------------------------------------------------------------
// add-clip
// ---------------------------------------------------------------------------

describe('add-clip', () => {
  it('adds a video clip with defaults (duration = remaining media)', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0 });
    const clip = clipById(project, 'c1');
    assert.equal(clip.type, 'video');
    assert.equal(clip.mediaId, 'm-video');
    assert.equal(clip.startFrame, 0);
    assert.equal(clip.durationFrames, 300);
    assert.equal(clip.trimStartFrame, 0);
    assert.equal(clip.speed, 1);
    assert.equal(clip.volume, 1);
    assert.equal(clip.opacity, 1);
    assert.deepEqual(clip.transform, DEFAULT_TRANSFORM);
    assert.equal(clip.text, null);
  });

  it('honours explicit duration and trimStartFrame', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'c1',
      startFrame: 10,
      durationFrames: 100,
      trimStartFrame: 50,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.startFrame, 10);
    assert.equal(clip.durationFrames, 100);
    assert.equal(clip.trimStartFrame, 50);
  });

  it('defaults duration to the remaining source after trimStartFrame', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, trimStartFrame: 100 });
    assert.equal(clipById(project, 'c1').durationFrames, 200);
  });

  it('uses a 5 second default for images and never bounds them', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'img1',
      mediaId: 'm-image',
      startFrame: 0,
    });
    assert.equal(clipById(project, 'img1').type, 'image');
    assert.equal(clipById(project, 'img1').durationFrames, 150);
    assert.equal(clipById(project, 'img1').trimStartFrame, 0);

    project = addClip(project, {
      clipId: 'img2',
      mediaId: 'm-image',
      startFrame: 200,
      durationFrames: 5000,
      trimStartFrame: 1234,
    });
    assert.equal(clipById(project, 'img2').durationFrames, 5000);
  });

  it('adds audio clips to audio tracks', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'a1',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 0,
    });
    assert.equal(clipById(project, 'a1').type, 'audio');
    assert.equal(clipById(project, 'a1').durationFrames, 600);
  });

  it('enforces track type compatibility', () => {
    const project = fixture();
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-clip',
          clipId: 'bad',
          mediaId: 'm-audio',
          trackId: 't-video',
          startFrame: 0,
        }),
      'incompatible-track-type',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-clip',
          clipId: 'bad',
          mediaId: 'm-video',
          trackId: 't-audio',
          startFrame: 0,
        }),
      'incompatible-track-type',
    );
  });

  it('rejects unknown media and tracks', () => {
    const project = fixture();
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-clip',
          clipId: 'c1',
          mediaId: 'ghost',
          trackId: 't-video',
          startFrame: 0,
        }),
      'media-not-found',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-clip',
          clipId: 'c1',
          mediaId: 'm-video',
          trackId: 'ghost',
          startFrame: 0,
        }),
      'track-not-found',
    );
  });

  it('rejects duplicate clip ids', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 100, durationFrames: 50 }),
      'duplicate-id',
    );
  });

  it('enforces media source bounds', () => {
    const project = fixture();
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 301 }),
      'out-of-bounds',
    );
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 0, trimStartFrame: 300 }),
      'out-of-bounds',
    );
    expectModelError(
      () =>
        addClip(project, {
          clipId: 'c1',
          startFrame: 0,
          trimStartFrame: 250,
          durationFrames: 100,
        }),
      'out-of-bounds',
    );
    // Exact bound is allowed.
    assert.doesNotThrow(() =>
      addClip(project, { clipId: 'c1', startFrame: 0, trimStartFrame: 200, durationFrames: 100 }),
    );
    // trimStart just below the media end leaves one frame.
    assert.doesNotThrow(() =>
      addClip(project, { clipId: 'c2', startFrame: 0, trimStartFrame: 299 }),
    );
  });

  it('rejects negative or fractional timeline values', () => {
    const project = fixture();
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: -1, durationFrames: 10 }),
      'invalid-input',
    );
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 1.5, durationFrames: 10 }),
      'invalid-input',
    );
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 0 }),
      'invalid-input',
    );
    expectModelError(
      () => addClip(project, { clipId: 'c1', startFrame: 0, trimStartFrame: -1 }),
      'invalid-input',
    );
  });
});

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

describe('same-track overlap resolution on add-clip', () => {
  it('trims the end of an existing clip when the new clip overlaps its right side', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'c2', startFrame: 50, durationFrames: 100 });
    assert.equal(clipById(project, 'c1').startFrame, 0);
    assert.equal(clipById(project, 'c1').durationFrames, 50);
    assert.equal(clipById(project, 'c2').startFrame, 50);
    assert.equal(clipById(project, 'c2').durationFrames, 100);
  });

  it('trims and re-bases an existing clip when the new clip overlaps its left side', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 100, durationFrames: 100 });
    project = addClip(project, { clipId: 'new', startFrame: 50, durationFrames: 100 });
    const old = clipById(project, 'old');
    assert.equal(old.startFrame, 150);
    assert.equal(old.durationFrames, 50);
    assert.equal(old.trimStartFrame, 50);
    assert.equal(clipById(project, 'new').startFrame, 50);
  });

  it('removes an existing clip that the new clip fully covers', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 50, durationFrames: 50 });
    project = addClip(project, { clipId: 'new', startFrame: 0, durationFrames: 200 });
    assert.equal(findClip(project, 'old'), null);
    assert.equal(trackClips(project, 't-video').length, 1);
    assert.equal(clipById(project, 'new').durationFrames, 200);
  });

  it('removes a clip exactly covered by the new interval', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'new', startFrame: 0, durationFrames: 100 });
    assert.equal(findClip(project, 'old'), null);
    assert.equal(trackClips(project, 't-video').length, 1);
  });

  it('splits an existing clip when the new interval lives inside it', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 0, durationFrames: 100 });
    project = addClip(project, {
      clipId: 'new',
      startFrame: 40,
      durationFrames: 20,
      splitRightClipId: 'right',
    });
    assert.equal(clipById(project, 'old').startFrame, 0);
    assert.equal(clipById(project, 'old').durationFrames, 40);
    assert.equal(clipById(project, 'right').startFrame, 60);
    assert.equal(clipById(project, 'right').durationFrames, 40);
    assert.equal(clipById(project, 'right').trimStartFrame, 60);
    assert.deepEqual(
      trackClips(project, 't-video').map((clip) => [clip.id, clip.startFrame, clip.durationFrames]),
      [
        ['old', 0, 40],
        ['new', 40, 20],
        ['right', 60, 40],
      ],
    );
  });

  it('requires splitRightClipId for an inside split', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 0, durationFrames: 100 });
    expectModelError(
      () => addClip(project, { clipId: 'new', startFrame: 40, durationFrames: 20 }),
      'invalid-input',
    );
  });

  it('rejects a splitRightClipId that already exists', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'old', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'other', startFrame: 200, durationFrames: 50 });
    expectModelError(
      () =>
        addClip(project, {
          clipId: 'new',
          startFrame: 40,
          durationFrames: 20,
          splitRightClipId: 'other',
        }),
      'duplicate-id',
    );
  });

  it('trims both neighbours when the new clip spans a boundary', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'left', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'right', startFrame: 100, durationFrames: 100 });
    project = addClip(project, { clipId: 'new', startFrame: 50, durationFrames: 100 });
    assert.equal(clipById(project, 'left').durationFrames, 50);
    assert.equal(clipById(project, 'right').startFrame, 150);
    assert.equal(clipById(project, 'right').trimStartFrame, 50);
    assert.equal(clipById(project, 'right').durationFrames, 50);
    assert.equal(trackClips(project, 't-video').length, 3);
  });

  it('removes middle clips and trims the ends when covering several clips', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'a', startFrame: 0, durationFrames: 50 });
    project = addClip(project, { clipId: 'b', startFrame: 50, durationFrames: 50 });
    project = addClip(project, { clipId: 'c', startFrame: 100, durationFrames: 50 });
    project = addClip(project, { clipId: 'new', startFrame: 25, durationFrames: 100 });
    assert.equal(findClip(project, 'b'), null);
    assert.equal(clipById(project, 'a').durationFrames, 25);
    assert.equal(clipById(project, 'c').startFrame, 125);
    assert.equal(clipById(project, 'c').trimStartFrame, 25);
    assert.deepEqual(
      trackClips(project, 't-video').map((clip) => clip.id),
      ['a', 'new', 'c'],
    );
  });

  it('leaves abutting clips untouched', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'a', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'b', startFrame: 100, durationFrames: 100 });
    assert.equal(clipById(project, 'a').durationFrames, 100);
    assert.equal(clipById(project, 'b').startFrame, 100);
  });

  it('keeps clips sorted by startFrame', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'late', startFrame: 200, durationFrames: 50 });
    project = addClip(project, { clipId: 'early', startFrame: 0, durationFrames: 50 });
    assert.deepEqual(
      trackClips(project, 't-video').map((clip) => clip.id),
      ['early', 'late'],
    );
  });
});

// ---------------------------------------------------------------------------
// move-clip
// ---------------------------------------------------------------------------

describe('move-clip', () => {
  function moveFixture() {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'c2', startFrame: 200, durationFrames: 100 });
    return project;
  }

  it('moves a clip within its track', () => {
    let project = moveFixture();
    project = applyOperation(project, { type: 'move-clip', clipId: 'c2', startFrame: 120 });
    assert.equal(clipById(project, 'c2').startFrame, 120);
    assert.equal(clipById(project, 'c1').durationFrames, 100);
  });

  it('moves a clip across tracks', () => {
    let project = moveFixture();
    project = applyOperation(project, {
      type: 'move-clip',
      clipId: 'c1',
      trackId: 't-video2',
      startFrame: 10,
    });
    assert.deepEqual(trackClips(project, 't-video').map((clip) => clip.id), ['c2']);
    assert.deepEqual(trackClips(project, 't-video2').map((clip) => clip.id), ['c1']);
    assert.equal(clipById(project, 'c1').startFrame, 10);
  });

  it('trims clips it lands on in the target track', () => {
    let project = moveFixture();
    project = applyOperation(project, { type: 'move-clip', clipId: 'c2', startFrame: 50 });
    assert.equal(clipById(project, 'c1').durationFrames, 50);
    assert.equal(clipById(project, 'c2').startFrame, 50);
  });

  it('splits a target clip when dropped inside it', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'long',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 200,
    });
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = applyOperation(project, {
      type: 'move-clip',
      clipId: 'c1',
      trackId: 't-video2',
      startFrame: 40,
      splitRightClipId: 'long-right',
    });
    assert.equal(clipById(project, 'long').durationFrames, 40);
    assert.equal(clipById(project, 'long-right').startFrame, 90);
    assert.equal(clipById(project, 'long-right').trimStartFrame, 90);
    assert.equal(clipById(project, 'long-right').durationFrames, 110);
    assert.equal(clipById(project, 'c1').startFrame, 40);
  });

  it('requires splitRightClipId when the drop splits a clip', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'long',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 200,
    });
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'move-clip',
          clipId: 'c1',
          trackId: 't-video2',
          startFrame: 40,
        }),
      'invalid-input',
    );
  });

  it('enforces target track compatibility', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'a1',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 0,
      durationFrames: 100,
    });
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'move-clip',
          clipId: 'a1',
          trackId: 't-video',
          startFrame: 0,
        }),
      'incompatible-track-type',
    );
  });

  it('rejects unknown clips/tracks and negative frames', () => {
    const project = moveFixture();
    expectModelError(
      () => applyOperation(project, { type: 'move-clip', clipId: 'ghost', startFrame: 0 }),
      'clip-not-found',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'move-clip',
          clipId: 'c1',
          trackId: 'ghost',
          startFrame: 0,
        }),
      'track-not-found',
    );
    expectModelError(
      () => applyOperation(project, { type: 'move-clip', clipId: 'c1', startFrame: -5 }),
      'invalid-input',
    );
  });

  it('preserves clip properties while moving', () => {
    let project = moveFixture();
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1'],
      volume: 0.4,
      opacity: 0.6,
      transform: { x: 0.25 },
    });
    project = applyOperation(project, {
      type: 'move-clip',
      clipId: 'c1',
      trackId: 't-video2',
      startFrame: 30,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.volume, 0.4);
    assert.equal(clip.opacity, 0.6);
    assert.equal(clip.transform.x, 0.25);
    assert.equal(clip.transform.y, 0);
  });
});

// ---------------------------------------------------------------------------
// trim-clip
// ---------------------------------------------------------------------------

describe('trim-clip', () => {
  function trimFixture() {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    return project;
  }

  it('shrinks duration from the right edge', () => {
    let project = trimFixture();
    project = applyOperation(project, {
      type: 'trim-clip',
      clipId: 'c1',
      durationFrames: 50,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.startFrame, 0);
    assert.equal(clip.durationFrames, 50);
    assert.equal(clip.trimStartFrame, 0);
  });

  it('grows duration when there is room', () => {
    let project = trimFixture();
    project = applyOperation(project, {
      type: 'trim-clip',
      clipId: 'c1',
      durationFrames: 250,
    });
    assert.equal(clipById(project, 'c1').durationFrames, 250);
  });

  it('rejects growing into a neighbouring clip', () => {
    let project = trimFixture();
    project = addClip(project, { clipId: 'c2', startFrame: 100, durationFrames: 50 });
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'c1', durationFrames: 150 }),
      'overlap',
    );
  });

  it('advances startFrame when trimStartFrame moves the in-point', () => {
    let project = trimFixture();
    project = applyOperation(project, {
      type: 'trim-clip',
      clipId: 'c1',
      trimStartFrame: 40,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.startFrame, 40);
    assert.equal(clip.durationFrames, 60);
    assert.equal(clip.trimStartFrame, 40);
  });

  it('sets both edges when duration and trimStartFrame are given', () => {
    let project = trimFixture();
    project = applyOperation(project, {
      type: 'trim-clip',
      clipId: 'c1',
      trimStartFrame: 40,
      durationFrames: 30,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.startFrame, 40);
    assert.equal(clip.durationFrames, 30);
    assert.equal(clip.trimStartFrame, 40);
  });

  it('enforces media source bounds', () => {
    let project = trimFixture();
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'trim-clip',
          clipId: 'c1',
          trimStartFrame: 250,
          durationFrames: 100,
        }),
      'out-of-bounds',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'trim-clip',
          clipId: 'c1',
          trimStartFrame: 250,
        }),
      'invalid-input',
    );
  });

  it('rejects invalid durations and empty operations', () => {
    const project = trimFixture();
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'c1', durationFrames: 0 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'c1', trimStartFrame: -1 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'c1' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'ghost', durationFrames: 10 }),
      'clip-not-found',
    );
  });

  it('rejects a trim that would push startFrame below 0', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'c1',
      startFrame: 10,
      durationFrames: 50,
      trimStartFrame: 20,
    });
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'c1', trimStartFrame: 0 }),
      'invalid-input',
    );
  });

  it('trims text duration but forbids a non-zero text trimStart', () => {
    let project = fixture();
    project = addText(project, { clipId: 'txt', startFrame: 0, durationFrames: 60 });
    project = applyOperation(project, { type: 'trim-clip', clipId: 'txt', durationFrames: 30 });
    assert.equal(clipById(project, 'txt').durationFrames, 30);
    expectModelError(
      () => applyOperation(project, { type: 'trim-clip', clipId: 'txt', trimStartFrame: 1 }),
      'invalid-input',
    );
  });

  it('does not bound image durations', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'img',
      mediaId: 'm-image',
      startFrame: 0,
      durationFrames: 100,
    });
    project = applyOperation(project, { type: 'trim-clip', clipId: 'img', durationFrames: 5000 });
    assert.equal(clipById(project, 'img').durationFrames, 5000);
  });
});

// ---------------------------------------------------------------------------
// split-clip
// ---------------------------------------------------------------------------

describe('split-clip', () => {
  it('splits a clip into caller-supplied halves', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'c1',
      startFrame: 0,
      durationFrames: 100,
      trimStartFrame: 10,
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'c1',
      atFrame: 40,
      leftClipId: 'L',
      rightClipId: 'R',
    });
    assert.equal(findClip(project, 'c1'), null);
    const left = clipById(project, 'L');
    const right = clipById(project, 'R');
    assert.equal(left.startFrame, 0);
    assert.equal(left.durationFrames, 40);
    assert.equal(left.trimStartFrame, 10);
    assert.equal(right.startFrame, 40);
    assert.equal(right.durationFrames, 60);
    assert.equal(right.trimStartFrame, 50);
    assert.equal(left.mediaId, 'm-video');
    assert.equal(right.mediaId, 'm-video');
    assert.deepEqual(
      trackClips(project, 't-video').map((clip) => clip.id),
      ['L', 'R'],
    );
  });

  it('preserves clip properties on both halves', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1'],
      volume: 0.25,
      opacity: 0.5,
      transform: { x: 0.2, y: 0.3, width: 0.4, height: 0.5, rotation: 15 },
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'c1',
      atFrame: 30,
      leftClipId: 'L',
      rightClipId: 'R',
    });
    for (const id of ['L', 'R']) {
      const clip = clipById(project, id);
      assert.equal(clip.volume, 0.25);
      assert.equal(clip.opacity, 0.5);
      assert.deepEqual(clip.transform, { x: 0.2, y: 0.3, width: 0.4, height: 0.5, rotation: 15 });
    }
  });

  it('accepts the original id for the left half', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'c1',
      atFrame: 50,
      leftClipId: 'c1',
      rightClipId: 'R',
    });
    assert.equal(clipById(project, 'c1').durationFrames, 50);
    assert.equal(clipById(project, 'R').startFrame, 50);
  });

  it('rejects frames on or outside the clip boundaries', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 50, durationFrames: 100 });
    const split = (atFrame) =>
      applyOperation(project, {
        type: 'split-clip',
        clipId: 'c1',
        atFrame,
        leftClipId: 'L',
        rightClipId: 'R',
      });
    expectModelError(() => split(50), 'invalid-split');
    expectModelError(() => split(150), 'invalid-split');
    expectModelError(() => split(0), 'invalid-split');
    expectModelError(() => split(60.5), 'invalid-input');
  });

  it('requires distinct, non-conflicting, supplied ids', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = addClip(project, { clipId: 'other', startFrame: 200, durationFrames: 50 });
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'split-clip',
          clipId: 'c1',
          atFrame: 30,
          rightClipId: 'R',
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'split-clip',
          clipId: 'c1',
          atFrame: 30,
          leftClipId: 'L',
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'split-clip',
          clipId: 'c1',
          atFrame: 30,
          leftClipId: 'SAME',
          rightClipId: 'SAME',
        }),
      'duplicate-id',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'split-clip',
          clipId: 'c1',
          atFrame: 30,
          leftClipId: 'other',
          rightClipId: 'R',
        }),
      'duplicate-id',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'split-clip',
          clipId: 'ghost',
          atFrame: 30,
          leftClipId: 'L',
          rightClipId: 'R',
        }),
      'clip-not-found',
    );
  });

  it('splits image clips and keeps text trimStartFrame 0', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'img',
      mediaId: 'm-image',
      startFrame: 0,
      durationFrames: 100,
    });
    project = addText(project, { clipId: 'txt', startFrame: 200, durationFrames: 60 });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'img',
      atFrame: 25,
      leftClipId: 'imgL',
      rightClipId: 'imgR',
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'txt',
      atFrame: 220,
      leftClipId: 'txtL',
      rightClipId: 'txtR',
    });
    assert.equal(clipById(project, 'imgL').durationFrames, 25);
    assert.equal(clipById(project, 'imgR').startFrame, 25);
    assert.equal(clipById(project, 'txtL').trimStartFrame, 0);
    assert.equal(clipById(project, 'txtR').trimStartFrame, 0);
    assert.equal(clipById(project, 'txtR').text.content, 'Hello');
  });
});

// ---------------------------------------------------------------------------
// remove-clips
// ---------------------------------------------------------------------------

describe('remove-clips', () => {
  function removeFixture() {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = addClip(project, { clipId: 'c2', startFrame: 100, durationFrames: 50 });
    project = addClip(project, {
      clipId: 'a1',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 0,
      durationFrames: 50,
    });
    return project;
  }

  it('removes several clips at once', () => {
    let project = removeFixture();
    project = applyOperation(project, { type: 'remove-clips', clipIds: ['c1', 'a1'] });
    assert.equal(findClip(project, 'c1'), null);
    assert.equal(findClip(project, 'a1'), null);
    assert.ok(findClip(project, 'c2'));
  });

  it('is atomic when an id is missing', () => {
    const project = removeFixture();
    const before = JSON.stringify(project);
    expectModelError(
      () => applyOperation(project, { type: 'remove-clips', clipIds: ['c1', 'ghost'] }),
      'clip-not-found',
    );
    assert.equal(JSON.stringify(project), before);
  });

  it('rejects empty or non-array clipIds', () => {
    const project = removeFixture();
    expectModelError(
      () => applyOperation(project, { type: 'remove-clips', clipIds: [] }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'remove-clips', clipIds: 'c1' }),
      'invalid-input',
    );
  });
});

// ---------------------------------------------------------------------------
// set-clip-properties
// ---------------------------------------------------------------------------

describe('set-clip-properties', () => {
  function propsFixture() {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = addClip(project, { clipId: 'c2', startFrame: 100, durationFrames: 50 });
    return project;
  }

  it('sets volume and opacity on several clips', () => {
    let project = propsFixture();
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1', 'c2'],
      volume: 0.25,
      opacity: 0.5,
    });
    for (const id of ['c1', 'c2']) {
      assert.equal(clipById(project, id).volume, 0.25);
      assert.equal(clipById(project, id).opacity, 0.5);
    }
  });

  it('merges partial transforms', () => {
    let project = propsFixture();
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1'],
      transform: { x: 0.2 },
    });
    assert.deepEqual(clipById(project, 'c1').transform, {
      x: 0.2,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
    });
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1'],
      transform: { rotation: 45, width: 0.5 },
    });
    assert.deepEqual(clipById(project, 'c1').transform, {
      x: 0.2,
      y: 0,
      width: 0.5,
      height: 1,
      rotation: 45,
    });
  });

  it('rejects out-of-range and unknown property values', () => {
    const project = propsFixture();
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'set-clip-properties',
          clipIds: ['c1'],
          volume: 1.5,
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'set-clip-properties',
          clipIds: ['c1'],
          transform: { y: -0.1 },
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'set-clip-properties',
          clipIds: ['c1'],
          transform: { scale: 2 },
        }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-clip-properties', clipIds: ['ghost'], volume: 1 }),
      'clip-not-found',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-clip-properties', clipIds: [] }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-clip-properties', clipIds: ['c1'] }),
      'invalid-input',
    );
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe('add-text / update-text', () => {
  it('auto-creates a video track when none exists', () => {
    const project = addText(emptyProject(), {
      clipId: 'text1',
      startFrame: 0,
      durationFrames: 60,
    });
    assert.equal(project.tracks.length, 1);
    const track = findTrack(project, 'text-track-text1');
    assert.ok(track);
    assert.equal(track.type, 'video');
    const clip = clipById(project, 'text1');
    assert.equal(clip.type, 'text');
    assert.equal(clip.mediaId, null);
    assert.equal(clip.trimStartFrame, 0);
    assert.equal(clip.startFrame, 0);
    assert.equal(clip.durationFrames, 60);
    assert.deepEqual(clip.transform, TEXT_TRANSFORM);
    assert.equal(clip.text.content, 'Hello');
    assert.equal(clip.text.fontSize, 48);
    assert.equal(clip.text.color, '#ffffff');
    assert.equal(clip.text.fontWeight, '600');
    assert.equal(clip.text.align, 'center');
  });

  it('reuses a free video track instead of creating one', () => {
    const project = addText(fixture(), { clipId: 'text1', startFrame: 0, durationFrames: 60 });
    assert.equal(project.tracks.length, 3);
    assert.equal(findClip(project, 'text1').track.id, 't-video');
  });

  it('skips a busy video track in favour of a free one', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    project = addText(project, { clipId: 'text1', startFrame: 0, durationFrames: 60 });
    assert.equal(findClip(project, 'text1').track.id, 't-video2');
  });

  it('creates a fresh track when every video track is busy', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'v1', startFrame: 0, durationFrames: 100 });
    project = addClip(project, {
      clipId: 'v2',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 100,
    });
    project = addText(project, { clipId: 'text1', startFrame: 0, durationFrames: 60 });
    assert.equal(findClip(project, 'text1').track.id, 'text-track-text1');
    assert.equal(project.tracks.length, 4);
  });

  it('honours an explicit video track and merges a partial transform', () => {
    const project = addText(fixture(), {
      clipId: 'text1',
      trackId: 't-video2',
      startFrame: 10,
      durationFrames: 60,
      transform: { x: 0.3 },
    });
    assert.equal(findClip(project, 'text1').track.id, 't-video2');
    assert.deepEqual(clipById(project, 'text1').transform, {
      x: 0.3,
      y: 0.1,
      width: 0.8,
      height: 0.2,
      rotation: 0,
    });
  });

  it('accepts a plain text string as shorthand', () => {
    const project = addText(fixture(), { clipId: 'text1', text: 'Title' });
    assert.equal(clipById(project, 'text1').text.content, 'Title');
  });

  it('rejects audio tracks, missing tracks and duplicate ids', () => {
    const project = fixture();
    expectModelError(
      () => addText(project, { clipId: 'text1', trackId: 't-audio' }),
      'incompatible-track-type',
    );
    expectModelError(
      () => addText(project, { clipId: 'text1', trackId: 'ghost' }),
      'track-not-found',
    );
    let withClip = addClip(project, { clipId: 'text1', startFrame: 0, durationFrames: 50 });
    expectModelError(() => addText(withClip, { clipId: 'text1' }), 'duplicate-id');
  });

  it('can overwrite an explicit track (split needs splitRightClipId)', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    expectModelError(
      () =>
        addText(project, {
          clipId: 'text1',
          trackId: 't-video',
          startFrame: 40,
          durationFrames: 20,
        }),
      'invalid-input',
    );
    project = addText(project, {
      clipId: 'text2',
      trackId: 't-video',
      startFrame: 40,
      durationFrames: 20,
      splitRightClipId: 'c1-right',
    });
    assert.equal(clipById(project, 'c1').durationFrames, 40);
    assert.equal(clipById(project, 'c1-right').startFrame, 60);
    assert.equal(clipById(project, 'c1-right').trimStartFrame, 60);
    assert.equal(findClip(project, 'text2').track.id, 't-video');
  });

  it('updates text fields partially', () => {
    let project = fixture();
    project = addText(project, { clipId: 'text1', startFrame: 0, durationFrames: 60 });
    project = applyOperation(project, {
      type: 'update-text',
      clipId: 'text1',
      content: 'New title',
      fontSize: 72,
      color: '#ff0000',
      fontWeight: '700',
      align: 'left',
    });
    const text = clipById(project, 'text1').text;
    assert.deepEqual(text, {
      content: 'New title',
      fontSize: 72,
      color: '#ff0000',
      fontWeight: '700',
      align: 'left',
    });
    project = applyOperation(project, {
      type: 'update-text',
      clipId: 'text1',
      content: 'Only content',
    });
    assert.equal(clipById(project, 'text1').text.content, 'Only content');
    assert.equal(clipById(project, 'text1').text.fontSize, 72);
  });

  it('rejects invalid text updates', () => {
    let project = fixture();
    project = addText(project, { clipId: 'text1', startFrame: 0, durationFrames: 60 });
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    expectModelError(
      () => applyOperation(project, { type: 'update-text', clipId: 'c1', content: 'x' }),
      'not-text-clip',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-text', clipId: 'ghost', content: 'x' }),
      'clip-not-found',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-text', clipId: 'text1' }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, { type: 'update-text', clipId: 'text1', fontWeight: '900' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-text', clipId: 'text1', fontSize: 0 }),
      'invalid-input',
    );
  });
});

// ---------------------------------------------------------------------------
// reorder-tracks
// ---------------------------------------------------------------------------

describe('reorder-tracks', () => {
  it('moves a track to the requested index', () => {
    let project = fixture();
    project = applyOperation(project, { type: 'reorder-tracks', trackId: 't-audio', toIndex: 0 });
    assert.deepEqual(
      project.tracks.map((track) => track.id),
      ['t-audio', 't-video', 't-video2'],
    );
    project = applyOperation(project, { type: 'reorder-tracks', trackId: 't-audio', toIndex: 2 });
    assert.deepEqual(
      project.tracks.map((track) => track.id),
      ['t-video', 't-video2', 't-audio'],
    );
  });

  it('allows a no-op move', () => {
    const project = fixture();
    const moved = applyOperation(project, {
      type: 'reorder-tracks',
      trackId: 't-video',
      toIndex: 0,
    });
    assert.deepEqual(
      moved.tracks.map((track) => track.id),
      ['t-video', 't-video2', 't-audio'],
    );
  });

  it('rejects invalid indices and missing tracks', () => {
    const project = fixture();
    expectModelError(
      () => applyOperation(project, { type: 'reorder-tracks', trackId: 't-video', toIndex: -1 }),
      'index-out-of-range',
    );
    expectModelError(
      () => applyOperation(project, { type: 'reorder-tracks', trackId: 't-video', toIndex: 3 }),
      'index-out-of-range',
    );
    expectModelError(
      () => applyOperation(project, { type: 'reorder-tracks', trackId: 't-video', toIndex: 1.5 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'reorder-tracks', trackId: 'ghost', toIndex: 0 }),
      'track-not-found',
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid operations / purity
// ---------------------------------------------------------------------------

describe('invalid operations', () => {
  it('rejects unknown and malformed operations', () => {
    const project = fixture();
    expectModelError(
      () => applyOperation(project, { type: 'explode' }),
      'unknown-operation',
    );
    expectModelError(() => applyOperation(project, null), 'invalid-operation');
    expectModelError(() => applyOperation(project, {}), 'invalid-operation');
    expectModelError(() => applyOperation(project, { type: 42 }), 'invalid-operation');
    expectModelError(() => applyOperation(null, { type: 'add-track' }), 'invalid-project');
  });

  it('throws ModelError instances with stable codes', () => {
    const project = fixture();
    try {
      applyOperation(project, { type: 'add-track', trackId: 't-video', trackType: 'video' });
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof ModelError);
      assert.equal(error.name, 'ModelError');
      assert.equal(error.code, 'duplicate-id');
      assert.equal(typeof error.message, 'string');
    }
  });

  it('keeps the input project untouched when an operation fails', () => {
    const project = fixture();
    const before = JSON.stringify(project);
    expectModelError(
      () => applyOperation(project, { type: 'add-clip', clipId: 'x', mediaId: 'ghost' }),
      'media-not-found',
    );
    assert.equal(JSON.stringify(project), before);
  });
});

describe('purity and determinism', () => {
  it('returns a new project without sharing structure with the input', () => {
    const project = fixture();
    const next = applyOperation(project, { type: 'add-track', trackId: 'extra', trackType: 'video' });
    assert.notEqual(next, project);
    assert.notEqual(next.tracks, project.tracks);
    assert.equal(project.tracks.length, 3);
    assert.equal(next.tracks.length, 4);
  });

  it('does not mutate the input or the operation object', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 100 });
    const before = JSON.stringify(project);
    const operation = { type: 'trim-clip', clipId: 'c1', durationFrames: 40 };
    const operationBefore = JSON.stringify(operation);
    const next = applyOperation(project, operation);
    assert.equal(JSON.stringify(project), before);
    assert.equal(JSON.stringify(operation), operationBefore);
    assert.equal(clipById(next, 'c1').durationFrames, 40);
  });

  it('two identical operations on the same project produce the same result', () => {
    const project = fixture();
    const operation = { type: 'add-track', trackId: 'extra', trackType: 'video' };
    const first = applyOperation(project, operation);
    const second = applyOperation(project, operation);
    assert.deepEqual(first, second);
  });

  it('stamps updatedAt with Date.now()', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 5_000 });
    const project = fixture();
    const next = applyOperation(project, { type: 'add-track', trackId: 'extra', trackType: 'video' });
    assert.equal(next.updatedAt, 5_000);
    assert.equal(next.createdAt, 5_000);
    t.mock.timers.reset();
  });
});

// ===========================================================================
// Phase 1 (DESIGN §11): speed, keyframes, fades, effects, markers,
// transitions, captions.
// ===========================================================================

function phase1Fixture() {
  return addClip(fixture(), { clipId: 'c1', startFrame: 0, durationFrames: 100 });
}

function adjacentFixture() {
  let project = fixture();
  project = addClip(project, { clipId: 'a', startFrame: 0, durationFrames: 100 });
  project = addClip(project, { clipId: 'b', startFrame: 100, durationFrames: 100 });
  return project;
}

function addCaption(project, options = {}) {
  const durationFrames = options.durationFrames ?? 60;
  const operation = {
    type: 'add-caption',
    clipId: options.clipId,
    startFrame: options.startFrame ?? 0,
    durationFrames,
    segments:
      options.segments ??
      [{ startFrame: 0, durationFrames, text: 'Hello' }],
  };
  if (options.trackId !== undefined) operation.trackId = options.trackId;
  if (options.style !== undefined) operation.style = options.style;
  if (options.splitRightClipId !== undefined) operation.splitRightClipId = options.splitRightClipId;
  return applyOperation(project, operation);
}

describe('phase 1 defaults and migration', () => {
  it('createProject starts with empty markers and transitions', () => {
    const project = createProject();
    assert.deepEqual(project.markers, []);
    assert.deepEqual(project.transitions, []);
  });

  it('clips start with phase 1 defaults', () => {
    const clip = clipById(phase1Fixture(), 'c1');
    assert.equal(clip.speed, 1);
    assert.equal(clip.fadeInFrames, 0);
    assert.equal(clip.fadeOutFrames, 0);
    assert.deepEqual(clip.keyframes, {});
    assert.deepEqual(clip.effects, []);
    assert.equal(clip.caption, null);
  });

  it('migrates pre-phase-1 projects and normalizes idempotently', () => {
    const raw = rawProject();
    const project = normalizeProject(raw);
    assert.deepEqual(project.markers, []);
    assert.deepEqual(project.transitions, []);
    const clip = project.tracks[0].clips[0];
    assert.equal(clip.speed, 1);
    assert.equal(clip.fadeInFrames, 0);
    assert.equal(clip.fadeOutFrames, 0);
    assert.deepEqual(clip.keyframes, {});
    assert.deepEqual(clip.effects, []);
    assert.equal(clip.caption, null);
    assert.deepEqual(normalizeProject(project), project);
  });

  it('clamps stale fades and sorts/dedupes keyframes on normalize', () => {
    const raw = mutatedRaw((value) => {
      const clip = value.tracks[0].clips[0];
      clip.fadeInFrames = 500;
      clip.fadeOutFrames = 500;
      clip.keyframes = {
        volume: [
          { frame: 40, value: 0.2 },
          { frame: 10, value: 1 },
          { frame: 10, value: 0.5 },
        ],
      };
    });
    const clip = normalizeProject(raw).tracks[0].clips.find((item) => item.id === 'c2');
    assert.equal(clip.fadeInFrames, 50);
    assert.equal(clip.fadeOutFrames, 50);
    assert.deepEqual(clip.keyframes.volume, [
      { frame: 10, value: 0.5, easing: 'linear' },
      { frame: 40, value: 0.2, easing: 'linear' },
    ]);
  });

  it('rejects invalid phase 1 clip fields on normalize', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].speed = 5;
          }),
        ),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].fadeInFrames = -1;
          }),
        ),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].keyframes = { volume: [{ frame: 60, value: 1 }] };
          }),
        ),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].effects = [
              { id: 'e1', type: 'brightness' },
              { id: 'e1', type: 'blur' },
            ];
          }),
        ),
      'duplicate-id',
    );
    expectModelError(
      () =>
        normalizeProject({
          tracks: [
            {
              id: 't',
              type: 'video',
              clips: [{ id: 'c', type: 'caption', mediaId: null, startFrame: 0, durationFrames: 30 }],
            },
          ],
        }),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject({
          media: [{ id: 'i', kind: 'image', fileName: 'i.png' }],
          tracks: [
            {
              id: 't',
              type: 'video',
              clips: [
                { id: 'ic', type: 'image', mediaId: 'i', startFrame: 0, durationFrames: 30, speed: 2 },
              ],
            },
          ],
        }),
      'invalid-clip',
    );
  });
});

describe('set-speed', () => {
  it('keeps the source range by rescaling durationFrames', () => {
    let project = phase1Fixture();
    project = applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 2 });
    let clip = clipById(project, 'c1');
    assert.equal(clip.speed, 2);
    assert.equal(clip.durationFrames, 50);
    project = applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 0.5 });
    clip = clipById(project, 'c1');
    assert.equal(clip.speed, 0.5);
    assert.equal(clip.durationFrames, 200);
  });

  it('maps timeline frames to source frames through speed', () => {
    let project = phase1Fixture();
    project = applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 2 });
    project = applyOperation(project, { type: 'move-clip', clipId: 'c1', startFrame: 20 });
    const clip = clipById(project, 'c1');
    assert.equal(sourceFrameForTimeline(clip, 20), 0);
    assert.equal(sourceFrameForTimeline(clip, 30), 20);
    assert.equal(sourceFrameForTimeline(clip, 45), 50);
    expectModelError(() => sourceFrameForTimeline(clip, Number.NaN), 'invalid-input');
    expectModelError(() => sourceFrameForTimeline(null, 1), 'invalid-input');
  });

  it('scales keyframes with the new duration', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'opacity',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 50, value: 0 },
      ],
    });
    project = applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 2 });
    const clip = clipById(project, 'c1');
    assert.equal(clip.durationFrames, 50);
    assert.deepEqual(clip.keyframes.opacity.map((keyframe) => keyframe.frame), [0, 25]);
  });

  it('clamps fades when the clip gets shorter', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-fades',
      clipId: 'c1',
      fadeInFrames: 40,
      fadeOutFrames: 80,
    });
    project = applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 4 });
    const clip = clipById(project, 'c1');
    assert.equal(clip.durationFrames, 25);
    assert.equal(clip.fadeInFrames, 25);
    assert.equal(clip.fadeOutFrames, 25);
  });

  it('rejects speed changes that exceed media source bounds', () => {
    let project = emptyProject();
    project = applyOperation(project, {
      type: 'add-media',
      media: media({ id: 'ms', durationFrames: 6 }),
    });
    project = applyOperation(project, { type: 'add-track', trackId: 'tv', trackType: 'video' });
    project = addClip(project, {
      clipId: 'short',
      mediaId: 'ms',
      trackId: 'tv',
      startFrame: 0,
      trimStartFrame: 3,
      durationFrames: 3,
    });
    expectModelError(
      () => applyOperation(project, { type: 'set-speed', clipId: 'short', speed: 2 }),
      'out-of-bounds',
    );
  });

  it('rejects image/text/caption clips, bad speeds and unknown clips', () => {
    let project = phase1Fixture();
    project = addClip(project, {
      clipId: 'img',
      mediaId: 'm-image',
      startFrame: 200,
      durationFrames: 50,
    });
    project = addText(project, { clipId: 'txt', startFrame: 300, durationFrames: 30 });
    project = addCaption(project, { clipId: 'cap', startFrame: 400, durationFrames: 30 });
    for (const clipId of ['img', 'txt', 'cap']) {
      expectModelError(
        () => applyOperation(project, { type: 'set-speed', clipId, speed: 2 }),
        'invalid-input',
      );
    }
    expectModelError(
      () => applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 0.1 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-speed', clipId: 'c1', speed: 5 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-speed', clipId: 'c1' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-speed', clipId: 'ghost', speed: 2 }),
      'clip-not-found',
    );
  });
});

describe('keyframes', () => {
  it('set-keyframes replaces, sorts, defaults easing and drops duplicates', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'volume',
      keyframes: [
        { frame: 50, value: 0.2 },
        { frame: 0, value: 1 },
      ],
    });
    let clip = clipById(project, 'c1');
    assert.deepEqual(clip.keyframes.volume, [
      { frame: 0, value: 1, easing: 'linear' },
      { frame: 50, value: 0.2, easing: 'linear' },
    ]);
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'volume',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 0, value: 0.5 },
      ],
    });
    clip = clipById(project, 'c1');
    assert.deepEqual(clip.keyframes.volume, [{ frame: 0, value: 0.5, easing: 'linear' }]);
  });

  it('an empty array clears one property', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'opacity',
      keyframes: [{ frame: 0, value: 0.5 }],
    });
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'opacity',
      keyframes: [],
    });
    assert.deepEqual(clipById(project, 'c1').keyframes, {});
  });

  it('set-clip-properties only changes static values, never keyframes', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'volume',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 100, value: 0 },
      ],
    });
    project = applyOperation(project, {
      type: 'set-clip-properties',
      clipIds: ['c1'],
      volume: 0.4,
    });
    const clip = clipById(project, 'c1');
    assert.equal(clip.volume, 0.4);
    assert.equal(clip.keyframes.volume.length, 2);
  });

  it('evaluateKeyframes interpolates linearly and clamps endpoints', () => {
    const list = [
      { frame: 10, value: 0 },
      { frame: 90, value: 1 },
    ];
    assert.equal(evaluateKeyframes(list, 10, 9), 0);
    assert.equal(evaluateKeyframes(list, 50, 9), 0.5);
    assert.equal(evaluateKeyframes(list, 90, 9), 1);
    assert.equal(evaluateKeyframes(list, 0, 9), 0);
    assert.equal(evaluateKeyframes(list, 200, 9), 1);
    assert.equal(evaluateKeyframes([], 5, 0.7), 0.7);
    assert.equal(evaluateKeyframes(undefined, 5, 0.7), 0.7);
    assert.equal(evaluateKeyframes([{ frame: 10, value: 0.3 }], 0, 9), 0.3);
    assert.equal(evaluateKeyframes(list, Number.NaN, 9), 9);
  });

  it('evaluateKeyframes applies the left keyframe easing', () => {
    const easeIn = evaluateKeyframes(
      [
        { frame: 0, value: 0, easing: 'ease-in' },
        { frame: 100, value: 1, easing: 'linear' },
      ],
      50,
      0,
    );
    const easeOut = evaluateKeyframes(
      [
        { frame: 0, value: 0, easing: 'ease-out' },
        { frame: 100, value: 1, easing: 'linear' },
      ],
      50,
      0,
    );
    const easeInOut = evaluateKeyframes(
      [
        { frame: 0, value: 0, easing: 'ease-in-out' },
        { frame: 100, value: 1, easing: 'linear' },
      ],
      50,
      0,
    );
    assert.equal(easeIn, 0.25);
    assert.equal(easeOut, 0.75);
    assert.equal(easeInOut, 0.5);
  });

  it('rejects invalid set-keyframes input', () => {
    const project = phase1Fixture();
    const set = (property, keyframes) =>
      applyOperation(project, { type: 'set-keyframes', clipId: 'c1', property, keyframes });
    expectModelError(() => set('color', []), 'invalid-input');
    expectModelError(() => set('volume', 'nope'), 'invalid-keyframe');
    expectModelError(() => set('volume', [{ frame: 101, value: 1 }]), 'invalid-keyframe');
    expectModelError(() => set('volume', [{ frame: 0, value: 2 }]), 'invalid-keyframe');
    expectModelError(() => set('volume', [{ frame: 0, value: 1, easing: 'bounce' }]), 'invalid-keyframe');
    expectModelError(() => set('rotation', [{ frame: 0, value: Number.NaN }]), 'invalid-keyframe');
    expectModelError(
      () => applyOperation(project, { type: 'set-keyframes', clipId: 'ghost', property: 'volume', keyframes: [] }),
      'clip-not-found',
    );
  });

  it('split partitions keyframes with a continuous boundary value', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'volume',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 100, value: 0 },
      ],
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'c1',
      atFrame: 40,
      leftClipId: 'L',
      rightClipId: 'R',
    });
    const left = clipById(project, 'L');
    const right = clipById(project, 'R');
    assert.deepEqual(left.keyframes.volume.map((keyframe) => keyframe.frame), [0, 40]);
    assert.deepEqual(right.keyframes.volume.map((keyframe) => keyframe.frame), [0, 60]);
    assert.ok(Math.abs(left.keyframes.volume[1].value - 0.6) < 1e-12);
    assert.ok(Math.abs(right.keyframes.volume[0].value - 0.6) < 1e-12);
    assert.ok(Math.abs(evaluateKeyframes(left.keyframes.volume, 20, 0) - 0.8) < 1e-12);
    assert.ok(Math.abs(evaluateKeyframes(right.keyframes.volume, 30, 0) - 0.3) < 1e-12);
  });

  it('trim shifts head keyframes and truncates tail keyframes', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'k', startFrame: 0, durationFrames: 200 });
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'k',
      property: 'opacity',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 100, value: 0 },
      ],
    });
    let trimmed = applyOperation(project, { type: 'trim-clip', clipId: 'k', trimStartFrame: 20 });
    let clip = clipById(trimmed, 'k');
    assert.equal(clip.startFrame, 20);
    assert.equal(clip.durationFrames, 180);
    assert.deepEqual(clip.keyframes.opacity.map((keyframe) => keyframe.frame), [0, 80]);
    assert.ok(Math.abs(clip.keyframes.opacity[0].value - 0.8) < 1e-12);

    trimmed = applyOperation(project, { type: 'trim-clip', clipId: 'k', durationFrames: 100 });
    clip = clipById(trimmed, 'k');
    assert.equal(clip.durationFrames, 100);
    // frame == durationFrames is a valid end-of-clip keyframe (``[0, duration]``).
    assert.deepEqual(clip.keyframes.opacity.map((keyframe) => keyframe.frame), [0, 100]);
    trimmed = applyOperation(project, { type: 'trim-clip', clipId: 'k', durationFrames: 80 });
    clip = clipById(trimmed, 'k');
    assert.deepEqual(clip.keyframes.opacity.map((keyframe) => keyframe.frame), [0]);
  });

  it('overlap trimming truncates a neighbour keyframes', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'a', startFrame: 0, durationFrames: 100 });
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'a',
      property: 'volume',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 100, value: 0 },
      ],
    });
    project = addClip(project, { clipId: 'b', startFrame: 50, durationFrames: 50 });
    const clip = clipById(project, 'a');
    assert.equal(clip.durationFrames, 50);
    assert.deepEqual(clip.keyframes.volume.map((keyframe) => keyframe.frame), [0]);
  });
});

describe('set-fades', () => {
  it('sets both fades and updates one at a time', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-fades',
      clipId: 'c1',
      fadeInFrames: 10,
      fadeOutFrames: 20,
    });
    let clip = clipById(project, 'c1');
    assert.equal(clip.fadeInFrames, 10);
    assert.equal(clip.fadeOutFrames, 20);
    project = applyOperation(project, { type: 'set-fades', clipId: 'c1', fadeInFrames: 5 });
    clip = clipById(project, 'c1');
    assert.equal(clip.fadeInFrames, 5);
    assert.equal(clip.fadeOutFrames, 20);
  });

  it('rejects out-of-range or malformed fades', () => {
    const project = phase1Fixture();
    expectModelError(
      () => applyOperation(project, { type: 'set-fades', clipId: 'c1', fadeInFrames: 101 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-fades', clipId: 'c1', fadeOutFrames: -1 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-fades', clipId: 'c1', fadeInFrames: 1.5 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-fades', clipId: 'c1' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'set-fades', clipId: 'ghost', fadeInFrames: 1 }),
      'clip-not-found',
    );
  });

  it('trims clamp fades and split moves them to the outer edges', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-fades',
      clipId: 'c1',
      fadeInFrames: 10,
      fadeOutFrames: 80,
    });
    project = applyOperation(project, { type: 'trim-clip', clipId: 'c1', durationFrames: 50 });
    assert.equal(clipById(project, 'c1').fadeOutFrames, 50);

    project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-fades',
      clipId: 'c1',
      fadeInFrames: 10,
      fadeOutFrames: 20,
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'c1',
      atFrame: 40,
      leftClipId: 'L',
      rightClipId: 'R',
    });
    const left = clipById(project, 'L');
    const right = clipById(project, 'R');
    assert.equal(left.fadeInFrames, 10);
    assert.equal(left.fadeOutFrames, 0);
    assert.equal(right.fadeInFrames, 0);
    assert.equal(right.fadeOutFrames, 20);
  });
});

describe('effects', () => {
  const defaultParams = {
    brightness: { amount: 1 },
    contrast: { amount: 1 },
    saturation: { amount: 1 },
    temperature: { amount: 0 },
    blur: { radius: 0 },
    sharpen: { amount: 0 },
    chromaKey: { keyColor: '#00ff00', similarity: 0.1, blend: 0.1 },
    lut: { file: 'film.cube' },
  };

  it('adds every effect type with DESIGN defaults and enabled true', () => {
    let project = phase1Fixture();
    for (const type of Object.keys(defaultParams)) {
      const effect = { id: `e-${type}`, type };
      if (type === 'lut') effect.params = { file: 'film.cube' };
      project = applyOperation(project, { type: 'add-effect', clipId: 'c1', effect });
    }
    const effects = clipById(project, 'c1').effects;
    assert.deepEqual(
      effects.map((effect) => effect.id),
      Object.keys(defaultParams).map((type) => `e-${type}`),
    );
    for (const effect of effects) {
      assert.equal(effect.enabled, true);
      assert.deepEqual(effect.params, defaultParams[effect.type]);
    }
  });

  it('rejects invalid effect definitions', () => {
    const project = phase1Fixture();
    const add = (effect) => applyOperation(project, { type: 'add-effect', clipId: 'c1', effect });
    expectModelError(() => add({ id: 'x', type: 'glow' }), 'invalid-effect');
    expectModelError(
      () => add({ id: 'x', type: 'brightness', params: { amount: 3 } }),
      'invalid-effect',
    );
    expectModelError(
      () => add({ id: 'x', type: 'temperature', params: { amount: 2 } }),
      'invalid-effect',
    );
    expectModelError(() => add({ id: 'x', type: 'blur', params: { radius: -1 } }), 'invalid-effect');
    expectModelError(
      () => add({ id: 'x', type: 'chromaKey', params: { keyColor: 'green' } }),
      'invalid-effect',
    );
    expectModelError(
      () => add({ id: 'x', type: 'chromaKey', params: { similarity: 0.9 } }),
      'invalid-effect',
    );
    expectModelError(() => add({ id: 'x', type: 'lut' }), 'invalid-effect');
    expectModelError(() => add({ id: 'x', type: 'lut', params: { file: '/tmp/a.cube' } }), 'invalid-effect');
    expectModelError(() => add({ id: 'x', type: 'lut', params: { file: '../a.cube' } }), 'invalid-effect');
    expectModelError(() => add({ id: 'x', type: 'lut', params: { file: 'a.txt' } }), 'invalid-effect');
    expectModelError(() => add({ id: 'x', type: 'brightness', enabled: 'yes' }), 'invalid-effect');
    expectModelError(
      () => applyOperation(project, { type: 'add-effect', clipId: 'ghost', effect: { id: 'x', type: 'blur' } }),
      'clip-not-found',
    );
    expectModelError(() => applyOperation(project, { type: 'add-effect', clipId: 'c1' }), 'invalid-input');
  });

  it('rejects duplicate effect ids on one clip', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'add-effect',
      clipId: 'c1',
      effect: { id: 'e1', type: 'brightness' },
    });
    expectModelError(
      () => applyOperation(project, { type: 'add-effect', clipId: 'c1', effect: { id: 'e1', type: 'blur' } }),
      'duplicate-id',
    );
  });

  it('updates effect params, enabled and type via patch', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'add-effect',
      clipId: 'c1',
      effect: { id: 'e1', type: 'brightness', params: { amount: 1.5 } },
    });
    project = applyOperation(project, {
      type: 'update-effect',
      clipId: 'c1',
      effectId: 'e1',
      patch: { enabled: false, params: { amount: 0.5 } },
    });
    let effect = clipById(project, 'c1').effects[0];
    assert.equal(effect.enabled, false);
    assert.deepEqual(effect.params, { amount: 0.5 });

    project = applyOperation(project, {
      type: 'update-effect',
      clipId: 'c1',
      effectId: 'e1',
      patch: { type: 'blur' },
    });
    effect = clipById(project, 'c1').effects[0];
    assert.equal(effect.type, 'blur');
    assert.deepEqual(effect.params, { radius: 0 });

    project = applyOperation(project, {
      type: 'update-effect',
      clipId: 'c1',
      effectId: 'e1',
      patch: { enabled: true, params: { radius: 3 } },
    });
    effect = clipById(project, 'c1').effects[0];
    assert.equal(effect.enabled, true);
    assert.deepEqual(effect.params, { radius: 3 });
  });

  it('rejects invalid effect updates', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'add-effect',
      clipId: 'c1',
      effect: { id: 'e1', type: 'brightness' },
    });
    expectModelError(
      () => applyOperation(project, { type: 'update-effect', clipId: 'c1', effectId: 'e1' }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-effect',
          clipId: 'c1',
          effectId: 'e1',
          patch: { enabled: 'yes' },
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-effect',
          clipId: 'c1',
          effectId: 'e1',
          patch: { params: { amount: 4 } },
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-effect',
          clipId: 'ghost',
          effectId: 'e1',
          patch: { enabled: false },
        }),
      'clip-not-found',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-effect',
          clipId: 'c1',
          effectId: 'ghost',
          patch: { enabled: false },
        }),
      'effect-not-found',
    );
  });

  it('reorders and removes effects', () => {
    let project = phase1Fixture();
    for (const id of ['e1', 'e2', 'e3']) {
      project = applyOperation(project, {
        type: 'add-effect',
        clipId: 'c1',
        effect: { id, type: 'brightness' },
      });
    }
    project = applyOperation(project, {
      type: 'reorder-effects',
      clipId: 'c1',
      effectIds: ['e3', 'e1', 'e2'],
    });
    assert.deepEqual(
      clipById(project, 'c1').effects.map((effect) => effect.id),
      ['e3', 'e1', 'e2'],
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'reorder-effects',
          clipId: 'c1',
          effectIds: ['e1', 'e2'],
        }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'reorder-effects',
          clipId: 'c1',
          effectIds: ['e1', 'e2', 'ghost'],
        }),
      'invalid-input',
    );
    project = applyOperation(project, { type: 'remove-effect', clipId: 'c1', effectId: 'e1' });
    assert.deepEqual(
      clipById(project, 'c1').effects.map((effect) => effect.id),
      ['e3', 'e2'],
    );
    expectModelError(
      () => applyOperation(project, { type: 'remove-effect', clipId: 'c1', effectId: 'e1' }),
      'effect-not-found',
    );
  });

  it('normalizes effect defaults and strips unknown params', () => {
    const raw = mutatedRaw((value) => {
      value.tracks[0].clips[0].effects = [
        { id: 'e1', type: 'brightness', params: { amount: 1.5, bogus: 9 }, bogus: true },
        { id: 'e2', type: 'chromaKey' },
      ];
    });
    const clip = normalizeProject(raw).tracks[0].clips.find((item) => item.id === 'c2');
    assert.deepEqual(clip.effects, [
      { id: 'e1', type: 'brightness', enabled: true, params: { amount: 1.5 } },
      {
        id: 'e2',
        type: 'chromaKey',
        enabled: true,
        params: { keyColor: '#00ff00', similarity: 0.1, blend: 0.1 },
      },
    ]);
  });
});

describe('markers', () => {
  it('adds markers with defaults and keeps them sorted by frame', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'add-marker',
      marker: { id: 'm2', frame: 100, label: 'B' },
    });
    project = applyOperation(project, {
      type: 'add-marker',
      marker: { id: 'm1', frame: 10, label: 'A', color: '#112233' },
    });
    assert.deepEqual(project.markers, [
      { id: 'm1', frame: 10, label: 'A', color: '#112233' },
      { id: 'm2', frame: 100, label: 'B', color: '#ffcc00' },
    ]);
  });

  it('updates and removes markers', () => {
    let project = phase1Fixture();
    project = applyOperation(project, { type: 'add-marker', marker: { id: 'm1', frame: 10 } });
    project = applyOperation(project, { type: 'add-marker', marker: { id: 'm2', frame: 20 } });
    project = applyOperation(project, {
      type: 'update-marker',
      markerId: 'm1',
      frame: 30,
      label: 'later',
      color: '#abcdef',
    });
    assert.deepEqual(project.markers.map((marker) => marker.id), ['m2', 'm1']);
    assert.deepEqual(
      project.markers.find((marker) => marker.id === 'm1'),
      { id: 'm1', frame: 30, label: 'later', color: '#abcdef' },
    );
    project = applyOperation(project, { type: 'remove-marker', markerId: 'm2' });
    assert.deepEqual(project.markers.map((marker) => marker.id), ['m1']);
  });

  it('rejects invalid markers and missing ids', () => {
    const project = phase1Fixture();
    expectModelError(
      () => applyOperation(project, { type: 'add-marker', marker: { id: 'm', frame: -1 } }),
      'invalid-marker',
    );
    expectModelError(
      () => applyOperation(project, { type: 'add-marker', marker: { id: 'm', frame: 1.5 } }),
      'invalid-marker',
    );
    expectModelError(
      () => applyOperation(project, { type: 'add-marker', marker: { id: 'm', frame: 0, color: 'red' } }),
      'invalid-marker',
    );
    expectModelError(() => applyOperation(project, { type: 'add-marker' }), 'invalid-input');
    expectModelError(
      () => applyOperation(project, { type: 'update-marker', markerId: 'ghost', frame: 1 }),
      'marker-not-found',
    );
    expectModelError(
      () => applyOperation(project, { type: 'remove-marker', markerId: 'ghost' }),
      'marker-not-found',
    );
    let withMarker = applyOperation(project, { type: 'add-marker', marker: { id: 'm', frame: 0 } });
    expectModelError(
      () => applyOperation(withMarker, { type: 'add-marker', marker: { id: 'm', frame: 1 } }),
      'duplicate-id',
    );
    expectModelError(
      () => applyOperation(withMarker, { type: 'update-marker', markerId: 'm' }),
      'invalid-input',
    );
  });

  it('normalizes, sorts and strips unknown marker fields', () => {
    const raw = mutatedRaw((value) => {
      value.markers = [
        { id: 'm2', frame: 50, label: 'B', bogus: 1 },
        { id: 'm1', frame: 5 },
      ];
      value.tracks[0].clips[0].bogus = true;
    });
    const project = normalizeProject(raw);
    assert.deepEqual(project.markers, [
      { id: 'm1', frame: 5, label: '', color: '#ffcc00' },
      { id: 'm2', frame: 50, label: 'B', color: '#ffcc00' },
    ]);
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.markers = [
              { id: 'm', frame: 0 },
              { id: 'm', frame: 1 },
            ];
          }),
        ),
      'duplicate-id',
    );
  });

  it('markers survive clip edits', () => {
    let project = phase1Fixture();
    project = applyOperation(project, { type: 'add-marker', marker: { id: 'm1', frame: 10 } });
    project = applyOperation(project, { type: 'trim-clip', clipId: 'c1', durationFrames: 50 });
    project = applyOperation(project, { type: 'remove-clips', clipIds: ['c1'] });
    assert.deepEqual(project.markers.map((marker) => marker.id), ['m1']);
  });
});

describe('transitions', () => {
  it('adds a transition between adjacent clips', () => {
    const project = applyOperation(adjacentFixture(), {
      type: 'add-transition',
      transition: {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 20,
      },
    });
    assert.deepEqual(project.transitions, [
      {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 20,
      },
    ]);
  });

  it('rejects invalid transition definitions', () => {
    const project = adjacentFixture();
    const add = (transition) => applyOperation(project, { type: 'add-transition', transition });
    const base = {
      id: 'tr',
      trackId: 't-video',
      fromClipId: 'a',
      toClipId: 'b',
      type: 'dissolve',
      durationFrames: 10,
    };
    expectModelError(() => add({ ...base, durationFrames: 0 }), 'invalid-transition');
    expectModelError(() => add({ ...base, durationFrames: 101 }), 'invalid-transition');
    expectModelError(() => add({ ...base, durationFrames: 1.5 }), 'invalid-transition');
    expectModelError(() => add({ ...base, type: 'wipeUp' }), 'invalid-transition');
    expectModelError(() => add({ ...base, trackId: 'ghost' }), 'invalid-transition');
    expectModelError(() => add({ ...base, fromClipId: 'ghost' }), 'invalid-transition');
    expectModelError(() => add({ ...base, trackId: 't-audio' }), 'invalid-transition');
    expectModelError(() => applyOperation(project, { type: 'add-transition' }), 'invalid-input');

    let notAdjacent = fixture();
    notAdjacent = addClip(notAdjacent, { clipId: 'a', startFrame: 0, durationFrames: 100 });
    notAdjacent = addClip(notAdjacent, { clipId: 'b', startFrame: 150, durationFrames: 100 });
    expectModelError(
      () =>
        applyOperation(notAdjacent, {
          type: 'add-transition',
          transition: { ...base, id: 'tr2' },
        }),
      'invalid-transition',
    );

    let textEdge = adjacentFixture();
    textEdge = addText(textEdge, { clipId: 'txt', startFrame: 200, durationFrames: 30 });
    expectModelError(
      () =>
        applyOperation(textEdge, {
          type: 'add-transition',
          transition: { ...base, id: 'tr3', fromClipId: 'b', toClipId: 'txt' },
        }),
      'invalid-transition',
    );
  });

  it('rejects duplicate ids and duplicate boundaries', () => {
    let project = adjacentFixture();
    project = applyOperation(project, {
      type: 'add-transition',
      transition: {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 10,
      },
    });
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-transition',
          transition: {
            id: 'tr1',
            trackId: 't-video',
            fromClipId: 'a',
            toClipId: 'b',
            type: 'fadeToBlack',
            durationFrames: 5,
          },
        }),
      'duplicate-id',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'add-transition',
          transition: {
            id: 'tr2',
            trackId: 't-video',
            fromClipId: 'a',
            toClipId: 'b',
            type: 'fadeToBlack',
            durationFrames: 5,
          },
        }),
      'invalid-transition',
    );
  });

  it('updates and removes transitions', () => {
    let project = adjacentFixture();
    project = applyOperation(project, {
      type: 'add-transition',
      transition: {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 10,
      },
    });
    project = applyOperation(project, {
      type: 'update-transition',
      transitionId: 'tr1',
      transitionType: 'wipeLeft',
      durationFrames: 30,
    });
    assert.deepEqual(project.transitions[0], {
      id: 'tr1',
      trackId: 't-video',
      fromClipId: 'a',
      toClipId: 'b',
      type: 'wipeLeft',
      durationFrames: 30,
    });
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-transition',
          transitionId: 'tr1',
          durationFrames: 101,
        }),
      'invalid-transition',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-transition', transitionId: 'tr1' }),
      'invalid-input',
    );
    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-transition',
          transitionId: 'ghost',
          durationFrames: 5,
        }),
      'transition-not-found',
    );
    project = applyOperation(project, { type: 'remove-transition', transitionId: 'tr1' });
    assert.deepEqual(project.transitions, []);
    expectModelError(
      () => applyOperation(project, { type: 'remove-transition', transitionId: 'tr1' }),
      'transition-not-found',
    );
  });

  it('prunes transitions when clips move, trim, split or vanish', () => {
    let project = adjacentFixture();
    project = applyOperation(project, {
      type: 'add-transition',
      transition: {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 10,
      },
    });
    const moved = applyOperation(project, { type: 'move-clip', clipId: 'b', startFrame: 150 });
    assert.deepEqual(moved.transitions, []);
    const trimmed = applyOperation(project, { type: 'trim-clip', clipId: 'a', durationFrames: 50 });
    assert.deepEqual(trimmed.transitions, []);
    const removed = applyOperation(project, { type: 'remove-clips', clipIds: ['b'] });
    assert.deepEqual(removed.transitions, []);
    const split = applyOperation(project, {
      type: 'split-clip',
      clipId: 'a',
      atFrame: 50,
      leftClipId: 'a',
      rightClipId: 'aR',
    });
    assert.deepEqual(split.transitions, []);
    const noMedia = applyOperation(project, { type: 'remove-media', mediaId: 'm-video' });
    assert.deepEqual(noMedia.transitions, []);
  });

  it('normalizes transitions and strips unknown fields', () => {
    const raw = {
      version: 1,
      name: 'transitions',
      fps: 30,
      media: [{ id: 'm', kind: 'video', fileName: 'm.mp4', durationFrames: 300 }],
      tracks: [
        {
          id: 't',
          type: 'video',
          clips: [
            { id: 'a', type: 'video', mediaId: 'm', startFrame: 0, durationFrames: 100 },
            { id: 'b', type: 'video', mediaId: 'm', startFrame: 100, durationFrames: 100 },
          ],
        },
      ],
      transitions: [
        {
          id: 'tr',
          trackId: 't',
          fromClipId: 'a',
          toClipId: 'b',
          type: 'fadeToBlack',
          durationFrames: 20,
          bogus: true,
        },
      ],
    };
    const project = normalizeProject(raw);
    assert.deepEqual(project.transitions, [
      {
        id: 'tr',
        trackId: 't',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'fadeToBlack',
        durationFrames: 20,
      },
    ]);
    expectModelError(() => normalizeProject({ ...raw, transitions: [{ ...raw.transitions[0], durationFrames: 101 }] }), 'invalid-transition');
    expectModelError(() => normalizeProject({ ...raw, transitions: [{ ...raw.transitions[0], type: 'wipeUp' }] }), 'invalid-transition');
    expectModelError(
      () => normalizeProject({ ...raw, transitions: [raw.transitions[0], { ...raw.transitions[0] }] }),
      'duplicate-id',
    );
  });
});

describe('captions', () => {
  it('creates a caption clip on an auto-created video track', () => {
    const project = addCaption(emptyProject(), {
      clipId: 'cap1',
      startFrame: 0,
      durationFrames: 90,
      segments: [
        { startFrame: 30, durationFrames: 30, text: 'Second' },
        { startFrame: 0, durationFrames: 30, text: 'First' },
      ],
      style: { fontSize: 36, align: 'left', background: '#000000' },
    });
    assert.equal(project.tracks.length, 1);
    assert.equal(project.tracks[0].id, 'caption-track-cap1');
    assert.equal(project.tracks[0].type, 'video');
    const clip = clipById(project, 'cap1');
    assert.equal(clip.type, 'caption');
    assert.equal(clip.mediaId, null);
    assert.equal(clip.trimStartFrame, 0);
    assert.equal(clip.speed, 1);
    assert.equal(clip.text, null);
    assert.deepEqual(clip.caption.segments, [
      { startFrame: 0, durationFrames: 30, text: 'First' },
      { startFrame: 30, durationFrames: 30, text: 'Second' },
    ]);
    assert.deepEqual(clip.caption.style, {
      fontSize: 36,
      color: '#ffffff',
      fontWeight: '600',
      align: 'left',
      background: '#000000',
    });
    assert.equal(clip.caption.style.background, '#000000');
  });

  it('reuses or auto-creates video tracks', () => {
    let project = addCaption(fixture(), { clipId: 'cap1', startFrame: 0, durationFrames: 60 });
    assert.equal(findClip(project, 'cap1').track.id, 't-video');

    project = addCaption(fixture(), {
      clipId: 'cap2',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 60,
    });
    assert.equal(findClip(project, 'cap2').track.id, 't-video2');

    let busy = fixture();
    busy = addClip(busy, { clipId: 'v1', startFrame: 0, durationFrames: 100 });
    busy = addClip(busy, {
      clipId: 'v2',
      trackId: 't-video2',
      startFrame: 0,
      durationFrames: 100,
    });
    busy = addCaption(busy, { clipId: 'cap3', startFrame: 0, durationFrames: 60 });
    assert.equal(findClip(busy, 'cap3').track.id, 'caption-track-cap3');
    assert.equal(busy.tracks.length, 4);
  });

  it('rejects invalid caption targets and duplicate ids', () => {
    const project = fixture();
    expectModelError(
      () => addCaption(project, { clipId: 'cap', trackId: 't-audio' }),
      'incompatible-track-type',
    );
    expectModelError(
      () => addCaption(project, { clipId: 'cap', trackId: 'ghost' }),
      'track-not-found',
    );
    const withClip = addClip(project, { clipId: 'cap', startFrame: 0, durationFrames: 50 });
    expectModelError(() => addCaption(withClip, { clipId: 'cap' }), 'duplicate-id');
  });

  it('validates caption segments and style', () => {
    const project = fixture();
    expectModelError(
      () =>
        addCaption(project, {
          clipId: 'cap',
          durationFrames: 30,
          segments: [{ startFrame: 0, durationFrames: 31, text: 'X' }],
        }),
      'invalid-caption',
    );
    expectModelError(
      () =>
        addCaption(project, {
          clipId: 'cap',
          durationFrames: 60,
          segments: [
            { startFrame: 0, durationFrames: 40, text: 'A' },
            { startFrame: 30, durationFrames: 20, text: 'B' },
          ],
        }),
      'invalid-caption',
    );
    expectModelError(
      () =>
        addCaption(project, {
          clipId: 'cap',
          durationFrames: 30,
          segments: [{ startFrame: 0, durationFrames: 10 }],
        }),
      'invalid-caption',
    );
    expectModelError(
      () => addCaption(project, { clipId: 'cap', style: { align: 'justify' } }),
      'invalid-caption',
    );
    expectModelError(
      () => addCaption(project, { clipId: 'cap', style: { fontWeight: '900' } }),
      'invalid-caption',
    );
    expectModelError(
      () => addCaption(project, { clipId: 'cap', style: { fontSize: 0 } }),
      'invalid-caption',
    );
  });

  it('updates caption segments and style', () => {
    let project = addCaption(fixture(), { clipId: 'cap', startFrame: 0, durationFrames: 90 });
    project = applyOperation(project, {
      type: 'update-caption',
      clipId: 'cap',
      segments: [
        { startFrame: 10, durationFrames: 20, text: 'Only' },
        { startFrame: 50, durationFrames: 20, text: 'Two' },
      ],
      style: { color: '#ff0000', align: 'right' },
    });
    const clip = clipById(project, 'cap');
    assert.deepEqual(
      clip.caption.segments.map((segment) => [segment.startFrame, segment.text]),
      [
        [10, 'Only'],
        [50, 'Two'],
      ],
    );
    assert.equal(clip.caption.style.color, '#ff0000');
    assert.equal(clip.caption.style.align, 'right');
    assert.equal(clip.caption.style.fontSize, 48);

    expectModelError(
      () =>
        applyOperation(project, {
          type: 'update-caption',
          clipId: 'cap',
          segments: [
            { startFrame: 0, durationFrames: 20, text: 'A' },
            { startFrame: 10, durationFrames: 20, text: 'B' },
          ],
        }),
      'invalid-caption',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-caption', clipId: 'cap', style: { align: 'justify' } }),
      'invalid-caption',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-caption', clipId: 'cap' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-caption', clipId: 'ghost', segments: [] }),
      'clip-not-found',
    );
    let videoClip = addClip(project, { clipId: 'v1', startFrame: 200, durationFrames: 50 });
    expectModelError(
      () => applyOperation(videoClip, { type: 'update-caption', clipId: 'v1', segments: [] }),
      'not-caption-clip',
    );
  });

  it('splits caption segments at the cut', () => {
    let project = addCaption(fixture(), {
      clipId: 'cap',
      startFrame: 0,
      durationFrames: 90,
      segments: [
        { startFrame: 0, durationFrames: 30, text: 'A' },
        { startFrame: 30, durationFrames: 30, text: 'B' },
      ],
    });
    project = applyOperation(project, {
      type: 'split-clip',
      clipId: 'cap',
      atFrame: 45,
      leftClipId: 'capL',
      rightClipId: 'capR',
    });
    const left = clipById(project, 'capL');
    const right = clipById(project, 'capR');
    assert.deepEqual(
      left.caption.segments.map((segment) => [segment.startFrame, segment.durationFrames, segment.text]),
      [
        [0, 30, 'A'],
        [30, 15, 'B'],
      ],
    );
    assert.deepEqual(
      right.caption.segments.map((segment) => [segment.startFrame, segment.durationFrames, segment.text]),
      [[0, 15, 'B']],
    );
    assert.equal(left.durationFrames, 45);
    assert.equal(right.durationFrames, 45);
  });

  it('trims caption duration and shifts caption heads on overlap', () => {
    let project = addCaption(fixture(), {
      clipId: 'cap',
      startFrame: 0,
      durationFrames: 90,
      segments: [
        { startFrame: 0, durationFrames: 30, text: 'A' },
        { startFrame: 30, durationFrames: 30, text: 'B' },
      ],
    });
    const trimmed = applyOperation(project, { type: 'trim-clip', clipId: 'cap', durationFrames: 45 });
    assert.deepEqual(
      clipById(trimmed, 'cap').caption.segments.map((segment) => [segment.startFrame, segment.durationFrames]),
      [
        [0, 30],
        [30, 15],
      ],
    );

    const covered = addClip(project, {
      clipId: 'cover',
      startFrame: 20,
      durationFrames: 30,
      splitRightClipId: 'capR',
    });
    const right = clipById(covered, 'capR');
    // The removed middle [20, 50) drops the tail of A and the head of B.
    assert.deepEqual(
      right.caption.segments.map((segment) => [segment.startFrame, segment.durationFrames, segment.text]),
      [[0, 10, 'B']],
    );
  });

  it('normalizes caption clips and strips unknown style fields', () => {
    const raw = {
      version: 1,
      name: 'captions',
      fps: 30,
      tracks: [
        {
          id: 't',
          type: 'video',
          clips: [
            {
              id: 'cap',
              type: 'caption',
              mediaId: null,
              startFrame: 0,
              durationFrames: 60,
              caption: {
                segments: [
                  { startFrame: 30, durationFrames: 20, text: 'B', bogus: 1 },
                  { startFrame: 0, durationFrames: 10, text: 'A' },
                ],
                style: { fontSize: 24, bogus: true },
                bogus: true,
              },
              bogus: true,
            },
          ],
        },
      ],
    };
    const project = normalizeProject(raw);
    const clip = project.tracks[0].clips[0];
    assert.deepEqual(clip.caption.segments, [
      { startFrame: 0, durationFrames: 10, text: 'A' },
      { startFrame: 30, durationFrames: 20, text: 'B' },
    ]);
    assert.deepEqual(clip.caption.style, {
      fontSize: 24,
      color: '#ffffff',
      fontWeight: '600',
      align: 'center',
      background: null,
    });
    expectModelError(
      () =>
        normalizeProject({
          tracks: [
            {
              id: 't',
              type: 'video',
              clips: [
                { id: 'cap', type: 'caption', mediaId: 'm', startFrame: 0, durationFrames: 30, caption: { segments: [] } },
              ],
            },
          ],
        }),
      'invalid-clip',
    );
    expectModelError(
      () =>
        normalizeProject({
          tracks: [
            {
              id: 'a',
              type: 'audio',
              clips: [
                { id: 'cap', type: 'caption', mediaId: null, startFrame: 0, durationFrames: 30, caption: { segments: [] } },
              ],
            },
          ],
        }),
      'incompatible-track-type',
    );
  });
});

describe('phase 1 normalize, purity and invariants', () => {
  function richProject() {
    let project = adjacentFixture();
    project = applyOperation(project, {
      type: 'add-transition',
      transition: {
        id: 'tr1',
        trackId: 't-video',
        fromClipId: 'a',
        toClipId: 'b',
        type: 'dissolve',
        durationFrames: 20,
      },
    });
    project = applyOperation(project, { type: 'add-marker', marker: { id: 'm1', frame: 10, label: 'X' } });
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'a',
      property: 'volume',
      keyframes: [
        { frame: 0, value: 1 },
        { frame: 100, value: 0, easing: 'ease-in-out' },
      ],
    });
    project = applyOperation(project, {
      type: 'add-effect',
      clipId: 'a',
      effect: { id: 'e1', type: 'chromaKey', params: { keyColor: '#123456' } },
    });
    project = applyOperation(project, {
      type: 'set-fades',
      clipId: 'a',
      fadeInFrames: 5,
      fadeOutFrames: 5,
    });
    project = addCaption(project, {
      clipId: 'cap',
      startFrame: 300,
      durationFrames: 60,
      segments: [{ startFrame: 0, durationFrames: 60, text: 'Hi' }],
      style: { background: '#000000' },
    });
    return project;
  }

  it('normalizeProject is idempotent for a project using every new field', () => {
    const project = richProject();
    assert.deepEqual(normalizeProject(project), project);
    assert.deepEqual(normalizeProject(normalizeProject(project)), project);
    assert.equal(project.transitions.length, 1);
    assert.equal(project.markers.length, 1);
    assert.equal(findClip(project, 'cap').clip.type, 'caption');
  });

  it('strips unknown properties at every level', () => {
    const project = richProject();
    project.bogus = true;
    project.markers[0].bogus = true;
    project.transitions[0].bogus = true;
    const clip = clipById(project, 'a');
    clip.bogus = true;
    clip.keyframes.volume[0].bogus = true;
    clip.effects[0].bogus = true;
    clip.effects[0].params.bogus = true;
    const captionClip = clipById(project, 'cap');
    captionClip.caption.bogus = true;
    captionClip.caption.style.bogus = true;
    captionClip.caption.segments[0].bogus = true;
    const normalized = normalizeProject(project);
    assert.equal('bogus' in normalized, false);
    assert.equal('bogus' in normalized.markers[0], false);
    assert.equal('bogus' in normalized.transitions[0], false);
    const normalizedClip = findClip(normalized, 'a').clip;
    assert.equal('bogus' in normalizedClip, false);
    assert.equal('bogus' in normalizedClip.keyframes.volume[0], false);
    assert.equal('bogus' in normalizedClip.effects[0], false);
    assert.equal('bogus' in normalizedClip.effects[0].params, false);
    const normalizedCaption = findClip(normalized, 'cap').clip;
    assert.equal('bogus' in normalizedCaption.caption, false);
    assert.equal('bogus' in normalizedCaption.caption.style, false);
    assert.equal('bogus' in normalizedCaption.caption.segments[0], false);
  });

  it('is pure for every new operation', () => {
    let project = richProject();
    const before = JSON.stringify(project);
    const operations = [
      { type: 'set-speed', clipId: 'b', speed: 2 },
      { type: 'set-keyframes', clipId: 'b', property: 'opacity', keyframes: [{ frame: 0, value: 0.5 }] },
      { type: 'add-effect', clipId: 'b', effect: { id: 'e2', type: 'blur', params: { radius: 2 } } },
      { type: 'set-fades', clipId: 'b', fadeInFrames: 3 },
      { type: 'add-marker', marker: { id: 'm2', frame: 20 } },
      { type: 'update-transition', transitionId: 'tr1', durationFrames: 5 },
      { type: 'update-marker', markerId: 'm1', frame: 15 },
      { type: 'update-caption', clipId: 'cap', style: { color: '#ff0000' } },
      { type: 'add-caption', clipId: 'cap2', startFrame: 400, durationFrames: 30, segments: [] },
      { type: 'reorder-tracks', trackId: 't-audio', toIndex: 0 },
    ];
    for (const operation of operations) {
      const operationBefore = JSON.stringify(operation);
      applyOperation(project, operation);
      assert.equal(JSON.stringify(project), before);
      assert.equal(JSON.stringify(operation), operationBefore);
    }
  });

  it('two identical phase 1 operations produce the same result', () => {
    const project = richProject();
    const operation = { type: 'set-speed', clipId: 'b', speed: 2 };
    assert.deepEqual(applyOperation(project, operation), applyOperation(project, operation));
  });

  it('markers do not extend the timeline duration', () => {
    let project = phase1Fixture();
    assert.equal(timelineDurationFrames(project), 100);
    project = applyOperation(project, { type: 'add-marker', marker: { id: 'm', frame: 5000 } });
    assert.equal(timelineDurationFrames(project), 100);
  });

  it('supports speed changes on audio clips', () => {
    let project = fixture();
    project = addClip(project, {
      clipId: 'aud',
      mediaId: 'm-audio',
      trackId: 't-audio',
      startFrame: 0,
      durationFrames: 100,
    });
    project = applyOperation(project, { type: 'set-speed', clipId: 'aud', speed: 2 });
    const clip = clipById(project, 'aud');
    assert.equal(clip.speed, 2);
    assert.equal(clip.durationFrames, 50);
    assert.equal(sourceFrameForTimeline(clip, 50), 100);
  });

  it('sorts multiple transitions by track and clip order', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = addClip(project, { clipId: 'c2', startFrame: 50, durationFrames: 50 });
    project = addClip(project, { clipId: 'c3', startFrame: 100, durationFrames: 50 });
    const makeTransition = (id, fromClipId, toClipId) => ({
      id,
      trackId: 't-video',
      fromClipId,
      toClipId,
      type: 'fadeToBlack',
      durationFrames: 10,
    });
    project = applyOperation(project, {
      type: 'add-transition',
      transition: makeTransition('tr2', 'c2', 'c3'),
    });
    project = applyOperation(project, {
      type: 'add-transition',
      transition: makeTransition('tr1', 'c1', 'c2'),
    });
    assert.deepEqual(project.transitions.map((transition) => transition.id), ['tr1', 'tr2']);
  });

  it('rejects an unknown phase 1 effect type through normalize', () => {
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].effects = [{ id: 'e', type: 'glow' }];
          }),
        ),
      'invalid-clip',
    );
  });

  it('rejects duplicate transition boundaries through normalize', () => {
    const raw = {
      version: 1,
      name: 'dup',
      fps: 30,
      media: [{ id: 'm', kind: 'video', fileName: 'm.mp4', durationFrames: 300 }],
      tracks: [
        {
          id: 't',
          type: 'video',
          clips: [
            { id: 'a', type: 'video', mediaId: 'm', startFrame: 0, durationFrames: 100 },
            { id: 'b', type: 'video', mediaId: 'm', startFrame: 100, durationFrames: 100 },
          ],
        },
      ],
      transitions: [
        { id: 'tr1', trackId: 't', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationFrames: 10 },
        { id: 'tr2', trackId: 't', fromClipId: 'a', toClipId: 'b', type: 'fadeToBlack', durationFrames: 10 },
      ],
    };
    expectModelError(() => normalizeProject(raw), 'invalid-transition');
  });

  it('caption clips default to a full-frame transform', () => {
    const project = addCaption(fixture(), { clipId: 'cap', startFrame: 0, durationFrames: 30 });
    assert.deepEqual(clipById(project, 'cap').transform, { x: 0.05, y: 0.78, width: 0.9, height: 0.16, rotation: 0 });
  });
});

// ===========================================================================
// Phase 2: track updates + project rename (DESIGN Phase 2 model additions).
// ===========================================================================

describe('update-track', () => {
  it('renames a track and preserves its type and clips', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = applyOperation(project, {
      type: 'update-track',
      trackId: 't-video',
      name: 'B-roll',
    });
    const track = findTrack(project, 't-video');
    assert.equal(track.name, 'B-roll');
    assert.equal(track.type, 'video');
    assert.equal(track.muted, false);
    assert.equal(track.hidden, false);
    assert.deepEqual(track.clips.map((clip) => clip.id), ['c1']);
  });

  it('mutes and hides tracks independently', () => {
    let project = fixture();
    project = applyOperation(project, { type: 'update-track', trackId: 't-video', muted: true });
    assert.equal(findTrack(project, 't-video').muted, true);
    assert.equal(findTrack(project, 't-video').hidden, false);

    project = applyOperation(project, { type: 'update-track', trackId: 't-video', hidden: true });
    const track = findTrack(project, 't-video');
    assert.equal(track.muted, true);
    assert.equal(track.hidden, true);
    assert.equal(findTrack(project, 't-video2').muted, false);
    assert.equal(findTrack(project, 't-audio').hidden, false);
  });

  it('supports partial updates and a no-op', () => {
    let project = fixture();
    project = applyOperation(project, {
      type: 'update-track',
      trackId: 't-audio',
      name: 'Music',
      muted: true,
    });
    project = applyOperation(project, { type: 'update-track', trackId: 't-audio', hidden: true });
    let track = findTrack(project, 't-audio');
    assert.equal(track.name, 'Music');
    assert.equal(track.muted, true);
    assert.equal(track.hidden, true);

    const noop = applyOperation(project, { type: 'update-track', trackId: 't-audio' });
    track = findTrack(noop, 't-audio');
    assert.equal(track.name, 'Music');
    assert.equal(track.muted, true);
    assert.equal(track.hidden, true);
    assert.equal(typeof noop.updatedAt, 'number');
  });

  it('keeps empty tracks instead of deleting them', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    project = applyOperation(project, { type: 'remove-clips', clipIds: ['c1'] });
    assert.deepEqual(findTrack(project, 't-video').clips, []);
    project = applyOperation(project, { type: 'update-track', trackId: 't-video', name: 'Empty' });
    const track = findTrack(project, 't-video');
    assert.ok(track !== null);
    assert.equal(track.name, 'Empty');
    assert.deepEqual(track.clips, []);
  });

  it('rejects invalid update-track input', () => {
    const project = fixture();
    expectModelError(
      () => applyOperation(project, { type: 'update-track', trackId: 'ghost', name: 'X' }),
      'track-not-found',
    );
    expectModelError(() => applyOperation(project, { type: 'update-track' }), 'invalid-input');
    expectModelError(
      () => applyOperation(project, { type: 'update-track', trackId: 't-video', name: '' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-track', trackId: 't-video', name: 42 }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-track', trackId: 't-video', muted: 'yes' }),
      'invalid-input',
    );
    expectModelError(
      () => applyOperation(project, { type: 'update-track', trackId: 't-video', hidden: 0 }),
      'invalid-input',
    );
  });

  it('does not mutate the input project or operation', () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const operation = { type: 'update-track', trackId: 't-video', name: 'Renamed', muted: true };
    const operationBefore = JSON.stringify(operation);
    const next = applyOperation(project, operation);
    assert.equal(JSON.stringify(project), before);
    assert.equal(JSON.stringify(operation), operationBefore);
    assert.equal(findTrack(next, 't-video').name, 'Renamed');
    assert.equal(findTrack(project, 't-video').name, 'Video 1');
  });

  it('persists through normalizeProject', () => {
    let project = fixture();
    project = applyOperation(project, {
      type: 'update-track',
      trackId: 't-video2',
      name: 'Overlay',
      muted: true,
      hidden: true,
    });
    const normalized = normalizeProject(project);
    assert.deepEqual(normalized, project);
    const track = findTrack(normalized, 't-video2');
    assert.equal(track.name, 'Overlay');
    assert.equal(track.muted, true);
    assert.equal(track.hidden, true);
    assert.deepEqual(normalizeProject(normalized), normalized);
  });
});

describe('rename-project', () => {
  it('renames the project without touching its contents', () => {
    let project = fixture();
    project = addClip(project, { clipId: 'c1', startFrame: 0, durationFrames: 50 });
    const tracksBefore = JSON.stringify(project.tracks);
    project = applyOperation(project, { type: 'rename-project', name: 'Final Cut' });
    assert.equal(project.name, 'Final Cut');
    assert.equal(JSON.stringify(project.tracks), tracksBefore);
    assert.equal(project.version, 1);
    assert.equal(project.fps, 30);
    assert.equal(project.width, 1920);
    assert.equal(project.height, 1080);
  });

  it('rejects empty or missing names', () => {
    const project = fixture();
    expectModelError(() => applyOperation(project, { type: 'rename-project' }), 'invalid-input');
    expectModelError(() => applyOperation(project, { type: 'rename-project', name: '' }), 'invalid-input');
    expectModelError(() => applyOperation(project, { type: 'rename-project', name: 7 }), 'invalid-input');
  });

  it('is pure, allows renaming to the same name, and persists', () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const next = applyOperation(project, { type: 'rename-project', name: project.name });
    assert.equal(JSON.stringify(project), before);
    assert.equal(next.name, project.name);
    assert.deepEqual(normalizeProject(next), next);
    const renamed = applyOperation(next, { type: 'rename-project', name: 'Second' });
    assert.equal(renamed.name, 'Second');
    assert.equal(normalizeProject(renamed).name, 'Second');
  });
});

describe('transform rotation range', () => {
  it('accepts and preserves -360..360 degree rotations', () => {
    let project = phase1Fixture();
    for (const rotation of [-360, -180, -45, 0, 45, 180, 360]) {
      project = applyOperation(project, {
        type: 'set-clip-properties',
        clipIds: ['c1'],
        transform: { rotation },
      });
      assert.equal(clipById(project, 'c1').transform.rotation, rotation);
    }
  });

  it('normalizes negative rotation values and rejects non-numeric ones', () => {
    const raw = mutatedRaw((value) => {
      value.tracks[0].clips[0].transform = { rotation: -270 };
    });
    const project = normalizeProject(raw);
    const clip = project.tracks[0].clips.find((item) => item.id === 'c2');
    assert.equal(clip.transform.rotation, -270);
    expectModelError(
      () =>
        normalizeProject(
          mutatedRaw((value) => {
            value.tracks[0].clips[0].transform = { rotation: '-90' };
          }),
        ),
      'invalid-clip',
    );
  });

  it('accepts negative rotation keyframes', () => {
    let project = phase1Fixture();
    project = applyOperation(project, {
      type: 'set-keyframes',
      clipId: 'c1',
      property: 'rotation',
      keyframes: [
        { frame: 0, value: -180, easing: 'linear' },
        { frame: 100, value: 180, easing: 'ease-in-out' },
      ],
    });
    assert.deepEqual(clipById(project, 'c1').keyframes.rotation, [
      { frame: 0, value: -180, easing: 'linear' },
      { frame: 100, value: 180, easing: 'ease-in-out' },
    ]);
    assert.equal(evaluateKeyframes(clipById(project, 'c1').keyframes.rotation, 50, 0), 0);
  });
});
