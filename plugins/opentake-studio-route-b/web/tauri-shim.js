/* Tauri IPC shim for the OpenTake React UI hosted inside DSH.
 * Provides just enough of window.__TAURI_INTERNALS__ for @tauri-apps/api.
 */
(function () {
  const BASE = '/opentake-studio-route-b';
  const callbacks = new Map();
  window.__SHIM_LOG__ = [];
  const listeners = new Map();
  let nextId = 1;

  function transformCallback(callback, once) {
    const id = nextId++;
    callbacks.set(id, { callback, once: Boolean(once) });
    return id;
  }
  function unregisterCallback(id) { callbacks.delete(id); }

  function invoke(cmd, args, options) {
    try { window.__SHIM_LOG__.push({ cmd, args }); } catch (e) {}
    if (cmd === 'plugin:dialog|save' || cmd === 'plugin:dialog|open') {
      // Prototype: the DSH plugin has no native file dialog surface yet. Pick a
      // writable default path and honor the requested export container.
      const filters = (args && args.options && Array.isArray(args.options.filters)) ? args.options.filters : [];
      const extensions = filters.flatMap((filter) => Array.isArray(filter.extensions) ? filter.extensions : []);
      if (extensions.includes('mp4')) return Promise.resolve('/tmp/opentake-route-b/export.mp4');
      if (extensions.includes('mov')) return Promise.resolve('/tmp/opentake-route-b/export.mov');
      if (extensions.includes('xml')) return Promise.resolve('/tmp/opentake-route-b/export.xml');
      return Promise.resolve('/tmp/opentake-route-b/demo.opentake');
    }
    if (cmd === 'plugin:dialog|message' || cmd === 'plugin:dialog|ask' || cmd === 'plugin:dialog|confirm') {
      return Promise.resolve(true);
    }
    let poll = null;
    if (cmd === 'export_video') {
      const operationId = args && args.operationId ? String(args.operationId) : 'export';
      poll = setInterval(async () => {
        try {
          const response = await fetch(BASE + '/engine/export/status', { credentials: 'same-origin' });
          if (!response.ok) return;
          const status = await response.json();
          if (!status.active) return;
          emitToListeners('export://progress', {
            operationId: status.operationId || operationId,
            done: status.done,
            total: status.total,
          });
        } catch (error) { /* progress polling is best-effort */ }
      }, 200);
    }
    return fetch(BASE + '/engine/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ cmd, args: args || {}, options: options || null }),
    }).then(async (response) => {
      try { window.__SHIM_LOG__.push({ cmd: cmd + ':response', status: response.status }); } catch (e) {}
      const body = await response.json().catch(() => null);
      if (!response.ok || (body && body.error)) {
        const err = (body && body.error) || { code: 'invoke-failed', message: 'invoke failed' };
        throw err;
      }
      afterInvoke(cmd, args || {}, body);
      return body;
    }).finally(() => { if (poll !== null) clearInterval(poll); });
  }

  function emitToListeners(event, payload) {
    const ids = listeners.get(event);
    if (!ids) return;
    for (const id of Array.from(ids)) {
      const entry = callbacks.get(id);
      if (!entry) continue;
      try { entry.callback({ event, id, payload }); } catch (error) { console.error(error); }
      if (entry.once) callbacks.delete(id);
    }
  }

  function afterInvoke(cmd, args, body) {
    if (cmd === 'plugin:event|listen') {
      const set = listeners.get(args.event) || new Set();
      set.add(args.handler);
      listeners.set(args.event, set);
      return;
    }
    if (cmd === 'plugin:event|unlisten') {
      const set = listeners.get(args.event);
      if (set) set.delete(args.eventId);
      return;
    }
    if (cmd === 'edit_apply' || cmd === 'undo' || cmd === 'redo') {
      const version = body && typeof body.timelineVersion === 'number' ? body.timelineVersion : null;
      emitToListeners('timeline_changed', version === null ? {} : { version });
    }
    if (cmd === 'import_media' || cmd === 'import_folder') {
      emitToListeners('media_changed', {});
    }
    if (cmd === 'project_saved') {
      emitToListeners('project_saved', { path: typeof body === 'string' ? body : null });
    }
  }

  function convertFileSrc(filePath) {
    return BASE + '/engine/asset?path=' + encodeURIComponent(String(filePath));
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback,
    convertFileSrc,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
})();
