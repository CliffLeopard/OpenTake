import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEngineClient, EngineRequestError } from '../../../../web/src/native/ipc.js';
import { createTranslator } from '../../../../web/src/native/locale.js';
import {
  captionClips,
  createNativeEditorStore,
  evaluateScalarTrack,
  findClip,
  mediaItems,
  timelineTracks,
  totalFrames,
} from '../../../../web/src/native/store.js';
import { NATIVE_EDITOR_CSS } from '../../../../web/src/native/styles.js';
import { NativeEditorView, mountNativeEditor } from '../../../../web/src/native/index.js';
import { createNativeEditorController } from '../entry.js';

const SNAPSHOT = {
  timeline: {
    fps: 30,
    width: 1280,
    height: 720,
    tracks: [
      {
        id: 'video-track',
        type: 'video',
        clips: [
          { id: 'clip-1', mediaRef: 'media-1', startFrame: 10, durationFrames: 40 },
          { id: 'clip-2', mediaRef: 'media-2', startFrame: 60, durationFrames: 20 },
        ],
      },
    ],
  },
  projectEpoch: 1,
  version: 4,
  projectPath: '/tmp/demo.opentake',
};
const MEDIA = { items: [{ id: 'media-1', name: 'Interview', type: 'video', duration: 12.5 }, { id: 'media-2', name: 'Room tone', type: 'audio', duration: 8.2 }] };
const INFO = { pluginVersion: 'test', loaded: true };

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function makeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = String(url).split('?')[0];
    for (const [needle, handler] of Object.entries(routes)) {
      if (path.endsWith(needle)) {
        return typeof handler === 'function' ? handler({ url, init }) : jsonResponse(handler);
      }
    }
    if (path.endsWith('/engine/info')) return jsonResponse(INFO);
    if (path.endsWith('/engine/timeline')) return jsonResponse(SNAPSHOT);
    if (path.endsWith('/engine/media')) return jsonResponse(MEDIA);
    if (path.endsWith('/engine/apply')) return jsonResponse({ changed: true, actionName: 'Move Clips', timelineVersion: 5 });
    if (path.endsWith('/engine/export/status')) return jsonResponse({ active: false, done: 120, total: 120, operationId: 'native-export' });
    if (path.endsWith('/engine/playback/status')) return jsonResponse({ active: true, paused: false, frame: 7, terminal: false, fps: 30 });
    if (path.endsWith('/engine/import-media')) return jsonResponse({ items: [...MEDIA.items, { id: 'media-3', name: 'Imported', type: 'image', duration: 1 }] });
    if (path.endsWith('/engine/luts')) return jsonResponse({ items: [{ id: 'b'.repeat(64), name: 'Project LUT', bytes: 2048, intensity: 1 }], projectPath: '/tmp/demo.opentake' });
    if (path.endsWith('/engine/upload')) {
      const requestUrl = new URL(url, 'http://localhost');
      if (requestUrl.searchParams.get('kind') === 'lut') return jsonResponse({ kind: 'lut', lut: { id: 'c'.repeat(64), name: 'Uploaded LUT', intensity: 1 }, luts: { items: [{ id: 'c'.repeat(64), name: 'Uploaded LUT', bytes: 4096, intensity: 1 }] } });
      return jsonResponse({ kind: 'media', catalog: { items: [...MEDIA.items, { id: 'uploaded', name: 'Uploaded', type: 'image', duration: 1 }] } });
    }
    if (path.endsWith('/engine/invoke')) {
      let payload = {};
      try { payload = JSON.parse(init.body); } catch { payload = {}; }
      const { cmd, args = {} } = payload;
      if (cmd === 'storage_usage') return jsonResponse({ totalBytes: 2048, cacheRoot: '/tmp/cache', categories: [{ id: 'thumbnails', bytes: 1024, path: '/tmp/cache' }, { id: 'other', bytes: 1024, path: '/tmp/cache' }] });
      if (cmd === 'storage_clear') return jsonResponse({ totalBytes: 0, cacheRoot: '/tmp/cache', categories: [] });
      if (cmd === 'search_model_status') return jsonResponse({ visualAvailable: false, model: 'siglip2', detail: 'model_not_installed' });
      if (cmd === 'transcribe_model_status') return jsonResponse({ installed: false, model: '', bytes: 0 });
      if (cmd === 'search_index_status') return jsonResponse({ ready: false, indexed: 0 });
      if (cmd === 'export_video') return jsonResponse({ outputFile: args.req?.outPath ?? '/tmp/out.mp4', fps: 30, durationFrames: 120 });
      if (cmd === 'cancel_export') return jsonResponse(null);
      if (cmd === 'playback_start' || cmd === 'playback_pause' || cmd === 'playback_seek' || cmd === 'playback_stop') return jsonResponse(null);
      if (cmd === 'library_list') return jsonResponse([{ id: 'lib-1', name: 'Library clip', kind: 'video' }]);
      if (cmd === 'library_import_to_project') return jsonResponse({ id: 'media-4', name: 'Library clip' });
      if (cmd === 'motion_document_list') return jsonResponse([{ id: 'motion-1', title: 'Title', revisionHash: 'a'.repeat(64) }]);
      if (cmd === 'motion_document_create') return jsonResponse({ summary: { id: 'motion-2', title: args.request?.title ?? 'Untitled' } });
      if (cmd === 'motion_document_read') return jsonResponse({ summary: { id: 'motion-1', title: 'Title' }, html: '<main></main>', css: '' });
      return jsonResponse({ error: { code: 'unknown-command', message: `mock invoke ${cmd}` } }, 400);
    }
    if (path.endsWith('/engine/undo')) return jsonResponse({ changed: true, actionName: 'Undo' });
    if (path.endsWith('/engine/redo')) return jsonResponse({ changed: true, actionName: 'Redo' });
    if (path.endsWith('/engine/new')) return jsonResponse(SNAPSHOT);
    if (path.endsWith('/engine/open')) return jsonResponse(SNAPSHOT);
    if (path.endsWith('/engine/save')) return jsonResponse({ path: '/tmp/demo.opentake' });
    return jsonResponse({ error: { code: 'not-found', message: `route ${path}` } }, 404);
  };
  return { fetchImpl, calls };
}

