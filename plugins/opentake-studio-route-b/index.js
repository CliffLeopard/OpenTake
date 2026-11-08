/**
 * OpenTake Studio Route B — in-process Rust engine.
 *
 * Loads the OpenTake `opentake-core` engine through the Node-API addon shipped
 * under `native/<platform>-<arch>/opentake_engine.node`. There is no Tauri
 * window, no sidecar process and no MCP bridge: the DSH Host calls the Rust
 * engine directly.
 *
 * Milestone 1 exposes project lifecycle and timeline snapshots. Editing
 * commands and the migrated React UI are added in later milestones.
 */

import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '/opentake-studio-route-b';
const VERSION = '0.1.0';
const WEB_DIR = path.join(PLUGIN_DIR, 'web');

function addonPath() {
  return path.join(PLUGIN_DIR, 'native', `${process.platform}-${process.arch}`, 'opentake_engine_v22.node');
}

function loadAddon() {
  const file = addonPath();
  const native = require(file);
  if (typeof native.Engine !== 'function') throw new Error(`Addon at ${file} does not export Engine`);
  return native.Engine;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function webPathFor(relative) {
  const decoded = decodeURIComponent(relative);
  const cleaned = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(WEB_DIR, cleaned);
  const root = path.resolve(WEB_DIR) + path.sep;
  if (resolved !== path.resolve(WEB_DIR) && !resolved.startsWith(root)) return null;
  return resolved;
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed;
}

export const name = 'opentake-studio-route-b';
export const inject = ['tools', 'webServer', 'connection'];

export function apply(ctx) {
  const toolRegistry = ctx.get('tools');
  const connection = Reflect.get(ctx, 'connection');
  const state = {
    Engine: null,
    engine: null,
    addonError: null,
    loadError: null,
    thumbnails: new Map(),
    exportJob: null,
  };

  try {
    state.Engine = loadAddon();
    state.engine = new state.Engine();
  } catch (error) {
    state.loadError = error instanceof Error ? error.message : String(error);
  }

  function ensureEngine() {
    if (state.engine === null) {
      throw new Error(state.loadError ?? 'OpenTake Rust engine is unavailable');
    }
    return state.engine;
  }

  function info() {
    return {
      pluginVersion: VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      napi: process.versions.napi,
      addonPath: addonPath(),
      loaded: state.engine !== null,
      loadError: state.loadError,
    };
  }

  function rejected(req, res) {
    if (typeof connection?.requestRejection !== 'function') {
      sendJson(res, 503, { error: { code: 'connection-untrusted', message: 'Browser request fence unavailable' } });
      return true;
    }
    const denial = connection.requestRejection({
      headers: req.headers,
      method: req.method,
      url: req.url,
    });
    if (denial === null || denial === undefined) return false;
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Request rejected by DSH connection policy' } });
    return true;
  }

  function emitTimeline() {
    // Reserved for future push events; the shim currently polls/refetches after
    // mutating invokes, so no server-sent event is required yet.
  }

  async function serveStatic(res, relative) {
    let file = webPathFor(relative === '' || relative === '/' ? 'index.html' : relative);
    if (file === null) {
      sendJson(res, 400, { error: { code: 'invalid-path', message: 'Invalid app path' } });
      return;
    }
    if (!existsSync(file) && !path.extname(file)) file = path.join(WEB_DIR, 'index.html');
    if (!existsSync(file)) {
      sendJson(res, 404, { error: { code: 'not-found', message: 'App asset not found' } });
      return;
    }
    const bytes = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', contentType(file));
    res.setHeader('cache-control', file.endsWith('.html') || file.endsWith('.js') ? 'no-store' : 'public, max-age=3600');
    res.end(bytes);
  }

  function mediaWithThumbnails() {
    const catalog = JSON.parse(state.engine.mediaList());
    for (const item of catalog.items) {
      const thumbnail = state.thumbnails.get(item.id);
      if (typeof thumbnail === 'string' && thumbnail.length > 0) item.thumbnail = thumbnail;
    }
    return catalog;
  }

  function importMedia(paths) {
    const catalog = JSON.parse(state.engine.importMedia(paths));
    for (const item of catalog.items) {
      if (state.thumbnails.has(item.id)) continue;
      try {
        const thumbnail = state.engine.thumbnail(item.id);
        if (typeof thumbnail === 'string' && thumbnail.length > 0) {
          state.thumbnails.set(item.id, thumbnail);
          item.thumbnail = thumbnail;
        }
      } catch {
        // A missing poster must not fail an otherwise usable import.
      }
    }
    return catalog;
  }

  function invokeCore(cmd, args) {
    if (state.engine === null) throw new Error(state.loadError ?? 'OpenTake Rust engine is unavailable');
    switch (cmd) {
      case 'get_timeline':
        return JSON.parse(state.engine.getTimeline());
      case 'edit_apply': {
        if (args.command === null || typeof args.command !== 'object') {
          throw new Error('edit_apply requires a command object');
        }
        const applied = JSON.parse(state.engine.apply(JSON.stringify(args.command)));
        emitTimeline();
        return applied.result;
      }
      case 'undo':
      case 'redo': {
        const snapshot = JSON.parse(cmd === 'undo' ? state.engine.undo() : state.engine.redo());
        return {
          actionName: cmd === 'undo' ? 'Undo' : 'Redo',
          affectedClipIds: [],
          changed: true,
          summary: cmd === 'undo' ? 'Undo' : 'Redo',
          timelineVersion: snapshot.version,
        };
      }
      case 'can_undo':
        return state.engine.canUndo();
      case 'can_redo':
        return state.engine.canRedo();
      case 'project_new': {
        if (typeof args.path === 'string' && args.path.length > 0) {
          return JSON.parse(state.engine.newProjectAt(args.path));
        }
        return JSON.parse(state.engine.newProject());
      }
      case 'project_open': {
        if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('project_open requires a path');
        return JSON.parse(state.engine.openProject(args.path));
      }
      case 'project_save':
        return state.engine.saveProject(typeof args.path === 'string' ? args.path : null);
      case 'get_default_project_dir':
        return path.join(os.homedir(), 'Documents', 'OpenTake');
      case 'check_path_exists':
        return typeof args.path === 'string' && existsSync(args.path);
      case 'get_media':
        return mediaWithThumbnails();
      case 'import_media': {
        const paths = Array.isArray(args.paths) ? args.paths.filter((value) => typeof value === 'string') : [];
        return importMedia(paths);
      }
      case 'export_xmeml':
      case 'export_fcpxml':
      case 'export_edl':
      case 'export_otio':
      case 'export_fcpxml_modern': {
        const formats = {
          export_xmeml: 'xmeml',
          export_fcpxml: 'xmeml',
          export_edl: 'edl',
          export_otio: 'otio',
          export_fcpxml_modern: 'fcpxml',
        };
        const written = state.engine.exportTimeline(String(args.path ?? ''), formats[cmd]);
        return written;
      }
      case 'export_subtitles':
        return JSON.parse(state.engine.exportSubtitles(
          String(args.path ?? ''),
          typeof args.format === 'string' ? args.format : 'srt',
        ));
      case 'library_import_to_project':
        return JSON.parse(state.engine.libraryImportToProject(String(args.id ?? '')));
      case 'library_list':
        return JSON.parse(state.engine.libraryList(typeof args.category === 'string' ? args.category : null));
      case 'library_favorite':
        return JSON.parse(state.engine.libraryFavorite(
          String(args.source ?? ''),
          String(args.kind ?? 'video'),
          typeof args.category === 'string' ? args.category : null,
          typeof args.thumb === 'string' ? args.thumb : null,
        ));
      case 'library_unfavorite':
        return state.engine.libraryUnfavorite(String(args.id ?? ''));
      case 'library_categorize':
        return JSON.parse(state.engine.libraryCategorize(
          String(args.id ?? ''),
          typeof args.category === 'string' ? args.category : null,
        ));
      case 'library_rename':
        return state.engine.libraryRename(String(args.from ?? ''), typeof args.to === 'string' ? args.to : null);
      case 'library_delete':
        return state.engine.libraryDelete(String(args.id ?? ''));
      case 'create_media_proxy': {
        const assetId = typeof args.assetId === 'string' ? args.assetId : '';
        return JSON.parse(state.engine.createMediaProxy(
          assetId,
          typeof args.maxWidth === 'number' ? args.maxWidth : 1280,
          typeof args.maxHeight === 'number' ? args.maxHeight : 720,
        ));
      }
      case 'remove_media_proxy':
        return state.engine.removeMediaProxy(typeof args.assetId === 'string' ? args.assetId : '');
      case 'cancel_media_proxy':
        return false;
      case 'get_proxy_playback_enabled':
        return true;
      case 'set_proxy_playback_enabled':
        return true;
      case 'relink_media': {
        const mediaRef = typeof args.mediaRef === 'string' ? args.mediaRef : '';
        const newPath = typeof args.newPath === 'string' ? args.newPath : '';
        return JSON.parse(state.engine.relinkMedia(mediaRef, newPath));
      }
      case 'generate_thumbnail': {
        const mediaRef = typeof args.mediaRef === 'string' ? args.mediaRef : '';
        const thumbnail = state.engine.thumbnail(mediaRef);
        if (thumbnail.length > 0) state.thumbnails.set(mediaRef, thumbnail);
        const item = JSON.parse(state.engine.mediaList()).items.find((entry) => entry.id === mediaRef);
        return {
          mediaRef,
          type: item?.type ?? 'video',
          thumbnailPath: thumbnail.length > 0 ? thumbnail : null,
          spritePath: null,
          tileWidth: item?.width ?? null,
          tileHeight: item?.height ?? null,
          columns: 1,
          times: [0],
        };
      }
      case 'composite_frame': {
        const frame = typeof args.request?.frame === 'number' ? Math.floor(args.request.frame) : 0;
        const maxSize = typeof args.maxSize === 'number' ? args.maxSize : undefined;
        return JSON.parse(state.engine.compositeFrame(frame, maxSize));
      }
      case 'export_video': {
        const req = args.req !== null && typeof args.req === 'object' ? args.req : {};
        const outPath = typeof req.outPath === 'string' ? req.outPath : '';
        if (outPath.length === 0) throw new Error('export_video requires req.outPath');
        return JSON.parse(
          state.engine.exportVideo(
            outPath,
            typeof req.codec === 'string' ? req.codec : 'h264',
            typeof req.quality === 'string' ? req.quality : '1080p',
          ),
        );
      }
      case 'cancel_export':
        if (state.exportJob !== null) state.exportJob.cancelled = true;
        return null;
      case 'get_waveform':
        return state.engine.waveform(typeof args.mediaRef === 'string' ? args.mediaRef : '');
      case 'preload_media':
        return true;
      case 'get_preview_endpoint':
        return null;
      case 'set_proxy_playback_enabled':
      case 'set_timeline_sprite_interactive':
        return null;
      case 'matting_model_status':
        return null;
      case 'check_for_update':
        return null;
      case 'home_projects_sync': {
        const entries = Array.isArray(args.entries) ? args.entries : [];
        return entries
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
          .map((entry) => {
            const absolute = entry.path;
            const exists = existsSync(absolute);
            let modifiedAt = typeof entry.modifiedAt === 'number' ? entry.modifiedAt : 0;
            try {
              if (exists) modifiedAt = Math.round(statSync(absolute).mtimeMs);
            } catch { /* keep provided timestamp */ }
            return {
              path: absolute,
              name: typeof entry.name === 'string' && entry.name.length > 0
                ? entry.name
                : path.basename(absolute, path.extname(absolute)),
              createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : (entry.openedAt ?? 0),
              openedAt: typeof entry.openedAt === 'number' ? entry.openedAt : 0,
              modifiedAt,
              thumbnailPath: null,
              preview: null,
              missing: !exists,
              offline: false,
            };
          });
      }
      case 'home_project_register':
      case 'home_project_remove':
      case 'home_project_trash':
      case 'home_project_reveal':
        return null;
      case 'plugin:event|listen':
        return 1;
      case 'plugin:event|unlisten':
        return null;
      default:
        throw Object.assign(new Error(`Tauri command not implemented yet: ${cmd}`), {
          code: 'command-not-implemented',
        });
    }
  }

  async function handleExportInvoke(args, res) {
    if (state.exportJob !== null) {
      sendJson(res, 409, { error: { code: 'export-busy', message: 'another export is running' } });
      return;
    }
    const req = args.req !== null && typeof args.req === 'object' ? args.req : {};
    const outPath = typeof req.outPath === 'string' ? req.outPath : '';
    if (outPath.length === 0) {
      sendJson(res, 400, { error: { code: 'invalid-input', message: 'req.outPath is required' } });
      return;
    }
    const operationId = typeof args.operationId === 'string' ? args.operationId : 'export';
    const job = { operationId, done: 0, total: 0, active: true, cancelled: false, error: null };
    state.exportJob = job;
    try {
      const start = JSON.parse(state.engine.exportBegin(outPath, req.codec ?? 'h264', req.quality ?? '1080p'));
      job.total = start.total;
      while (job.done < job.total) {
        if (job.cancelled) {
          state.engine.exportCancel();
          throw new Error('export cancelled');
        }
        const step = JSON.parse(state.engine.exportStep(8));
        job.done = step.done;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (job.cancelled) {
        state.engine.exportCancel();
        throw new Error('export cancelled');
      }
      const summary = JSON.parse(state.engine.exportFinish());
      job.active = false;
      state.exportJob = null;
      sendJson(res, 200, summary);
    } catch (error) {
      job.active = false;
      state.exportJob = null;
      sendJson(res, 400, {
        error: {
          code: job.cancelled ? 'export-cancelled' : 'export-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function handle(req, res) {
    if (rejected(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sub = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    try {
      if ((sub === '/app' || sub.startsWith('/app/')) && req.method === 'GET') {
        await serveStatic(res, sub.slice('/app/'.length));
        return;
      }
      if (sub === '/engine/export/status' && req.method === 'GET') {
        const job = state.exportJob;
        sendJson(res, 200, job === null
          ? { active: false, done: 0, total: 0, operationId: null }
          : { active: job.active, done: job.done, total: job.total, operationId: job.operationId });
        return;
      }
      if (sub === '/engine/invoke' && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024 * 1024);
        try {
          const cmd = typeof body.cmd === 'string' ? body.cmd : '';
          const args = body.args !== null && typeof body.args === 'object' ? body.args : {};
          if (cmd === 'export_video') {
            await handleExportInvoke(args, res);
            return;
          }
          sendJson(res, 200, invokeCore(cmd, args));
        } catch (error) {
          sendJson(res, 400, {
            error: {
              code: typeof error?.code === 'string' ? error.code : 'invoke-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (sub === '/engine/asset' && req.method === 'GET') {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const requested = requestUrl.searchParams.get('path');
        if (requested === null || requested.length === 0 || !path.isAbsolute(requested)) {
          sendJson(res, 400, { error: { code: 'invalid-path', message: 'Absolute path required' } });
          return;
        }
        try {
          const bytes = await readFile(requested);
          res.statusCode = 200;
          res.setHeader('content-type', contentType(requested));
          res.setHeader('cache-control', 'no-store');
          res.end(bytes);
        } catch {
          sendJson(res, 404, { error: { code: 'not-found', message: 'Asset not found' } });
        }
        return;
      }
      if (sub === '/engine/info' && req.method === 'GET') {
        sendJson(res, 200, info());
        return;
      }
      if (sub === '/engine/timeline' && req.method === 'GET') {
        sendJson(res, 200, JSON.parse(ensureEngine().getTimeline()));
        return;
      }
      if (sub === '/engine/media' && req.method === 'GET') {
        sendJson(res, 200, mediaWithThumbnails());
        return;
      }
      if (sub === '/engine/import-media' && req.method === 'POST') {
        const body = await readJson(req, 4 * 1024 * 1024);
        const paths = Array.isArray(body.paths) ? body.paths.filter((value) => typeof value === 'string') : [];
        sendJson(res, 200, importMedia(paths));
        return;
      }
      if (sub === '/engine/new' && req.method === 'POST') {
        sendJson(res, 200, JSON.parse(ensureEngine().newProject()));
        return;
      }
      if (sub === '/engine/open' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.path !== 'string' || body.path.length === 0) {
          sendJson(res, 400, { error: { code: 'invalid-input', message: 'path is required' } });
          return;
        }
        sendJson(res, 200, JSON.parse(ensureEngine().openProject(body.path)));
        return;
      }
      if (sub === '/engine/apply' && req.method === 'POST') {
        const body = await readJson(req, 4 * 1024 * 1024);
        const command = body.command;
        if (command === null || typeof command !== 'object' || Array.isArray(command)) {
          sendJson(res, 400, { error: { code: 'invalid-input', message: 'command object is required' } });
          return;
        }
        sendJson(res, 200, JSON.parse(ensureEngine().apply(JSON.stringify(command))));
        return;
      }
      if (sub === '/engine/undo' && req.method === 'POST') {
        sendJson(res, 200, JSON.parse(ensureEngine().undo()));
        return;
      }
      if (sub === '/engine/redo' && req.method === 'POST') {
        sendJson(res, 200, JSON.parse(ensureEngine().redo()));
        return;
      }
      if (sub === '/engine/save' && req.method === 'POST') {
        const body = await readJson(req);
        const saved = ensureEngine().saveProject(typeof body.path === 'string' ? body.path : null);
        sendJson(res, 200, { path: saved });
        return;
      }
      sendJson(res, 404, { error: { code: 'not-found', message: `Unknown route ${sub}` } });
    } catch (error) {
      sendJson(res, 500, {
        error: {
          code: 'engine-error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  function registerTool(toolName, description, parameters, run) {
    const dispose = toolRegistry.register({
      name: toolName,
      description,
      parameters,
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' }, data: {} },
          required: ['text'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
      },
      async execute(args) {
        const result = await run(args !== null && typeof args === 'object' ? args : {});
        return { text: result.text, data: result.data ?? null };
      },
    });
    ctx.effect(() => dispose, `opentake-studio-route-b: tool ${toolName}`);
  }

  registerTool(
    'opentake_route_b_engine_info',
    'Report the OpenTake Rust engine addon status (platform, arch, Node/N-API versions, load error).',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = info();
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_media',
    'Read the OpenTake Rust engine media catalog (MediaList JSON).',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = mediaWithThumbnails();
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_import_media',
    'Probe and import local media files into the OpenTake Rust engine; returns the updated catalog.',
    {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
      additionalProperties: false,
    },
    async (args) => {
      const value = importMedia(args.paths);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_waveform',
    'Read normalized waveform buckets (0=loud, 1=silence) for one media asset.',
    { type: 'object', properties: { mediaRef: { type: 'string' } }, required: ['mediaRef'], additionalProperties: false },
    async (args) => {
      const samples = ensureEngine().waveform(args.mediaRef);
      return { text: JSON.stringify(samples), data: { samples } };
    },
  );

  registerTool(
    'opentake_route_b_export_video',
    'Render every timeline frame, encode H.264/H.265/ProRes, and mux the linear audio mixdown.',
    {
      type: 'object',
      properties: {
        outPath: { type: 'string' },
        codec: { type: 'string', enum: ['h264', 'h265', 'prores', 'prores4444'] },
        quality: { type: 'string', enum: ['720p', '1080p', '4k'] },
      },
      required: ['outPath'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(
        ensureEngine().exportVideo(args.outPath, args.codec ?? 'h264', args.quality ?? '1080p'),
      );
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_relink_media',
    'Relink an existing media asset to a new absolute path, keeping its asset id.',
    {
      type: 'object',
      properties: { mediaRef: { type: 'string' }, newPath: { type: 'string' } },
      required: ['mediaRef', 'newPath'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().relinkMedia(args.mediaRef, args.newPath));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_create_proxy',
    'Generate and persist a low-resolution playback proxy for a video asset.',
    {
      type: 'object',
      properties: { mediaRef: { type: 'string' }, maxWidth: { type: 'number' }, maxHeight: { type: 'number' } },
      required: ['mediaRef'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(
        ensureEngine().createMediaProxy(args.mediaRef, args.maxWidth ?? 1280, args.maxHeight ?? 720),
      );
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_library_list',
    'List entries in the global OpenTake asset library.',
    { type: 'object', properties: { category: { type: 'string' } }, additionalProperties: false },
    async (args) => {
      const value = JSON.parse(ensureEngine().libraryList(args.category ?? null));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_library_favorite',
    'Copy a local file into the global OpenTake asset library.',
    {
      type: 'object',
      properties: { source: { type: 'string' }, kind: { type: 'string' }, category: { type: 'string' }, thumb: { type: 'string' } },
      required: ['source', 'kind'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().libraryFavorite(
        args.source,
        args.kind,
        args.category ?? null,
        args.thumb ?? null,
      ));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_library_import',
    'Import one global-library entry into the current project.',
    { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    async (args) => {
      const value = JSON.parse(ensureEngine().libraryImportToProject(args.id));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_export_timeline',
    'Write the timeline as XMEML/EDL/OTIO/FCPXML interchange.',
    {
      type: 'object',
      properties: { path: { type: 'string' }, format: { type: 'string', enum: ['xmeml', 'edl', 'otio', 'fcpxml'] } },
      required: ['path'],
      additionalProperties: false,
    },
    async (args) => {
      const written = ensureEngine().exportTimeline(args.path, args.format ?? 'xmeml');
      return { text: written, data: { path: written } };
    },
  );

  registerTool(
    'opentake_route_b_export_subtitles',
    'Write timeline caption cues to an SRT or VTT file.',
    {
      type: 'object',
      properties: { path: { type: 'string' }, format: { type: 'string', enum: ['srt', 'vtt'] } },
      required: ['path'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().exportSubtitles(args.path, args.format ?? 'srt'));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_get_timeline',
    'Read the current OpenTake Rust engine timeline snapshot JSON.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = JSON.parse(ensureEngine().getTimeline());
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_new_project',
    'Create a fresh unsaved project in the OpenTake Rust engine and return its timeline snapshot.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = JSON.parse(ensureEngine().newProject());
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_open_project',
    'Open an existing .opentake project bundle through the OpenTake Rust engine.',
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async (args) => {
      const value = JSON.parse(ensureEngine().openProject(args.path));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_apply',
    'Apply one Tauri-compatible EditRequest JSON command to the OpenTake Rust engine.',
    {
      type: 'object',
      properties: { command: { type: 'object' } },
      required: ['command'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().apply(JSON.stringify(args.command)));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_undo',
    'Undo the last OpenTake Rust engine edit.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = JSON.parse(ensureEngine().undo());
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_redo',
    'Redo the last undone OpenTake Rust engine edit.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = JSON.parse(ensureEngine().redo());
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_save_project',
    'Save the current OpenTake Rust engine project (save-as when path is provided).',
    { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    async (args) => {
      const saved = ensureEngine().saveProject(typeof args.path === 'string' ? args.path : null);
      return { text: saved, data: { path: saved } };
    },
  );

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle });
    return () => {
      disposeRoute();
      state.engine = null;
      state.Engine = null;
    };
  }, 'opentake-studio-route-b: engine routes');

  ctx.effect(
    () => () => {
      state.engine = null;
      state.Engine = null;
    },
    'opentake-studio-route-b: lifecycle',
  );
}
