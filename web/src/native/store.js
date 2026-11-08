/**
 * Native-editor state model.
 *
 * The model is plain JavaScript with no React import. It owns the bounded
 * milestone state (home/editor, media, timeline, selection, preview frame) and
 * all engine mutations. The React layer only subscribes and renders.
 */

import { createTranslator } from './locale.js';

const DEFAULT_FPS = 30;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Accept either a `TimelineSnapshotDto` or a bare timeline for defensive tests. */
export function timelineTracks(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const timeline = snapshot.timeline !== null && typeof snapshot.timeline === 'object'
    ? snapshot.timeline
    : snapshot;
  return asArray(timeline.tracks);
}

export function timelineMeta(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    return { fps: DEFAULT_FPS, width: 1920, height: 1080, projectPath: null, version: 0 };
  }
  const timeline = snapshot.timeline !== null && typeof snapshot.timeline === 'object'
    ? snapshot.timeline
    : snapshot;
  return {
    fps: Number.isFinite(Number(timeline.fps)) ? Number(timeline.fps) : DEFAULT_FPS,
    width: Number.isFinite(Number(timeline.width)) ? Number(timeline.width) : 1920,
    height: Number.isFinite(Number(timeline.height)) ? Number(timeline.height) : 1080,
    projectPath: typeof snapshot.projectPath === 'string' ? snapshot.projectPath : null,
    version: Number.isFinite(Number(snapshot.version)) ? Number(snapshot.version) : 0,
  };
}

export function findClip(snapshot, clipId) {
  if (typeof clipId !== 'string' || clipId.length === 0) return null;
  const tracks = timelineTracks(snapshot);
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const track = tracks[trackIndex];
    const clips = asArray(track?.clips);
    for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
      if (clips[clipIndex]?.id === clipId) {
        return { trackIndex, clipIndex, track, clip: clips[clipIndex] };
      }
    }
  }
  return null;
}

export function totalFrames(snapshot) {
  let end = 0;
  for (const track of timelineTracks(snapshot)) {
    for (const clip of asArray(track?.clips)) {
      const start = Number(clip?.startFrame) || 0;
      const duration = Number(clip?.durationFrames) || 0;
      end = Math.max(end, start + Math.max(0, duration));
    }
  }
  return Math.max(1, end);
}

export function clipCount(snapshot) {
  return timelineTracks(snapshot).reduce((count, track) => count + asArray(track?.clips).length, 0);
}

/** Parse the media list route (`{items: [...]}` or a bare array for tests). */
export function mediaItems(media) {
  if (Array.isArray(media)) return media;
  return media !== null && typeof media === 'object' ? asArray(media.items) : [];
}

/** Caption clips are text clips that carry a caption group id. */
export function captionClips(snapshot) {
  const result = [];
  for (const [trackIndex, track] of timelineTracks(snapshot).entries()) {
    for (const [clipIndex, clip] of asArray(track?.clips).entries()) {
      if (typeof clip?.captionGroupId === 'string' && clip.captionGroupId.length > 0) {
        result.push({ trackIndex, clipIndex, track, clip });
      }
    }
  }
  return result;
}

/**
 * Small client-side sampler for the keyframe panel readout. The engine remains
 * authoritative for render evaluation; this only shows the authored scalar
 * between keyframes so the UI has a useful "at this frame" value.
 */
export function evaluateScalarTrack(track, frame) {
  const keyframes = asArray(track?.keyframes)
    .filter((keyframe) => Number.isFinite(Number(keyframe?.frame)) && Number.isFinite(Number(keyframe?.value)))
    .map((keyframe) => ({ frame: Number(keyframe.frame), value: Number(keyframe.value) }))
    .sort((a, b) => a.frame - b.frame);
  if (keyframes.length === 0) return null;
  if (frame <= keyframes[0].frame) return keyframes[0].value;
  if (frame >= keyframes[keyframes.length - 1].frame) return keyframes[keyframes.length - 1].value;
  for (let index = 1; index < keyframes.length; index += 1) {
    const right = keyframes[index];
    if (frame <= right.frame) {
      const left = keyframes[index - 1];
      const span = right.frame - left.frame;
      if (span <= 0) return right.value;
      const ratio = (frame - left.frame) / span;
      return left.value + (right.value - left.value) * ratio;
    }
  }
  return keyframes[keyframes.length - 1].value;
}