function makeDocument() {
  const nodes = [];
  function element(tagName) {
    const node = {
      tagName,
      style: {},
      children: [],
      attributes: {},
      className: '',
      textContent: '',
      parentNode: null,
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      get firstChild() { return node.children[0] ?? null; },
    };
    nodes.push(node);
    return node;
  }
  return { document: { createElement: element, head: element('head'), body: element('body') }, nodes };
}

function makeHost() {
  const { document, nodes } = makeDocument();
  const shadowRoot = {
    children: [],
    appendChild(node) { node.parentNode = shadowRoot; shadowRoot.children.push(node); return node; },
    removeChild(node) { const index = shadowRoot.children.indexOf(node); if (index >= 0) shadowRoot.children.splice(index, 1); node.parentNode = null; return node; },
    get firstChild() { return shadowRoot.children[0] ?? null; },
  };
  const host = {
    ownerDocument: document,
    shadowRoot: null,
    attachShadow(options) {
      assert.equal(options.mode, 'open');
      host.shadowRoot = shadowRoot;
      return shadowRoot;
    },
  };
  return { host, document, nodes, shadowRoot };
}

function fakeReact() {
  const elements = [];
  return {
    elements,
    createElement(type, props, ...children) {
      const element = { type, props: { ...props, children } };
      elements.push(element);
      return element;
    },
  };
}

function fakeReactDom() {
  const roots = [];
  return {
    roots,
    createRoot(container) {
      const root = {
        container,
        element: null,
        unrendered: false,
        render(element) { root.element = element; },
        unmount() { root.unrendered = true; },
      };
      roots.push(root);
      return root;
    },
  };
}

