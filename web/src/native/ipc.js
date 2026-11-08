/**
 * Native Route B engine client.
 *
 * This is the native-editor counterpart to the iframe's Tauri shim: it talks to
 * the already-existing `/opentake-studio-route-b/engine/*` Host routes with
 * plain same-origin fetch. It has no Tauri dependency, no globals and no DOM
 * access, so it can be tested with a fetch stub and reused by a future DSH
 * client bundle.
 */

export class EngineRequestError extends Error {
  constructor(message, { status = 0, code = 'engine-request-failed', url = '' } = {}) {
    super(message);
    this.name = 'EngineRequestError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

function normalizeBase(base) {
  if (typeof base !== 'string') throw new TypeError('engine base must be a string');
  const trimmed = base.replace(/\/+$/, '');
  return trimmed === '/' ? '' : trimmed;
}

/**
 * @param {{
 *   base?: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} [options]
 */
export function createEngineClient({ base = '/opentake-studio-route-b', fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const root = normalizeBase(base);

  async function request(path, { method = 'GET', body, signal: requestSignal } = {}) {
    const url = `${root}${path}`;
    const headers = { accept: 'application/json' };
    const init = { method, headers, signal: requestSignal ?? signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new EngineRequestError(
        `engine request failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'engine-network-error', url },
      );
    }
    const text = typeof response.text === 'function' ? await response.text() : '';
    let payload = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new EngineRequestError('engine returned invalid JSON', {
          status: response.status ?? 0,
          code: 'engine-invalid-json',
          url,
        });
      }
    }
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new EngineRequestError(
        typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : `engine request failed with HTTP ${response.status}`,
        {
          status: response.status ?? 0,
          code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'engine-http-error',
          url,
        },
      );
    }
    return payload;
  }

  return {
    base: root,
    request,
    info: () => request('/engine/info'),
    timeline: () => request('/engine/timeline'),
    media: () => request('/engine/media'),
    newProject: () => request('/engine/new', { method: 'POST' }),
    openProject: (path) => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new TypeError('openProject requires a non-empty path');
      }
      return request('/engine/open', { method: 'POST', body: { path } });
    },
    saveProject: (path = null) => request('/engine/save', {
      method: 'POST',
      body: path === null || path === undefined ? {} : { path },
    }),
    apply: (command) => {
      if (command === null || typeof command !== 'object' || Array.isArray(command)) {
        throw new TypeError('apply requires an edit command object');
      }
      return request('/engine/apply', { method: 'POST', body: { command } });
    },
    invoke: (cmd, args = {}) => {
      if (typeof cmd !== 'string' || cmd.length === 0) throw new TypeError('invoke requires a command name');
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('invoke args must be an object');
      }
      return request('/engine/invoke', { method: 'POST', body: { cmd, args } });
    },
    exportStatus: () => request('/engine/export/status'),
    undo: () => request('/engine/undo', { method: 'POST' }),
    redo: () => request('/engine/redo', { method: 'POST' }),
    previewUrl: (frame, { revision = 0, format = 'png' } = {}) => {
      const value = Number.isFinite(Number(frame)) ? Math.max(0, Math.trunc(Number(frame))) : 0;
      const suffix = `${root}/engine/preview/frame?frame=${value}&format=${format}&rev=${Math.trunc(Number(revision) || 0)}`;
      return suffix;
    },
    assetUrl: (path) => {
      if (typeof path !== 'string' || path.length === 0) return null;
      return `${root}/engine/asset?path=${encodeURIComponent(path)}`;
    },
  };
}
