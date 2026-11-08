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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = '/opentake-studio-route-b';
const VERSION = '0.1.0';
const execFileAsync = promisify(execFile);
const CACHE_ROOT = path.join(os.tmpdir(), 'opentake-route-b');
const WEB_DIR = path.join(PLUGIN_DIR, 'web');

function addonPath() {
  return path.join(PLUGIN_DIR, 'native', `${process.platform}-${process.arch}`, 'opentake_engine_v23.node');
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
    playback: null,
    asr: {
      url: process.env.OPENTAKE_ASR_URL ?? (process.env.OPENAI_API_KEY ? 'https://api.openai.com/v1/audio/transcriptions' : null),
      key: process.env.OPENAI_API_KEY ?? null,
      model: process.env.OPENTAKE_ASR_MODEL ?? 'whisper-1',
    },
    generation: {
      url: process.env.OPENTAKE_IMAGE_URL ?? (process.env.OPENAI_API_KEY ? 'https://api.openai.com/v1/images/generations' : null),
      key: process.env.OPENAI_API_KEY ?? null,
      model: process.env.OPENTAKE_IMAGE_MODEL ?? 'gpt-image-1',
    },
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

  function playbackIdentity(cmd, args) {
    const snapshot = JSON.parse(state.engine.getTimeline());
    const identity = args.identity !== null && typeof args.identity === 'object' ? args.identity : {};
    return {
      projectEpoch: typeof identity.projectEpoch === 'number' ? identity.projectEpoch : snapshot.projectEpoch,
      timelineVersion: typeof identity.timelineVersion === 'number' ? identity.timelineVersion : snapshot.version,
      sessionId: typeof identity.sessionId === 'string' ? identity.sessionId : 'route-b-session',
    };
  }

  function playbackStatus() {
    const job = state.playback;
    if (job === null || !job.active) return { active: false };
    const snapshot = JSON.parse(state.engine.getTimeline());
    const total = Math.max(1, snapshot.timeline.tracks.reduce((max, track) => Math.max(max, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames)), 0));
    let frame = job.frame;
    if (!job.paused) {
      frame = job.startFrame + Math.floor(((Date.now() - job.startedAt) / 1000) * job.fps);
      if (frame >= total) {
        frame = Math.max(0, total - 1);
        job.active = false;
        job.terminal = true;
      }
    }
    job.frame = frame;
    return {
      active: job.active,
      paused: job.paused,
      frame,
      sequence: ++job.sequence,
      terminal: job.terminal,
      projectEpoch: job.identity.projectEpoch,
      timelineVersion: job.identity.timelineVersion,
      sessionId: job.identity.sessionId,
      fps: job.fps,
    };
  }

  function cacheRoot() {
    return path.join(os.tmpdir(), 'opentake-route-b', 'cache');
  }

  function directoryBytes(directory) {
    if (!existsSync(directory)) return 0;
    let total = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      try {
        total += entry.isDirectory() ? directoryBytes(absolute) : statSync(absolute).size;
      } catch { /* concurrent deletion */ }
    }
    return total;
  }

  function storageUsage() {
    const root = cacheRoot();
    const categories = [
      { id: 'thumbnails', bytes: 0, path: root },
      { id: 'waveforms', bytes: 0, path: root },
      { id: 'searchIndex', bytes: 0, path: path.join(root, 'search-index') },
      { id: 'models', bytes: 0, path: path.join(root, 'models') },
      { id: 'other', bytes: 0, path: root },
    ];
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.png')) categories[0].bytes += statSync(absolute).size;
        else categories[4].bytes += statSync(absolute).size;
      }
    }
    const models = categories.find((category) => category.id === 'models');
    const index = categories.find((category) => category.id === 'searchIndex');
    models.bytes = directoryBytes(models.path);
    index.bytes = directoryBytes(index.path);
    return {
      categories,
      totalBytes: categories.reduce((total, category) => total + category.bytes, 0),
      cacheRoot: root,
    };
  }

  function clearStorage(ids, modelsConfirmed) {
    const root = cacheRoot();
    if (!existsSync(root)) return storageUsage();
    const wanted = new Set(ids);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (wanted.has('thumbnails') && entry.isFile() && entry.name.endsWith('.png')) {
        rmSync(absolute, { force: true });
      } else if (wanted.has('other') && entry.isFile() && !entry.name.endsWith('.png')) {
        rmSync(absolute, { force: true });
      }
    }
    if (wanted.has('models') && modelsConfirmed === true) {
      rmSync(path.join(root, 'models'), { recursive: true, force: true });
    }
    if (wanted.has('searchIndex')) {
      rmSync(path.join(root, 'search-index'), { recursive: true, force: true });
    }
    return storageUsage();
  }

  async function generateImage(prompt, size) {
    if (state.generation.url === null) throw new Error('image generation provider is not configured');
    const response = await fetch(state.generation.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(state.generation.key ? { authorization: `Bearer ${state.generation.key}` } : {}),
      },
      body: JSON.stringify({ model: state.generation.model, prompt, size: size ?? '1024x1024', n: 1, response_format: 'b64_json' }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `image generation failed (${response.status})`);
    const item = Array.isArray(body?.data) ? body.data[0] : null;
    if (!item) throw new Error('image generation returned no data');
    let bytes;
    if (typeof item.b64_json === 'string') {
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item.url === 'string') {
      const imageResponse = await fetch(item.url);
      if (!imageResponse.ok) throw new Error(`generated image download failed (${imageResponse.status})`);
      bytes = Buffer.from(await imageResponse.arrayBuffer());
    } else {
      throw new Error('image generation returned no b64_json/url');
    }
    const directory = path.join(CACHE_ROOT, 'generated');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${Date.now()}-${randomUUID()}.png`);
    await writeFile(file, bytes);
    const catalog = importMedia([file]);
    return { path: file, media: catalog };
  }

  function textSearch(query) {
    const needle = String(query ?? '').trim().toLowerCase();
    const catalog = JSON.parse(state.engine.mediaList());
    const files = [];
    const spoken = [];
    if (needle.length > 0) {
      for (const item of catalog.items) {
        const haystack = `${item.name ?? ''} ${item.path ?? ''}`.toLowerCase();
        if (haystack.includes(needle)) files.push({ mediaId: item.id, score: 1 });
        const transcriptFile = path.join(CACHE_ROOT, 'transcripts', `${item.id}.json`);
        if (!existsSync(transcriptFile)) continue;
        try {
          const transcript = JSON.parse(readFileSync(transcriptFile, 'utf8'));
          const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
          for (const segment of segments) {
            const text = String(segment.text ?? '');
            if (text.toLowerCase().includes(needle)) {
              spoken.push({
                mediaId: item.id,
                startSec: Number(segment.start ?? 0),
                endSec: Number(segment.end ?? 0),
                text,
                score: 1,
              });
            }
          }
        } catch { /* ignore unreadable transcript cache */ }
      }
    }
    return {
      visualError: 'visual embeddings unavailable: Route B text search only',
      moments: [],
      spoken,
      files,
    };
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
      case 'get_preview_endpoint':
        return `${PREFIX}/engine/preview/frame`;
      case 'playback_start': {
        const snapshot = JSON.parse(state.engine.getTimeline());
        state.playback = {
          active: true,
          paused: false,
          terminal: false,
          frame: typeof args.fromFrame === 'number' ? args.fromFrame : 0,
          startFrame: typeof args.fromFrame === 'number' ? args.fromFrame : 0,
          startedAt: Date.now(),
          fps: snapshot.timeline.fps || 30,
          sequence: 0,
          identity: playbackIdentity(cmd, args),
        };
        return null;
      }
      case 'playback_pause':
        if (state.playback !== null) {
          state.playback.paused = true;
          state.playback.frame = typeof args.frame === 'number' ? args.frame : state.playback.frame;
        }
        return null;
      case 'playback_stop':
        state.playback = null;
        return null;
      case 'playback_seek':
        if (state.playback !== null) {
          state.playback.startFrame = typeof args.frame === 'number' ? args.frame : 0;
          state.playback.frame = state.playback.startFrame;
          state.playback.startedAt = Date.now();
          state.playback.sequence = 0;
        }
        return null;
      case 'transcribe_model_status':
        return {
          installed: state.asr.url !== null,
          model: state.asr.url !== null ? `provider:${state.asr.model}` : '',
          bytes: 0,
        };
      case 'download_transcribe_model':
        return {
          installed: state.asr.url !== null,
          model: state.asr.url !== null ? `provider:${state.asr.model}` : '',
          bytes: 0,
        };
      case 'transcript_get': {
        const mediaId = typeof args.mediaId === 'string' ? args.mediaId : '';
        const file = path.join(CACHE_ROOT, 'transcripts', `${mediaId}.json`);
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8'));
      }
      case 'search_model_status':
        return { installed: true, model: 'route-b-text-search', bytes: 0 };
      case 'download_search_model':
        return { installed: true, model: 'route-b-text-search', bytes: 0 };
      case 'search_index_status': {
        const items = JSON.parse(state.engine.mediaList()).items.filter((item) => item.type === 'video' || item.type === 'image');
        const indexed = items.filter((item) => existsSync(path.join(CACHE_ROOT, 'transcripts', `${item.id}.json`))).length;
        return { modelInstalled: true, indexable: items.length, indexed };
      }
      case 'search_index_start': {
        const items = JSON.parse(state.engine.mediaList()).items.filter((item) => item.type === 'video' || item.type === 'image');
        return { modelInstalled: true, indexable: items.length, indexed: items.length };
      }
      case 'search_query':
        return textSearch(args.query);
      case 'storage_usage':
        return storageUsage();
      case 'storage_clear':
        return clearStorage(Array.isArray(args.categories) ? args.categories : [], args.modelsConfirmed === true);
      case 'export_subtitles':
        return JSON.parse(state.engine.exportSubtitles(
          String(args.path ?? ''),
          typeof args.format === 'string' ? args.format : 'srt',
        ));
      case 'library_import_to_project':
        return JSON.parse(state.engine.libraryImportToProject(String(args.id ?? '')));
      case 'toggle_favorite':
        return JSON.parse(state.engine.toggleFavorite(String(args.assetId ?? ''), args.favorite === true));
      case 'sync_project_favorites':
        return { media: mediaWithThumbnails(), migratedLegacyAssetIds: [], failures: [] };
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

  async function asrTranscript(mediaId, language) {
    if (state.asr.url === null) throw new Error('ASR provider is not configured');
    const catalog = JSON.parse(state.engine.mediaList());
    const item = catalog.items.find((entry) => entry.id === mediaId);
    if (!item || typeof item.path !== 'string') throw new Error(`media not found: ${mediaId}`);
    const cacheFile = path.join(CACHE_ROOT, 'transcripts', `${mediaId}.json`);
    if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
    const audioFile = path.join(CACHE_ROOT, 'asr', `${mediaId}.wav`);
    await mkdir(path.dirname(audioFile), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', item.path,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audioFile,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const buffer = await readFile(audioFile);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(audioFile));
    form.append('model', state.asr.model);
    form.append('response_format', 'verbose_json');
    if (typeof language === 'string' && language.length > 0) form.append('language', language);
    const headers = state.asr.key ? { authorization: `Bearer ${state.asr.key}` } : {};
    const response = await fetch(state.asr.url, { method: 'POST', headers, body: form });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `ASR request failed (${response.status})`);
    const segments = Array.isArray(body.segments)
      ? body.segments.map((segment) => ({ text: String(segment.text ?? ''), start: Number(segment.start ?? 0), end: Number(segment.end ?? 0) }))
      : [];
    const words = Array.isArray(body.words)
      ? body.words.map((word) => ({ text: String(word.word ?? word.text ?? ''), start: Number(word.start ?? 0), end: Number(word.end ?? 0) }))
      : [];
    const transcript = {
      mediaId,
      text: typeof body.text === 'string' ? body.text : segments.map((segment) => segment.text).join(' '),
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
      segments,
      words,
    };
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(transcript), 'utf8');
    return transcript;
  }

  async function handleTranscribeInvoke(args, res) {
    try {
      const transcript = await asrTranscript(typeof args.mediaId === 'string' ? args.mediaId : '', args.language);
      sendJson(res, 200, transcript);
    } catch (error) {
      sendJson(res, 500, { error: { code: 'transcribe-failed', message: error instanceof Error ? error.message : String(error) } });
    }
  }

  async function handleGenerateCaptionsInvoke(args, res) {
    try {
      const request = args.request !== null && typeof args.request === 'object' ? args.request : {};
      const catalog = JSON.parse(state.engine.mediaList());
      const media = catalog.items.find((item) => item.hasAudio === true);
      if (!media) throw new Error('no audio-bearing media to transcribe');
      const transcript = await asrTranscript(media.id, request.language);
      const timeline = JSON.parse(state.engine.getTimeline()).timeline;
      const fps = timeline.fps || 30;
      const style = request.style ?? {
        fontName: 'Helvetica-Bold',
        fontSize: 48,
        fontScale: 1,
        color: { r: 1, g: 1, b: 1, a: 1 },
        alignment: 'center',
        shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 }, offsetX: 0, offsetY: 0, blur: 0 },
        background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0 } },
        border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 } },
      };
      const transform = {
        centerX: Number.isFinite(request.centerX) ? request.centerX : 0.5,
        centerY: Number.isFinite(request.centerY) ? request.centerY : 0.85,
        width: 0.9,
        height: 0.2,
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      };
      const group = `captions-${randomUUID()}`;
      const segments = Array.isArray(transcript.segments) && transcript.segments.length > 0
        ? transcript.segments
        : [{ start: 0, end: Math.max(1, timeline.totalFrames ?? 60) / fps, text: transcript.text }];
      const entries = segments
        .filter((segment) => typeof segment.text === 'string' && segment.text.trim().length > 0)
        .map((segment) => {
          let content = segment.text.trim();
          if (request.textCase === 'upper') content = content.toUpperCase();
          if (request.textCase === 'lower') content = content.toLowerCase();
          return {
            startFrame: Math.max(0, Math.round(Number(segment.start) * fps)),
            durationFrames: Math.max(1, Math.round((Number(segment.end) - Number(segment.start)) * fps)),
            content,
            textStyle: style,
            transform,
            captionGroupId: group,
          };
        });
      if (entries.length === 0) throw new Error('transcript has no caption text');
      const applied = JSON.parse(state.engine.apply(JSON.stringify({ type: 'addCaptions', entries })));
      sendJson(res, 200, { edit: applied.result, captionCount: entries.length });
    } catch (error) {
      sendJson(res, 500, { error: { code: 'generate-captions-failed', message: error instanceof Error ? error.message : String(error) } });
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
      if (sub === '/engine/playback/status' && req.method === 'GET') {
        sendJson(res, 200, playbackStatus());
        return;
      }
      if (sub === '/engine/preview/frame' && req.method === 'GET') {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const frame = Number.parseInt(requestUrl.searchParams.get('frame') ?? '0', 10) || 0;
        try {
          const payload = JSON.parse(ensureEngine().compositeFrame(frame, 1280));
          const bytes = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
          res.statusCode = 200;
          res.setHeader('content-type', 'image/png');
          res.setHeader('cache-control', 'no-store');
          res.end(bytes);
        } catch (error) {
          sendJson(res, 500, { error: { code: 'composite-failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      if (sub === '/engine/invoke' && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024 * 1024);
        try {
          const cmd = typeof body.cmd === 'string' ? body.cmd : '';
          const args = body.args !== null && typeof body.args === 'object' ? body.args : {};
          if (cmd === 'transcribe_media') {
            await handleTranscribeInvoke(args, res);
            return;
          }
          if (cmd === 'generate_captions') {
            await handleGenerateCaptionsInvoke(args, res);
            return;
          }
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
      if (sub === '/engine/asr/config' && req.method === 'POST') {
        const body = await readJson(req);
        state.asr.url = typeof body.url === 'string' && body.url.length > 0 ? body.url : null;
        state.asr.key = typeof body.key === 'string' && body.key.length > 0 ? body.key : null;
        state.asr.model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'whisper-1';
        sendJson(res, 200, { ok: true, configured: state.asr.url !== null, model: state.asr.model });
        return;
      }
      if (sub === '/engine/generation/config' && req.method === 'POST') {
        const body = await readJson(req);
        state.generation.url = typeof body.url === 'string' && body.url.length > 0 ? body.url : null;
        state.generation.key = typeof body.key === 'string' && body.key.length > 0 ? body.key : null;
        state.generation.model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'gpt-image-1';
        sendJson(res, 200, { ok: true, configured: state.generation.url !== null, model: state.generation.model });
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
    'opentake_route_b_toggle_favorite',
    'Favorite/unfavorite a project asset and mirror it into the global library.',
    {
      type: 'object',
      properties: { mediaRef: { type: 'string' }, favorite: { type: 'boolean' } },
      required: ['mediaRef', 'favorite'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().toggleFavorite(args.mediaRef, args.favorite));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_storage',
    'Report Route B cache storage usage by category.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const value = storageUsage();
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_generate_image',
    'Generate an image through the configured OpenAI-compatible provider and import it into the project.',
    {
      type: 'object',
      properties: { prompt: { type: 'string' }, size: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    async (args) => {
      const value = await generateImage(args.prompt, args.size);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_search',
    'Text-only project search over media names and cached transcripts (no visual embeddings).',
    { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    async (args) => {
      const value = textSearch(args.query);
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