test('engine client uses the existing /engine routes and JSON shape', async () => {
  const { fetchImpl, calls } = makeFetch();
  const client = createEngineClient({ base: '/opentake-studio-route-b/', fetchImpl });
  await client.info();
  await client.timeline();
  await client.media();
  await client.openProject('/tmp/demo.opentake');
  await client.saveProject('/tmp/saved.opentake');
  await client.apply({ type: 'moveClips', moves: [{ clipId: 'clip-1', toTrack: 0, toFrame: 12 }] });
  await client.undo();
  await client.redo();
  assert.deepEqual(calls.map((call) => new URL(call.url, 'http://localhost').pathname), [
    '/opentake-studio-route-b/engine/info',
    '/opentake-studio-route-b/engine/timeline',
    '/opentake-studio-route-b/engine/media',
    '/opentake-studio-route-b/engine/open',
    '/opentake-studio-route-b/engine/save',
    '/opentake-studio-route-b/engine/apply',
    '/opentake-studio-route-b/engine/undo',
    '/opentake-studio-route-b/engine/redo',
  ]);
  assert.equal(calls[3].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[3].init.body), { path: '/tmp/demo.opentake' });
  assert.deepEqual(JSON.parse(calls[5].init.body), { command: { type: 'moveClips', moves: [{ clipId: 'clip-1', toTrack: 0, toFrame: 12 }] } });
  assert.equal(client.previewUrl(12, { revision: 3 }), '/opentake-studio-route-b/engine/preview/frame?frame=12&format=png&rev=3');
  assert.equal(client.assetUrl('/tmp/a b.png'), '/opentake-studio-route-b/engine/asset?path=%2Ftmp%2Fa%20b.png');
  assert.throws(() => client.openProject('  '), TypeError);
});

test('engine errors are normalized for the UI', async () => {
  const fetchImpl = async () => jsonResponse({ error: { code: 'engine-error', message: 'engine offline' } }, 500);
  const client = createEngineClient({ fetchImpl });
  await assert.rejects(client.timeline(), (error) => {
    assert.equal(error instanceof EngineRequestError, true);
    assert.equal(error.code, 'engine-error');
    assert.equal(error.message, 'engine offline');
    return true;
  });
  const badJson = createEngineClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  await assert.rejects(badJson.info(), (error) => error.code === 'engine-invalid-json');
});

test('store initializes, opens a project, selects/moves a clip and refreshes', async () => {
  const { fetchImpl, calls } = makeFetch();
  const timers = [];
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    locale: 'zh-CN',
    setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalImpl: () => {},
  });
  assert.equal(store.getSnapshot().ready, false);
  await store.initialize();
  let state = store.getSnapshot();
  assert.equal(state.ready, true);
  assert.equal(state.view, 'home');
  assert.equal(state.locale, 'zh');
  assert.equal(state.media.length, 2);
  assert.equal(state.projectPath, '/tmp/demo.opentake');
  assert.equal(state.engine.loaded, true);

  await store.newProject();
  state = store.getSnapshot();
  assert.equal(state.view, 'editor');
  assert.equal(state.revision, 1);
  assert.equal(timelineTracks(state.timeline).length, 1);
  assert.equal(totalFrames(state.timeline), 80);
  assert.equal(findClip(state.timeline, 'clip-1').trackIndex, 0);

  store.selectClip('clip-1');
  store.selectMedia('media-1');
  assert.equal(store.getSnapshot().selectedClipId, 'clip-1');
  assert.equal(store.getSnapshot().selectedMediaId, 'media-1');
  await store.moveSelected(-2);
  const moveCall = calls.filter((call) => call.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(moveCall.init.body), {
    command: { type: 'moveClips', moves: [{ clipId: 'clip-1', toTrack: 0, toFrame: 8 }] },
  });
  assert.equal(store.getSnapshot().revision, 2);

  store.setFrame(999);
  assert.equal(store.getSnapshot().frame, 79);
  await store.undo();
  assert.equal(store.getSnapshot().revision, 3);

  store.startPolling(1000);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  store.stopPolling();
  store.dispose();
  assert.equal(store.getSnapshot().locale, 'zh');
});