export function nextId(prefix = 'clip') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid === undefined ? `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : `${prefix}-${uuid}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{
 *   client: ReturnType<typeof import('./ipc.js').createEngineClient>,
 *   locale?: string,
 *   pollIntervalMs?: number,
 *   setIntervalImpl?: (fn: () => void, ms: number) => unknown,
 *   clearIntervalImpl?: (handle: unknown) => void,
 * }} options
 */
export function createNativeEditorStore({
  client,
  locale = 'en',
  pollIntervalMs = 0,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  if (client === null || typeof client !== 'object') throw new TypeError('client is required');
  if (typeof setIntervalImpl !== 'function' || typeof clearIntervalImpl !== 'function') {
    throw new TypeError('timer functions must be functions');
  }
  const translator = createTranslator(locale);
  let state = {
    view: 'home',
    panel: 'editor',
    locale: translator.locale,
    theme: 'system',
    ready: false,
    loading: false,
    busy: false,
    error: null,
    info: null,
    timeline: null,
    media: [],
    selectedClipId: null,
    selectedMediaId: null,
    frame: 0,
    revision: 0,
    projectPath: null,
    engine: { connected: false, loaded: false, error: null },
    pollIntervalMs,
    settings: null,
    settingsLoading: false,
    luts: [],
    lutsLoading: false,
    library: [],
    libraryLoading: false,
    motion: [],
    motionLoading: false,
    exportState: {
      active: false,
      phase: 'idle',
      done: 0,
      total: 0,
      error: null,
      summary: null,
    },
    playback: {
      active: false,
      paused: false,
      frame: 0,
    },
  };
  const listeners = new Set();
  let timer = null;
  let exportTimer = null;
  let playbackTimer = null;

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // A subscriber must not break engine state updates.
      }
    }
  }

  function update(patch) {
    state = { ...state, ...patch };
    notify();
    return state;
  }

  function engineFromInfo(info) {
    return {
      connected: info !== null && typeof info === 'object',
      loaded: info?.loaded === true,
      error: typeof info?.loadError === 'string' ? info.loadError : null,
    };
  }

  function syncTranslatedLocale(nextLocale) {
    const t = createTranslator(nextLocale);
    return { locale: t.locale };
  }

  async function collect({ initial = false } = {}) {
    update({ loading: initial ? true : state.loading, error: initial ? null : state.error });
    const [infoResult, timelineResult, mediaResult] = await Promise.allSettled([
      client.info(),
      client.timeline(),
      client.media(),
    ]);
    const errors = [];
    const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
    const timeline = timelineResult.status === 'fulfilled' ? timelineResult.value : null;
    const media = mediaResult.status === 'fulfilled' ? mediaResult.value : null;
    if (infoResult.status === 'rejected') errors.push(errorMessage(infoResult.reason));
    if (timelineResult.status === 'rejected') errors.push(errorMessage(timelineResult.reason));
    if (mediaResult.status === 'rejected') errors.push(errorMessage(mediaResult.reason));
    const meta = timelineMeta(timeline);
    const selectedStillExists = findClip(timeline, state.selectedClipId) !== null;
    return update({
      ready: true,
      loading: false,
      info,
      timeline,
      media: mediaItems(media),
      projectPath: meta.projectPath,
      frame: Math.min(state.frame, Math.max(0, totalFrames(timeline) - 1)),
      selectedClipId: selectedStillExists ? state.selectedClipId : null,
      selectedMediaId: mediaItems(media).some((item) => item.id === state.selectedMediaId) ? state.selectedMediaId : null,
      engine: engineFromInfo(info),
      error: errors.length > 0 ? errors[0] : null,
    });
  }

  async function initialize() {
    return collect({ initial: true });
  }

  async function refresh() {
    return collect();
  }

  async function saveProject(path = null) {
    if (state.busy) return null;
    update({ busy: true, error: null });
    try {
      const saved = await client.saveProject(path);
      update({
        busy: false,
        projectPath: typeof saved?.path === 'string' ? saved.path : state.projectPath,
      });
      await refresh();
      return saved;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function openProject(path) {
    if (state.busy) return null;
    update({ busy: true, error: null, view: 'home' });
    try {
      const snapshot = await client.openProject(path);
      const meta = timelineMeta(snapshot);
      update({
        busy: false,
        timeline: snapshot,
        projectPath: meta.projectPath,
        view: 'editor',
        selectedClipId: null,
        frame: 0,
        revision: state.revision + 1,
      });
      await refresh();
      return snapshot;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function newProject() {
    if (state.busy) return null;
    update({ busy: true, error: null, view: 'home' });
    try {
      const snapshot = await client.newProject();
      const meta = timelineMeta(snapshot);
      update({
        busy: false,
        timeline: snapshot,
        projectPath: meta.projectPath,
        view: 'editor',
        selectedClipId: null,
        frame: 0,
        revision: state.revision + 1,
      });
      await refresh();
      return snapshot;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function apply(command) {
    if (state.busy) return null;
    if (command === null || typeof command !== 'object' || Array.isArray(command)) {
      update({ error: 'edit command must be an object' });
      return null;
    }
    update({ busy: true, error: null });
    try {
      const result = await client.apply(command);
      const snapshot = await client.timeline();
      const meta = timelineMeta(snapshot);
      update({
        busy: false,
        timeline: snapshot,
        projectPath: meta.projectPath,
        revision: state.revision + 1,
        frame: Math.min(state.frame, Math.max(0, totalFrames(snapshot) - 1)),
      });
      return result;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function history(kind) {
    if (state.busy) return null;
    update({ busy: true, error: null });
    try {
      const result = await (kind === 'undo' ? client.undo() : client.redo());
      const snapshot = await client.timeline();
      const meta = timelineMeta(snapshot);
      update({
        busy: false,
        timeline: snapshot,
        projectPath: meta.projectPath,
        revision: state.revision + 1,
        selectedClipId: findClip(snapshot, state.selectedClipId) === null ? null : state.selectedClipId,
        frame: Math.min(state.frame, Math.max(0, totalFrames(snapshot) - 1)),
      });
      return result;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function setClipProperties(clipId, properties) {
    if (typeof clipId !== 'string' || clipId.length === 0) {
      update({ error: 'a selected clip is required' });
      return null;
    }
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      update({ error: 'clip properties must be an object' });
      return null;
    }
    return apply({
      type: 'setClipProperties',
      clipIds: [clipId],
      properties,
    });
  }

  async function setTrackProperties(trackIndex, properties) {
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
      update({ error: 'a valid track index is required' });
      return null;
    }
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      update({ error: 'track properties must be an object' });
      return null;
    }
    const command = { type: 'setTrackProps', trackIndex };
    if (typeof properties.muted === 'boolean') command.muted = properties.muted;
    if (typeof properties.hidden === 'boolean') command.hidden = properties.hidden;
    if (typeof properties.syncLocked === 'boolean') command.syncLocked = properties.syncLocked;
    if (command.muted === undefined && command.hidden === undefined && command.syncLocked === undefined) {
      update({ error: 'no track property to change' });
      return null;
    }
    return apply(command);
  }

  function openPanel(panel) {
    const next = panel === 'export' || panel === 'settings' || panel === 'captions' || panel === 'library' || panel === 'motion' ? panel : 'editor';
    update({ panel: next });
    if (next === 'settings') void refreshSettings();
    if (next === 'library') void refreshLibrary();
    if (next === 'motion') void refreshMotion();
  }

  function closePanel() {
    update({ panel: 'editor' });
  }

  async function refreshSettings() {
    update({ settingsLoading: true, settings: state.settings });
    const [storage, search, transcribe, index] = await Promise.allSettled([
      client.invoke('storage_usage'),
      client.invoke('search_model_status'),
      client.invoke('transcribe_model_status'),
      client.invoke('search_index_status'),
    ]);
    const errors = [];
    function value(result) {
      if (result.status === 'fulfilled') return result.value;
      errors.push(errorMessage(result.reason));
      return null;
    }
    update({
      settingsLoading: false,
      settings: {
        storage: value(storage),
        search: value(search),
        transcribe: value(transcribe),
        searchIndex: value(index),
        error: errors.length > 0 ? errors[0] : null,
      },
    });
  }

  async function clearStorage(categories, { modelsConfirmed = false } = {}) {
    const list = Array.isArray(categories) ? categories.filter((category) => typeof category === 'string') : [];
    if (list.length === 0) return null;
    try {
      const usage = await client.invoke('storage_clear', { categories: list, modelsConfirmed: modelsConfirmed === true });
      update({
        settings: state.settings === null
          ? state.settings
          : { ...state.settings, storage: usage, error: null },
      });
      return usage;
    } catch (error) {
      update({ error: errorMessage(error) });
      return null;
    }
  }

  async function exportVideo(options = {}) {
    if (state.exportState.active) {
      update({ error: 'an export is already running' });
      return null;
    }
    const outPath = typeof options.outPath === 'string' ? options.outPath : '';
    if (outPath.length === 0) {
      update({ error: 'export requires an output path' });
      return null;
    }
    const codec = ['h264', 'h265', 'prores', 'prores4444'].includes(options.codec) ? options.codec : 'h264';
    const quality = ['720p', '1080p', '4k'].includes(options.quality) ? options.quality : '1080p';
    const req = {
      outPath,
      codec,
      quality,
      rangeStartFrame: Number.isInteger(options.rangeStartFrame) ? options.rangeStartFrame : null,
      rangeEndFrame: Number.isInteger(options.rangeEndFrame) ? options.rangeEndFrame : null,
      bitDepth: options.bitDepth === 10 ? 10 : 8,
      duckMusic: options.duckMusic === true,
      hdr10: options.hdr10 === true,
    };
    update({
      exportState: { active: true, phase: 'starting', done: 0, total: 0, error: null, summary: null },
    });
    exportTimer = setIntervalImpl(async () => {
      try {
        const status = await client.exportStatus();
        if (state.exportState.active && status !== null && typeof status === 'object') {
          update({
            exportState: {
              ...state.exportState,
              phase: status.active === false ? state.exportState.phase : 'running',
              done: Number.isFinite(Number(status.done)) ? Number(status.done) : state.exportState.done,
              total: Number.isFinite(Number(status.total)) ? Number(status.total) : state.exportState.total,
            },
          });
        }
      } catch {
        // The export request itself reports the authoritative failure.
      }
    }, 500);
    try {
      const summary = await client.invoke('export_video', { req, operationId: 'native-export' });
      update({
        exportState: { active: false, phase: 'complete', done: state.exportState.done, total: state.exportState.total, error: null, summary },
      });
      return summary;
    } catch (error) {
      update({
        exportState: {
          active: false,
          phase: 'error',
          done: state.exportState.done,
          total: state.exportState.total,
          error: errorMessage(error),
          summary: null,
        },
      });
      return null;
    } finally {
      if (exportTimer !== null) {
        clearIntervalImpl(exportTimer);
        exportTimer = null;
      }
    }
  }

  async function cancelExport() {
    try {
      return await client.invoke('cancel_export');
    } catch (error) {
      update({ error: errorMessage(error) });
      return null;
    }
  }

  async function refreshLuts() {
    update({ lutsLoading: true });
    try {
      const result = await client.listLuts();
      update({ luts: Array.isArray(result?.items) ? result.items : [], lutsLoading: false });
      return result;
    } catch (error) {
      update({ lutsLoading: false, error: errorMessage(error) });
      return null;
    }
  }

  async function uploadFile(file, { kind = 'media' } = {}) {
    update({ busy: true, error: null });
    try {
      const result = await client.uploadFile(file, { kind });
      if (kind === 'lut') {
        update({
          busy: false,
          luts: Array.isArray(result?.luts?.items) ? result.luts.items : state.luts,
          settings: state.settings,
        });
      } else {
        update({ busy: false, media: mediaItems(result?.catalog) });
      }
      return result;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function uploadFiles(files) {
    const list = Array.from(files ?? []).filter((file) => file !== null && typeof file === 'object');
    const results = [];
    for (const file of list) {
      const kind = typeof file.name === 'string' && file.name.toLowerCase().endsWith('.cube') ? 'lut' : 'media';
      const result = await uploadFile(file, { kind });
      if (result !== null) results.push(result);
    }
    return results;
  }

  async function refreshLibrary() {
    update({ libraryLoading: true });
    try {
      const entries = await client.libraryList(null);
      update({ library: Array.isArray(entries) ? entries : [], libraryLoading: false });
      return entries;
    } catch (error) {
      update({ libraryLoading: false, error: errorMessage(error) });
      return null;
    }
  }

  async function importLibraryEntry(id) {
    try {
      const result = await client.libraryImportToProject(id);
      await refresh();
      return result;
    } catch (error) {
      update({ error: errorMessage(error) });
      return null;
    }
  }

  async function refreshMotion() {
    update({ motionLoading: true });
    try {
      const documents = await client.motionDocuments();
      update({ motion: Array.isArray(documents) ? documents : [], motionLoading: false });
      return documents;
    } catch (error) {
      update({ motionLoading: false, error: errorMessage(error) });
      return null;
    }
  }

  async function createMotion(title = 'Untitled Motion') {
    try {
      const document = await client.motionCreate(title);
      await refreshMotion();
      return document;
    } catch (error) {
      update({ error: errorMessage(error) });
      return null;
    }
  }

  async function setColorGrade(clipId, grade) {
    if (grade !== null && (typeof grade !== 'object' || Array.isArray(grade))) {
      update({ error: 'color grade must be an object or null' });
      return null;
    }
    return apply({ type: 'setColorGrade', clipIds: [clipId], grade });
  }

  async function setLut(clipId, lut) {
    if (lut !== null && (typeof lut !== 'object' || Array.isArray(lut))) {
      update({ error: 'LUT reference must be an object or null' });
      return null;
    }
    return apply({ type: 'setLut', clipIds: [clipId], lut });
  }

  async function setChromaKey(clipId, chromaKey) {
    if (chromaKey !== null && (typeof chromaKey !== 'object' || Array.isArray(chromaKey))) {
      update({ error: 'chroma key must be an object or null' });
      return null;
    }
    return apply({ type: 'setChromaKey', clipIds: [clipId], chromaKey });
  }

  async function setTextStyle(clipId, textStyle) {
    if (textStyle === null || typeof textStyle !== 'object' || Array.isArray(textStyle)) {
      update({ error: 'text style must be an object' });
      return null;
    }
    return apply({ type: 'setClipProperties', clipIds: [clipId], properties: { textStyle } });
  }

  async function removeSelected() {
    const selected = findClip(state.timeline, state.selectedClipId);
    if (selected === null) {
      update({ error: 'select a clip before deleting it' });
      return null;
    }
    return apply({ type: 'removeClips', clipIds: [selected.clip.id] });
  }

  function setError(message) {
    update({ error: typeof message === 'string' ? message : String(message) });
  }

  async function setClipEffects(clipId, effects) {
    if (!Array.isArray(effects)) {
      update({ error: 'effects must be an array' });
      return null;
    }
    return apply({ type: 'setEffects', clipIds: [clipId], effects });
  }

  async function setClipMasks(clipId, masks) {
    if (!Array.isArray(masks)) {
      update({ error: 'masks must be an array' });
      return null;
    }
    return apply({ type: 'setMasks', clipIds: [clipId], masks });
  }

  async function upsertKeyframe(clipId, property, frame, value) {
    const frameNumber = Math.trunc(Number(frame));
    if (!Number.isInteger(frameNumber) || frameNumber < 0) {
      update({ error: 'keyframe frame must be a non-negative integer' });
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      update({ error: 'keyframe value must be a finite number' });
      return null;
    }
    return apply({
      type: 'upsertKeyframe',
      clipId,
      property,
      frame: frameNumber,
      value: { kind: 'scalar', value },
    });
  }

  async function removeKeyframe(clipId, property, frame) {
    const frameNumber = Math.trunc(Number(frame));
    if (!Number.isInteger(frameNumber) || frameNumber < 0) return null;
    return apply({ type: 'removeKeyframe', clipId, property, frame: frameNumber });
  }

  async function addCaption({ content, startFrame = 0, durationFrames = 60 } = {}) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length === 0) {
      update({ error: 'caption text must not be empty' });
      return null;
    }
    const start = Math.max(0, Math.trunc(Number(startFrame)) || 0);
    const duration = Math.max(1, Math.trunc(Number(durationFrames)) || 60);
    const group = `captions-native-${nextId('group').split('-').pop()}`;
    return apply({
      type: 'addCaptions',
      entries: [{
        startFrame: start,
        durationFrames: duration,
        content: text,
        captionGroupId: group,
        textStyle: {
          fontName: 'Helvetica-Bold', fontSize: 48, fontScale: 1,
          color: { r: 1, g: 1, b: 1, a: 1 }, alignment: 'center',
          shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 }, offsetX: 0, offsetY: 0, blur: 0 },
          background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 } },
          border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 } },
        },
        transform: { centerX: 0.5, centerY: 0.85, width: 0.9, height: 0.2, rotation: 0, flipHorizontal: false, flipVertical: false },
      }],
    });
  }

  async function updateCaption(clipId, { content, startFrame, durationFrames } = {}) {
    const selected = findClip(state.timeline, clipId);
    if (selected === null) {
      update({ error: 'caption clip not found' });
      return null;
    }
    const properties = {};
    if (typeof content === 'string') properties.textContent = content;
    if (Number.isFinite(Number(durationFrames))) properties.durationFrames = Math.max(1, Math.trunc(Number(durationFrames)));
    if (Object.keys(properties).length > 0) {
      const applied = await apply({ type: 'setClipProperties', clipIds: [clipId], properties });
      if (applied === null) return null;
    }
    if (Number.isFinite(Number(startFrame))) {
      return apply({
        type: 'moveClips',
        moves: [{ clipId, toTrack: selected.trackIndex, toFrame: Math.max(0, Math.trunc(Number(startFrame))) }],
      });
    }
    return null;
  }

  async function importMedia(paths) {
    const list = Array.isArray(paths) ? paths.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
    if (list.length === 0) {
      update({ error: 'enter one or more media paths to import' });
      return null;
    }
    update({ busy: true, error: null });
    try {
      const catalog = await client.importMedia(list);
      update({ busy: false, media: mediaItems(catalog) });
      return catalog;
    } catch (error) {
      update({ busy: false, error: errorMessage(error) });
      return null;
    }
  }

  async function play() {
    if (state.playback.active && state.playback.paused === false) return;
    try {
      const snapshot = state.timeline ?? {};
      await client.invoke('playback_start', {
        fromFrame: state.frame,
        identity: {
          projectEpoch: Number(snapshot.projectEpoch) || 0,
          timelineVersion: Number(snapshot.version) || 0,
          sessionId: 'route-b-native',
        },
      });
      update({ playback: { active: true, paused: false, frame: state.frame } });
      if (playbackTimer !== null) clearIntervalImpl(playbackTimer);
      playbackTimer = setIntervalImpl(async () => {
        try {
          const status = await client.playbackStatus();
          if (status === null || status.active !== true) {
            stopPlaybackTimer();
            update({ playback: { active: false, paused: true, frame: state.frame } });
            return;
          }
          const frame = Math.max(0, Math.trunc(Number(status.frame) || 0));
          update({ frame, playback: { active: true, paused: status.paused === true, frame } });
          if (status.terminal === true || status.active === false) {
            stopPlaybackTimer();
            update({ playback: { active: false, paused: true, frame } });
          }
        } catch {
          stopPlaybackTimer();
          update({ playback: { active: false, paused: true, frame: state.frame } });
        }
      }, 200);
    } catch (error) {
      update({ error: errorMessage(error) });
    }
  }

  function stopPlaybackTimer() {
    if (playbackTimer !== null) {
      clearIntervalImpl(playbackTimer);
      playbackTimer = null;
    }
  }

  async function pause() {
    stopPlaybackTimer();
    try {
      await client.invoke('playback_pause', { frame: state.frame });
    } catch (error) {
      update({ error: errorMessage(error) });
    }
    update({ playback: { active: state.playback.active, paused: true, frame: state.frame } });
  }

  async function seekTo(frame) {
    const value = Number.isFinite(Number(frame)) ? Math.trunc(Number(frame)) : 0;
    update({ frame: Math.max(0, value), playback: { ...state.playback, frame: Math.max(0, value) } });
    if (state.playback.active) {
      try {
        await client.invoke('playback_seek', { frame: Math.max(0, value) });
      } catch (error) {
        update({ error: errorMessage(error) });
      }
    }
  }

  async function stopPlayback() {
    stopPlaybackTimer();
    try {
      await client.invoke('playback_stop');
    } catch {
      // A stopped backend should still leave the local UI stopped.
    }
    update({ playback: { active: false, paused: false, frame: state.frame } });
  }

  function selectClip(clipId) {
    update({ selectedClipId: typeof clipId === 'string' && findClip(state.timeline, clipId) ? clipId : null });
  }

  function selectMedia(mediaId) {
    update({ selectedMediaId: typeof mediaId === 'string' && mediaItems(state.media).some((item) => item.id === mediaId) ? mediaId : null });
  }

  function setFrame(frame) {
    const value = Number.isFinite(Number(frame)) ? Math.trunc(Number(frame)) : 0;
    update({ frame: Math.min(Math.max(0, value), Math.max(0, totalFrames(state.timeline) - 1)) });
  }

  async function moveSelected(deltaFrames) {
    const selected = findClip(state.timeline, state.selectedClipId);
    if (selected === null) {
      update({ error: 'select a clip before moving it' });
      return null;
    }
    const delta = Math.trunc(Number(deltaFrames) || 0);
    if (delta === 0) return null;
    const toFrame = Math.max(0, Number(selected.clip.startFrame) + delta);
    return apply({
      type: 'moveClips',
      moves: [{
        clipId: selected.clip.id,
        toTrack: selected.trackIndex,
        toFrame,
      }],
    });
  }

  function setView(view) {
    update({ view: view === 'editor' ? 'editor' : 'home' });
  }

  function setLocale(nextLocale) {
    update(syncTranslatedLocale(nextLocale));
  }

  function setTheme(theme) {
    update({ theme: theme === 'light' || theme === 'dark' ? theme : 'system' });
  }

  function clearError() {
    update({ error: null });
  }

  function startPolling(intervalMs = state.pollIntervalMs) {
    stopPolling();
    const interval = Number(intervalMs);
    if (!Number.isFinite(interval) || interval < 250) return;
    update({ pollIntervalMs: interval });
    timer = setIntervalImpl(async () => {
      if (state.busy) return;
      try {
        const [timeline, media] = await Promise.all([client.timeline(), client.media()]);
        const meta = timelineMeta(timeline);
        update({
          timeline,
          media: mediaItems(media),
          projectPath: meta.projectPath,
          selectedClipId: findClip(timeline, state.selectedClipId) === null ? null : state.selectedClipId,
          frame: Math.min(state.frame, Math.max(0, totalFrames(timeline) - 1)),
        });
      } catch (error) {
        update({ error: errorMessage(error) });
      }
    }, interval);
  }

  function stopPolling() {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  function dispose() {
    stopPolling();
    if (exportTimer !== null) {
      clearIntervalImpl(exportTimer);
      exportTimer = null;
    }
    stopPlaybackTimer();
    listeners.clear();
  }

  const store = {
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize,
    refresh,
    newProject,
    openProject,
    saveProject,
    apply,
    undo: () => history('undo'),
    redo: () => history('redo'),
    selectClip,
    selectMedia,
    setClipProperties,
    setTrackProperties,
    setClipEffects,
    setClipMasks,
    refreshLuts,
    uploadFile,
    uploadFiles,
    refreshLibrary,
    importLibraryEntry,
    refreshMotion,
    createMotion,
    setColorGrade,
    setLut,
    setChromaKey,
    setTextStyle,
    removeSelected,
    setError,
    upsertKeyframe,
    removeKeyframe,
    addCaption,
    updateCaption,
    importMedia,
    play,
    pause,
    seekTo,
    stopPlayback,
    openPanel,
    closePanel,
    refreshSettings,
    clearStorage,
    exportVideo,
    cancelExport,
    setFrame,
    moveSelected,
    setView,
    setLocale,
    setTheme,
    clearError,
    startPolling,
    stopPolling,
    dispose,
    clipCount: () => clipCount(state.timeline),
    totalFrames: () => totalFrames(state.timeline),
  };
  return store;
}
