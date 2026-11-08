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
  };
  const listeners = new Set();
  let timer = null;

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