test('store surfaces engine failures without losing the previous timeline', async () => {
  const { fetchImpl } = makeFetch({
    '/engine/apply': () => jsonResponse({ error: { code: 'invalid-input', message: 'bad command' } }, 400),
  });
  const store = createNativeEditorStore({ client: createEngineClient({ fetchImpl }) });
  await store.initialize();
  const previous = store.getSnapshot().timeline;
  store.selectClip('clip-1');
  await store.moveSelected(1);
  assert.equal(store.getSnapshot().timeline, previous);
  assert.match(store.getSnapshot().error, /bad command/);
  store.clearError();
  assert.equal(store.getSnapshot().error, null);
});

test('locale translator is isolated and falls back safely', () => {
  const en = createTranslator('en-US');
  const zh = createTranslator('zh-CN');
  assert.equal(en.locale, 'en');
  assert.equal(zh.locale, 'zh');
  assert.equal(en.t('home'), 'Home');
  assert.equal(zh.t('home'), '主页');
  assert.equal(en.t('mediaCount', { count: 3 }), '3 items');
  assert.equal(zh.t('mediaCount', { count: 3 }), '3 个素材');
  assert.equal(createTranslator('fr').t('home'), 'Home');
  assert.equal(en.t('missing.key'), 'missing.key');
});

test('CSS is ShadowRoot-scoped and does not style the DSH page', () => {
  assert.match(NATIVE_EDITOR_CSS, /:host\s*\{/);
  assert.match(NATIVE_EDITOR_CSS, /\.otn-root/);
  assert.doesNotMatch(NATIVE_EDITOR_CSS, /(^|\})\s*(html|body|#root)\s*\{/i);
  assert.doesNotMatch(NATIVE_EDITOR_CSS, /@import|url\s*\(/i);
});

test('mount creates a ShadowRoot, injects scoped CSS and renders through external React', async () => {
  const { host, document, nodes, shadowRoot } = makeHost();
  const React = fakeReact();
  const ReactDOM = fakeReactDom();
  const { fetchImpl } = makeFetch();
  const controller = mountNativeEditor({
    host,
    React,
    ReactDOM,
    client: createEngineClient({ fetchImpl }),
    locale: 'zh-CN',
    theme: 'dark',
    autoInitialize: false,
  });
  assert.equal(host.shadowRoot, shadowRoot);
  assert.equal(shadowRoot.children.length, 2);
  assert.equal(shadowRoot.children[0].tagName, 'style');
  assert.match(shadowRoot.children[0].textContent, /\.otn-root/);
  assert.equal(shadowRoot.children[1].tagName, 'div');
  assert.equal(ReactDOM.roots.length, 1);
  assert.equal(ReactDOM.roots[0].element.type, NativeEditorView);
  assert.equal(ReactDOM.roots[0].element.props.React, React);
  assert.equal(controller.store.getSnapshot().locale, 'zh');
  assert.equal(document.head.children.length, 0);
  assert.equal(document.body.children.length, 0);
  assert.equal(nodes.some((node) => node.tagName === 'head' && node.children.length > 0), false);

  await controller.ready;
  controller.unmount();
  assert.equal(ReactDOM.roots[0].unrendered, true);
  assert.equal(shadowRoot.children.length, 0);
  controller.unmount();
});

test('entry controller aborts its client signal and owns one mount lifecycle', async () => {
  const { host } = makeHost();
  const React = fakeReact();
  const ReactDOM = fakeReactDom();
  const signals = [];
  const { fetchImpl } = makeFetch();
  const controller = createNativeEditorController({
    host,
    React,
    ReactDOM,
    fetchImpl: (url, init) => { signals.push(init.signal); return fetchImpl(url, init); },
    autoInitialize: true,
  });
  assert.equal(host.shadowRoot.children.length, 2);
  await controller.ready;
  assert.equal(signals.length, 3);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
  assert.equal(signals.some((signal) => signal.aborted), false);
  controller.dispose();
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(host.shadowRoot.children.length, 0);
  assert.equal(ReactDOM.roots[0].unrendered, true);
  controller.dispose();
});

test('media/tracks helpers tolerate completed and empty snapshots', () => {
  assert.deepEqual(mediaItems(MEDIA), MEDIA.items);
  assert.deepEqual(mediaItems({ items: null }), []);
  assert.deepEqual(timelineTracks({ timeline: { tracks: null } }), []);
  assert.equal(totalFrames({ timeline: { tracks: [] } }), 1);
});

test('served native bundle exists and is a production self-contained module', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundlePath = path.resolve(here, '../../web/native-editor/native-editor.js');
  assert.equal(fs.existsSync(bundlePath), true, 'run build-bundle.mjs before this test');
  const source = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(source.length > 200_000, 'bundle includes React and ReactDOM');
  assert.match(source, /mountNative/);
  assert.match(source, /createRoot/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /__TAURI_INTERNALS__/);
  assert.doesNotMatch(source, /@tauri-apps/);
});

test('native inspector and track edits use the exact engine apply commands', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.initialize();
  store.selectClip('clip-1');
  await store.setClipProperties('clip-1', {
    opacity: 0.5,
    volume: 0.4,
    transform: { centerX: 0.5, centerY: 0.5, width: 0.8, height: 0.8, rotation: 12, flipHorizontal: false, flipVertical: false },
  });
  const clipCall = calls.filter((call) => call.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(clipCall.init.body), {
    command: {
      type: 'setClipProperties',
      clipIds: ['clip-1'],
      properties: {
        opacity: 0.5,
        volume: 0.4,
        transform: { centerX: 0.5, centerY: 0.5, width: 0.8, height: 0.8, rotation: 12, flipHorizontal: false, flipVertical: false },
      },
    },
  });
  await store.setTrackProperties(0, { muted: true, hidden: false });
  const trackCall = calls.filter((call) => call.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(trackCall.init.body), {
    command: { type: 'setTrackProps', trackIndex: 0, muted: true, hidden: false },
  });
});

test('native export sends the existing invoke request shape and exposes progress state', async () => {
  const { fetchImpl, calls } = makeFetch();
  const timers = [];
  const cleared = [];
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalImpl: (id) => { cleared.push(id); },
  });
  await store.initialize();
  const summary = await store.exportVideo({
    outPath: '/tmp/native-export.mp4',
    codec: 'h265',
    quality: '4k',
    bitDepth: 10,
    rangeStartFrame: 3,
    rangeEndFrame: 99,
    duckMusic: true,
    hdr10: true,
  });
  assert.equal(summary.outputFile, '/tmp/native-export.mp4');
  const exportCall = calls.find((call) => call.url.endsWith('/engine/invoke'));
  assert.deepEqual(JSON.parse(exportCall.init.body), {
    cmd: 'export_video',
    args: {
      operationId: 'native-export',
      req: {
        outPath: '/tmp/native-export.mp4',
        codec: 'h265',
        quality: '4k',
        rangeStartFrame: 3,
        rangeEndFrame: 99,
        bitDepth: 10,
        duckMusic: true,
        hdr10: true,
      },
    },
  });
  assert.equal(store.getSnapshot().exportState.active, false);
  assert.equal(store.getSnapshot().exportState.phase, 'complete');
  assert.equal(timers.length, 1);
  assert.equal(cleared.length, 1);
});

