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
    exportState: {
      active: false,
      phase: 'idle',
      done: 0,
      total: 0,
      error: null,
      summary: null,
    },
  };
  const listeners = new Set();
  let timer = null;
  let exportTimer = null;

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
    const next = panel === 'export' || panel === 'settings' ? panel : 'editor';
    update({ panel: next });
    if (next === 'settings') void refreshSettings();
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
