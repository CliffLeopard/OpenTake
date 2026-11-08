/**
 * Native editor mount contract.
 *
 * The caller owns the host element and supplies the external React +
 * ReactDOM-client implementations. This module creates an open ShadowRoot,
 * injects scoped CSS there, renders the native view into it and returns a
 * controller whose `unmount()` disposes subscriptions/polling and the React
 * root. It never writes to `document`, the DSH page's `<head>`, or another
 * plugin's DOM.
 */

import { NativeEditorView } from './components.js';
import { createNativeEditorStore } from './store.js';
import { NATIVE_EDITOR_CSS } from './styles.js';

function validateReactDom(ReactDOM) {
  if (ReactDOM === null || typeof ReactDOM !== 'object' || typeof ReactDOM.createRoot !== 'function') {
    throw new TypeError('ReactDOM.createRoot is required');
  }
}

/**
 * @param {{
 *   host: HTMLElement,
 *   React: object,
 *   ReactDOM: {createRoot: Function},
 *   client: object,
 *   locale?: string,
 *   theme?: 'light' | 'dark' | 'system',
 *   pollIntervalMs?: number,
 *   autoInitialize?: boolean,
 *   timers?: {setInterval?: Function, clearInterval?: Function},
 *   onReady?: Function,
 * }} options
 */
export function mountNativeEditor({
  host,
  React,
  ReactDOM,
  client,
  locale = 'en',
  theme = 'system',
  pollIntervalMs = 0,
  autoInitialize = true,
  timers = undefined,
  onReady = undefined,
} = {}) {
  if (host === null || typeof host !== 'object' || typeof host.attachShadow !== 'function') {
    throw new TypeError('a host element with attachShadow is required');
  }
  if (React === null || typeof React !== 'object' || typeof React.createElement !== 'function') {
    throw new TypeError('React with createElement is required');
  }
  if (client === null || typeof client !== 'object' || typeof client.timeline !== 'function') {
    throw new TypeError('engine client is required');
  }
  validateReactDom(ReactDOM);
  const documentRef = host.ownerDocument;
  if (documentRef === null || typeof documentRef.createElement !== 'function') {
    throw new TypeError('host.ownerDocument.createElement is required');
  }
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (shadowRoot === null || typeof shadowRoot.appendChild !== 'function') {
    throw new TypeError('open ShadowRoot could not be created');
  }
  while (shadowRoot.firstChild !== null && shadowRoot.firstChild !== undefined) {
    shadowRoot.removeChild(shadowRoot.firstChild);
  }

  const style = documentRef.createElement('style');
  style.textContent = NATIVE_EDITOR_CSS;
  style.setAttribute?.('data-otn-styles', '');
  shadowRoot.appendChild(style);

  const container = documentRef.createElement('div');
  container.className = 'otn-shadow-root';
  shadowRoot.appendChild(container);

  const store = createNativeEditorStore({
    client,
    locale,
    pollIntervalMs,
    setIntervalImpl: timers?.setInterval,
    clearIntervalImpl: timers?.clearInterval,
  });
  const root = ReactDOM.createRoot(container);
  root.render(React.createElement(NativeEditorView, { React, store, client, theme }));
  if (pollIntervalMs > 0) store.startPolling(pollIntervalMs);
  const ready = autoInitialize === false
    ? Promise.resolve(store.getSnapshot())
    : store.initialize();
  if (typeof onReady === 'function') {
    ready.then((snapshot) => onReady(snapshot)).catch(() => {});
  }

  let disposed = false;
  function unmount() {
    if (disposed) return;
    disposed = true;
    store.dispose();
    if (typeof root.unmount === 'function') root.unmount();
    while (shadowRoot.firstChild !== null && shadowRoot.firstChild !== undefined) {
      shadowRoot.removeChild(shadowRoot.firstChild);
    }
  }

  return {
    host,
    shadowRoot,
    container,
    store,
    ready,
    getSnapshot: store.getSnapshot,
    unmount,
    dispose: unmount,
  };
}
