/**
 * Self-contained browser entry for the native editor.
 *
 * This file is bundled into a single ES module served by the Host at
 * `/opentake-studio-route-b/app/native-editor/native-editor.js`. React and
 * ReactDOM are bundled into that artifact so the DSH client shell can load it
 * without importing a second copy of React or depending on a module table
 * beyond the shell's own React.
 *
 * The bundle exports `mountNative({host, ...})`; the shell calls it only when
 * the user switches the editor body to native, and calls `dispose()` when
 * switching back or unmounting the panel.
 */

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createEngineClient } from './ipc.js';
import { mountNativeEditor } from './mount.js';

export const BUNDLE_PATH = '/opentake-studio-route-b/app/native-editor/native-editor.js';

export function mountNative({
  host,
  base = '/opentake-studio-route-b',
  locale = 'en',
  theme = 'system',
  pollIntervalMs = 0,
  fetchImpl = globalThis.fetch,
  timers = undefined,
  autoInitialize = true,
  onReady = undefined,
} = {}) {
  if (typeof AbortController !== 'function') throw new Error('AbortController is required');
  const abortController = new AbortController();
  const client = createEngineClient({ base, fetchImpl, signal: abortController.signal });
  let mounted;
  try {
    mounted = mountNativeEditor({
      host,
      React,
      ReactDOM: { createRoot },
      client,
      locale,
      theme,
      pollIntervalMs,
      timers,
      autoInitialize,
      onReady,
    });
  } catch (error) {
    abortController.abort();
    throw error;
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    abortController.abort();
    mounted.dispose();
  }
  return {
    ...mounted,
    client,
    dispose,
    unmount: dispose,
  };
}

export { React, createRoot, mountNativeEditor, createEngineClient };
