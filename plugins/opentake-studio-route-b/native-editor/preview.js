/**
 * Browser-only harness for the native editor prototype.
 *
 * Run from the repository root with a static server, for example:
 *   python3 -m http.server 8765
 * and open /plugins/opentake-studio-route-b/native-editor/preview.html
 *
 * This harness uses the real React 18 UMD builds from web/node_modules and the
 * real native source modules. It mocks only the engine fetch layer because a
 * static file server cannot expose the DSH Host /engine routes. The integrated
 * path uses the same client with `base='/opentake-studio-route-b'`.
 */

import { createEngineClient } from '../../../web/src/native/ipc.js';
import { mountNativeEditor } from '../../../web/src/native/mount.js';

const snapshot = {
  timeline: {
    fps: 30,
    width: 1280,
    height: 720,
    tracks: [
      {
        id: 'track-video-1',
        type: 'video',
        clips: [
          { id: 'clip-1', mediaRef: 'media-1', startFrame: 0, durationFrames: 120 },
          { id: 'clip-2', mediaRef: 'media-2', startFrame: 130, durationFrames: 90 },
        ],
      },
      { id: 'track-audio-1', type: 'audio', clips: [{ id: 'clip-3', mediaRef: 'media-2', startFrame: 0, durationFrames: 220 }] },
    ],
  },
  projectEpoch: 1,
  version: 3,
  projectPath: '/tmp/opentake-native-demo.opentake',
};
const media = {
  items: [
    { id: 'media-1', name: 'Opening interview', type: 'video', duration: 12.5 },
    { id: 'media-2', name: 'Room tone', type: 'audio', duration: 8.2 },
    { id: 'media-3', name: 'Title still', type: 'image', duration: 4 },
  ],
};

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

window.fetch = async (url, init = {}) => {
  const path = String(url).split('?')[0];
  if (path.endsWith('/engine/info')) {
    return jsonResponse({ pluginVersion: 'native-preview', platform: 'darwin', arch: 'arm64', node: '22', napi: '9', loaded: true });
  }
  if (path.endsWith('/engine/timeline')) return jsonResponse(snapshot);
  if (path.endsWith('/engine/media')) return jsonResponse(media);
  if (path.endsWith('/engine/new') || path.endsWith('/engine/open')) return jsonResponse(snapshot);
  if (path.endsWith('/engine/apply')) {
    let command = null;
    try { command = JSON.parse(init.body).command; } catch { /* handled below */ }
    if (command?.type === 'moveClips') {
      const move = command.moves?.[0];
      for (const track of snapshot.timeline.tracks) {
        const clip = track.clips.find((entry) => entry.id === move?.clipId);
        if (clip) clip.startFrame = move.toFrame;
      }
      snapshot.version += 1;
    }
    return jsonResponse({ changed: true, actionName: 'Move Clips', summary: 'moved', timelineVersion: snapshot.version });
  }
  if (path.endsWith('/engine/undo') || path.endsWith('/engine/redo')) {
    return jsonResponse({ changed: true, actionName: 'History', timelineVersion: snapshot.version });
  }
  if (path.endsWith('/engine/save')) return jsonResponse({ path: snapshot.projectPath });
  return jsonResponse({ error: { code: 'not-found', message: `mock route: ${path}` } }, 404);
};

const client = createEngineClient({ base: '', fetchImpl: window.fetch });
// A static harness has no engine compositor; use a visible SVG placeholder.
client.previewUrl = (frame) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="#171a21"/><text x="640" y="350" fill="#7c5cff" font-size="42" font-family="sans-serif" text-anchor="middle">Preview frame ${frame}</text><text x="640" y="400" fill="#a6acb8" font-size="18" font-family="sans-serif" text-anchor="middle">native mount · mocked /engine routes</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};
client.assetUrl = () => null;

const host = document.getElementById('native-host');
const controller = mountNativeEditor({
  host,
  React: window.React,
  ReactDOM: window.ReactDOM,
  client,
  locale: 'en',
  theme: 'system',
  autoInitialize: true,
  onReady: (state) => { window.__nativeDemoReady = state.view; },
});
const query = new URLSearchParams(window.location.search);
if (query.get('view') === 'editor') controller.store.setView('editor');
if (query.get('theme') === 'light' || query.get('theme') === 'dark') {
  controller.store.setTheme(query.get('theme'));
}
window.__nativeDemo = controller;