test('native settings loads storage/model status and clears a cache category', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.refreshSettings();
  const settings = store.getSnapshot().settings;
  assert.equal(settings.storage.totalBytes, 2048);
  assert.equal(settings.search.visualAvailable, false);
  assert.equal(settings.transcribe.installed, false);
  assert.deepEqual(settings.searchIndex, { ready: false, indexed: 0 });
  const commands = calls.filter((call) => call.url.endsWith('/engine/invoke')).map((call) => JSON.parse(call.init.body).cmd);
  assert.deepEqual(commands, ['storage_usage', 'search_model_status', 'transcribe_model_status', 'search_index_status']);
  await store.clearStorage(['thumbnails']);
  const clearCall = calls.filter((call) => call.url.endsWith('/engine/invoke')).at(-1);
  assert.deepEqual(JSON.parse(clearCall.init.body), { cmd: 'storage_clear', args: { categories: ['thumbnails'], modelsConfirmed: false } });
  assert.equal(store.getSnapshot().settings.storage.totalBytes, 0);
});

test('native locale dictionaries keep inspector/export/settings keys in parity', async () => {
  const { TRANSLATIONS } = await import('../../../../web/src/native/locale.js');
  assert.deepEqual(Object.keys(TRANSLATIONS.en).sort(), Object.keys(TRANSLATIONS.zh).sort());
  for (const key of ['inspector', 'export', 'settings', 'opacity', 'volume', 'positionX', 'hdr10', 'storage', 'searchModel']) {
    assert.equal(typeof TRANSLATIONS.en[key], 'string', key);
    assert.equal(typeof TRANSLATIONS.zh[key], 'string', key);
  }
});

