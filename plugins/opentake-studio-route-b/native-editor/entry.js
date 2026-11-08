/**
 * Prototype native-editor entry module.
 *
 * This is the source-side entry the future DSH client bundle will import. It is
 * intentionally not wired into `client.js` yet: the existing iframe shell stays
 * the active editor body until the native mount is accepted. A client-bundle
 * integration should:
 *
 *   1. bundle this module and `web/src/native/**` with React externalized;
 *   2. keep the iframe slot as the default/fallback;
 *   3. mount this only on an explicit "Native preview" action (or behind a
 *      feature flag), reusing the same base route;
 *   4. import React from the DSH module table and pass a ReactDOM-client
 *      implementation available to the client bundle.
 */

import { createEngineClient } from '../../../web/src/native/ipc.js';
import { mountNativeEditor } from '../../../web/src/native/mount.js';

/**
 * Create one native editor controller for an already-created host element.
 * The controller owns the client's AbortSignal and the React/ShadowRoot
 * lifetime; call `dispose()` to abort in-flight requests and unmount.
 */
export function createNativeEditorController({
  host,
  React,
  ReactDOM,
  base = '/opentake-studio-route-b',
  locale = 'en',
  theme = 'system',
  pollIntervalMs = 0,
  fetchImpl = globalThis.fetch,
  timers = undefined,
  autoInitialize = true,
  onReady = undefined,
} = {}) {
  if (typeof AbortController !== 'function') {
    throw new Error('AbortController is required for native editor lifecycle');
  }
  const abortController = new AbortController();
  const client = createEngineClient({ base, fetchImpl, signal: abortController.signal });
  let mounted;
  try {
    mounted = mountNativeEditor({
      host,
      React,
      ReactDOM,
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
  return {
    ...mounted,
    client,
    dispose() {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      mounted.dispose();
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      mounted.unmount();
    },
  };
}

/** Kept as a named alias so a client bundle can import only the mount path. */
export { mountNativeEditor, createEngineClient };
