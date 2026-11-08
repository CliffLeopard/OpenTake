import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEngineClient, EngineRequestError } from '../../../../web/src/native/ipc.js';
import { createTranslator } from '../../../../web/src/native/locale.js';
import {
  createNativeEditorStore,
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