test('native effects, masks and keyframes use the exact engine commands', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.initialize();
  await store.setClipEffects('clip-1', [{ name: 'grayscale', params: { amount: 0.5 }, enabled: true }]);
  let call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), {
    command: { type: 'setEffects', clipIds: ['clip-1'], effects: [{ name: 'grayscale', params: { amount: 0.5 }, enabled: true }] },
  });

  await store.setClipMasks('clip-1', [{ shape: { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: { x: 0.3, y: 0.3 } }, feather: 0.1, invert: true }]);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), {
    command: {
      type: 'setMasks',
      clipIds: ['clip-1'],
      masks: [{ shape: { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: { x: 0.3, y: 0.3 } }, feather: 0.1, invert: true }],
    },
  });

  await store.upsertKeyframe('clip-1', 'opacity', 12, 0.4);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), {
    command: { type: 'upsertKeyframe', clipId: 'clip-1', property: 'opacity', frame: 12, value: { kind: 'scalar', value: 0.4 } },
  });

  await store.removeKeyframe('clip-1', 'opacity', 12);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), {
    command: { type: 'removeKeyframe', clipId: 'clip-1', property: 'opacity', frame: 12 },
  });
});

test('native captions create and update through addCaptions/setClipProperties/moveClips', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.initialize();
  await store.addCaption({ content: 'Hello caption', startFrame: 10, durationFrames: 40 });
  const addCall = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  const command = JSON.parse(addCall.init.body).command;
  assert.equal(command.type, 'addCaptions');
  assert.equal(command.entries[0].content, 'Hello caption');
  assert.equal(command.entries[0].startFrame, 10);
  assert.equal(command.entries[0].durationFrames, 40);
  assert.match(command.entries[0].captionGroupId, /^captions-native-/);
  assert.equal(typeof command.entries[0].textStyle.fontName, 'string');
  assert.equal(command.entries[0].transform.centerY, 0.85);

  await store.updateCaption('clip-1', { content: 'Updated', startFrame: 5, durationFrames: 20 });
  const applied = calls.filter((entry) => entry.url.endsWith('/engine/apply')).slice(-2);
  assert.equal(JSON.parse(applied[0].init.body).command.type, 'setClipProperties');
  assert.equal(JSON.parse(applied[0].init.body).command.properties.durationFrames, 20);
  assert.equal(JSON.parse(applied[1].init.body).command.type, 'moveClips');
  assert.equal(JSON.parse(applied[1].init.body).command.moves[0].toFrame, 5);
});

test('native media import and playback commands use live engine routes', async () => {
  const { fetchImpl, calls } = makeFetch();
  const timers = [];
  const cleared = [];
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalImpl: (id) => { cleared.push(id); },
  });
  await store.initialize();
  const catalog = await store.importMedia(['/tmp/import-me.png']);
  assert.equal(catalog.items.length, 3);
  assert.equal(store.getSnapshot().media.length, 3);
  const importCall = calls.find((entry) => entry.url.endsWith('/engine/import-media'));
  assert.deepEqual(JSON.parse(importCall.init.body), { paths: ['/tmp/import-me.png'] });

  await store.seekTo(7);
  await store.play();
  assert.equal(timers.length, 1);
  const startCall = calls.find((entry) => entry.url.endsWith('/engine/invoke') && JSON.parse(entry.init.body).cmd === 'playback_start');
  assert.equal(JSON.parse(startCall.init.body).args.fromFrame, 7);
  await timers[0].fn();
  assert.equal(store.getSnapshot().frame, 7);
  assert.equal(store.getSnapshot().playback.active, true);
  await store.pause();
  assert.equal(store.getSnapshot().playback.paused, true);
  store.dispose();
});

test('native LUT upload/picker, media upload, library and motion surfaces use live routes', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.initialize();
  const luts = await store.refreshLuts();
  assert.equal(luts.items[0].name, 'Project LUT');
  assert.equal(store.getSnapshot().luts.length, 1);

  const file = { name: 'look.cube', arrayBuffer: async () => new Uint8Array([1, 2, 3]) };
  const uploaded = await store.uploadFile(file, { kind: 'lut' });
  assert.equal(uploaded.lut.id, 'c'.repeat(64));
  assert.equal(store.getSnapshot().luts[0].name, 'Uploaded LUT');
  const uploadCall = calls.find((entry) => entry.url.includes('/engine/upload'));
  assert.match(uploadCall.url, /name=look\.cube/);
  assert.match(uploadCall.url, /kind=lut/);

  await store.refreshLibrary();
  assert.equal(store.getSnapshot().library[0].name, 'Library clip');
  await store.importLibraryEntry('lib-1');
  assert.equal(store.getSnapshot().media.length, 2);

  await store.refreshMotion();
  assert.equal(store.getSnapshot().motion[0].title, 'Title');
  await store.createMotion('New title');
  assert.equal(store.getSnapshot().motion[0].title, 'Title');
});

test('caption/keyframe helpers tolerate empty and interpolate scalar tracks', () => {
  assert.deepEqual(captionClips({ timeline: { tracks: [] } }), []);
  const snapshot = {
    timeline: {
      tracks: [{
        clips: [
          { id: 'text-1', captionGroupId: 'g1', textContent: 'Hi' },
          { id: 'video-1' },
        ],
      }],
    },
  };
  assert.deepEqual(captionClips(snapshot).map((entry) => entry.clip.id), ['text-1']);
  const track = { keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] };
  assert.equal(evaluateScalarTrack(track, 5), 0.5);
  assert.equal(evaluateScalarTrack(track, -1), 0);
  assert.equal(evaluateScalarTrack(track, 20), 1);
  assert.equal(evaluateScalarTrack({ keyframes: [] }, 0), null);
});

test('advanced inspector uses color grade/LUT/chroma/text and remove commands', async () => {
  const { fetchImpl, calls } = makeFetch();
  const store = createNativeEditorStore({
    client: createEngineClient({ fetchImpl }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await store.initialize();
  const grade = {
    exposure: 0.5, temperature: 0.1, tint: -0.1, contrast: 0.2, saturation: 1.2,
    liftGammaGain: { lift: { r: 0, g: 0, b: 0 }, gamma: { r: 1, g: 1, b: 1 }, gain: { r: 1, g: 1, b: 1 } },
    hslSecondary: null,
  };
  await store.setColorGrade('clip-1', grade);
  let call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), { command: { type: 'setColorGrade', clipIds: ['clip-1'], grade } });

  const lut = { id: 'a'.repeat(64), name: 'Test LUT', intensity: 0.8 };
  await store.setLut('clip-1', lut);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), { command: { type: 'setLut', clipIds: ['clip-1'], lut } });

  const chroma = { keyColor: { r: 0, g: 1, b: 0 }, similarity: 0.2, smoothness: 0.3, spill: 0.5 };
  await store.setChromaKey('clip-1', chroma);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), { command: { type: 'setChromaKey', clipIds: ['clip-1'], chromaKey: chroma } });

  const textStyle = { fontName: 'Helvetica-Bold', fontSize: 42, fontScale: 1, alignment: 'center' };
  await store.setTextStyle('clip-1', textStyle);
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), { command: { type: 'setClipProperties', clipIds: ['clip-1'], properties: { textStyle } } });

  store.selectClip('clip-1');
  await store.removeSelected();
  call = calls.filter((entry) => entry.url.endsWith('/engine/apply')).at(-1);
  assert.deepEqual(JSON.parse(call.init.body), { command: { type: 'removeClips', clipIds: ['clip-1'] } });
});
