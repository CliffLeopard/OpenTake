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
import { createHash, randomUUID } from 'node:crypto';
import { templateToDocument, validateTemplateParams } from './lib/motion-templates.js';
import { ProviderError, createProviderClient } from './lib/providers.js';
import { installModel } from './lib/search/install-model.mjs';
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
  return path.join(PLUGIN_DIR, 'native', `${process.platform}-${process.arch}`, 'opentake_engine_v44.node');
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

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    motionJob: null,
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
    video: {
      url: process.env.OPENTAKE_VIDEO_URL ?? null,
      key: process.env.OPENTAKE_VIDEO_KEY ?? process.env.FAL_KEY ?? null,
      model: process.env.OPENTAKE_VIDEO_MODEL ?? 'fal-ai/text-to-video',
    },
    speech: {
      url: process.env.OPENTAKE_TTS_URL ?? (process.env.OPENAI_API_KEY ? 'https://api.openai.com/v1/audio/speech' : null),
      key: process.env.OPENAI_API_KEY ?? null,
      model: process.env.OPENTAKE_TTS_MODEL ?? 'gpt-4o-mini-tts',
    },
    searchCapability: null,
    searchAttempted: false,
  };
  const SEARCH_MODELS_DIR = process.env.OPENTAKE_MODELS_DIR ?? path.join(os.homedir(), '.dsh', 'opentake', 'models');

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
    if (job.nativeAudio === true) {
      try {
        const native = JSON.parse(state.engine.playbackAudioStatus());
        if (native.active === true && typeof native.frame === 'number') {
          frame = Math.max(0, native.frame);
          if (frame >= total) {
            frame = Math.max(0, total - 1);
            job.active = false;
            job.terminal = true;
          }
        }
      } catch { /* fall back to wall clock */ }
    } else if (!job.paused && job.audioFrame !== null && Date.now() - job.audioAt < 750) {
      frame = Math.max(0, Math.round(job.audioFrame));
    } else if (!job.paused) {
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

  function providerClient(kind, config) {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error(`${kind} provider is not configured`);
    }
    return createProviderClient({
      kind,
      config: {
        ...config,
        kind,
        configured: true,
      },
    });
  }

  async function providerBytes(client, result, extension) {
    let bytes = result.bytes === null || result.bytes === undefined ? null : Buffer.from(result.bytes);
    if (bytes === null && typeof result.url === 'string') {
      const downloaded = await client.download(result.url);
      bytes = Buffer.from(downloaded.bytes);
    }
    if (bytes === null || bytes.length === 0) throw new Error('provider returned empty media');
    const directory = path.join(CACHE_ROOT, 'generated');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${Date.now()}-${randomUUID()}.${extension}`);
    await writeFile(file, bytes);
    return { file, bytes };
  }

  async function generateVideo(prompt) {
    try {
      const client = providerClient('video', state.video);
      const result = await client.generateVideo({ prompt });
      const { file } = await providerBytes(client, result, 'mp4');
      return { path: file, media: importMedia([file]) };
    } catch (error) {
      if (error instanceof ProviderError) throw new Error(error.message);
      throw error;
    }
  }

  async function generateSpeech(text, voice) {
    try {
      const client = providerClient('speech', state.speech);
      const result = await client.generateSpeech({ text, voice: voice ?? 'alloy', format: 'mp3' });
      const { file } = await providerBytes(client, result, 'mp3');
      return { path: file, media: importMedia([file]) };
    } catch (error) {
      if (error instanceof ProviderError) throw new Error(error.message);
      throw error;
    }
  }

  async function generateImage(prompt, size) {
    try {
      const client = providerClient('image', state.generation);
      const result = await client.generateImage({ prompt, size: size ?? '1024x1024', responseFormat: 'b64_json' });
      const { file } = await providerBytes(client, result, 'png');
      return { path: file, media: importMedia([file]) };
    } catch (error) {
      if (error instanceof ProviderError) throw new Error(error.message);
      throw error;
    }
  }

  function searchAssetsJson() {
    const items = JSON.parse(state.engine.mediaList()).items
      .filter((item) => item.type === 'video' || item.type === 'image')
      .map((item) => ({
        id: item.id,
        path: item.path ?? '',
        kind: item.type,
        durationSecs: item.duration ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      }));
    return JSON.stringify(items);
  }

  function ensureSearch(force = false) {
    if (state.searchCapability?.visualAvailable === true && !force) return state.searchCapability;
    if (state.searchAttempted && !force) return state.searchCapability;
    state.searchAttempted = true;
    try {
      state.searchCapability = JSON.parse(state.engine.searchConfigure(
        SEARCH_MODELS_DIR,
        path.join(CACHE_ROOT, 'search-index'),
      ));
    } catch (error) {
      state.searchCapability = {
        installed: false,
        model: 'siglip2-base-patch16-256',
        version: 2,
        expectedBytes: 1535824768,
        installedBytes: 0,
        modelsDir: SEARCH_MODELS_DIR,
        backend: null,
        visualAvailable: false,
        reason: 'visual_unavailable',
        detail: 'backend_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return state.searchCapability;
  }

  function visualSearch(query, queryImageBase64, fps) {
    const capability = ensureSearch();
    if (capability.visualAvailable !== true) {
      return { ...textSearch(query ?? ''), visualAvailable: false, visualErrorDetail: capability.detail ?? 'model_not_installed' };
    }
    const assets = searchAssetsJson();
    const visual = queryImageBase64
      ? JSON.parse(state.engine.searchQueryImage(queryImageBase64, assets, fps ?? 30))
      : JSON.parse(state.engine.searchQuery(String(query ?? ''), assets, fps ?? 30));
    const text = queryImageBase64 ? { spoken: [], files: [] } : textSearch(query);
    return {
      moments: visual.moments ?? [],
      spoken: text.spoken ?? [],
      files: text.files ?? [],
      visualAvailable: visual.visualAvailable === true,
      visualError: visual.visual_error ?? visual.visualError ?? null,
      visualErrorDetail: visual.visual_error_detail ?? visual.visualErrorDetail ?? null,
      queryKind: visual.query_kind ?? (queryImageBase64 ? 'image' : 'text'),
    };
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
      visualError: 'visual embeddings unavailable: SigLIP2 assets not installed',
      visualErrorDetail: 'model_not_installed',
      moments: [],
      spoken,
      files,
    };
  }

  const MOTION_HTML = `<main class="motion-stage">\n  <p class="motion-kicker">Motion Studio</p>\n  <h1>让创意动起来</h1>\n  <p class="motion-subtitle">Real HTML · Real CSS · Real motion</p>\n</main>\n`;
  const MOTION_CSS = `html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111214; color: #f7f7f5; font-family: Inter, "PingFang SC", sans-serif; }\n.motion-stage { display: grid; align-content: center; width: 100%; height: 100%; padding: 10%; background: radial-gradient(circle at 72% 24%, #5f5cff 0, transparent 34%); }\n.motion-kicker { color: #a9a7ff; letter-spacing: .18em; text-transform: uppercase; }\nh1 { margin: .12em 0; font-size: clamp(48px, 8vw, 144px); animation: title-in 1.2s both; }\n.motion-subtitle { font-size: clamp(18px, 2.2vw, 42px); opacity: .72; animation: subtitle-in 1.2s .18s both; }\n@keyframes title-in { from { opacity: 0; transform: translateY(48px) scale(.96); } to { opacity: 1; transform: none; } }\n@keyframes subtitle-in { from { opacity: 0; transform: translateY(24px); } to { opacity: .72; transform: none; } }\n`;

  function currentProjectPath() {
    const snapshot = JSON.parse(ensureEngine().getTimeline());
    if (typeof snapshot.projectPath !== 'string' || snapshot.projectPath.length === 0) {
      throw new Error('save the project before importing assets');
    }
    return snapshot.projectPath;
  }

  function projectLutDirectory() {
    return path.join(currentProjectPath(), 'media', 'luts');
  }

  function listProjectLuts() {
    const snapshot = JSON.parse(ensureEngine().getTimeline());
    if (typeof snapshot.projectPath !== 'string' || snapshot.projectPath.length === 0) {
      return { items: [], projectPath: null };
    }
    const directory = path.join(snapshot.projectPath, 'media', 'luts');
    if (!existsSync(directory)) return { items: [], projectPath: snapshot.projectPath };
    const items = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.cube')) continue;
      const id = entry.name.slice(0, -5);
      if (!/^[0-9a-f]{64}$/.test(id)) continue;
      let bytes = 0;
      try { bytes = statSync(path.join(directory, entry.name)).size; } catch { continue; }
      let name = id.slice(0, 12);
      try {
        const sidecar = JSON.parse(readFileSync(path.join(directory, `${id}.json`), 'utf8'));
        if (typeof sidecar.name === 'string' && sidecar.name.length > 0) name = sidecar.name;
      } catch { /* older LUT without display metadata */ }
      items.push({ id, name, bytes, intensity: 1 });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    return { items, projectPath: snapshot.projectPath };
  }

  function motionRoot() {
    const snapshot = JSON.parse(state.engine.getTimeline());
    if (typeof snapshot.projectPath !== 'string' || snapshot.projectPath.length === 0) {
      throw new Error('save the project before using Motion Studio');
    }
    return path.join(snapshot.projectPath, 'motion-documents');
  }

  function motionHash(html, css) {
    return createHash('sha256').update(html).update('\u0000').update(css).digest('hex');
  }

  function readMotionDocument(root, id) {
    const directory = path.join(root, id);
    const html = readFileSync(path.join(directory, 'index.html'), 'utf8');
    const css = readFileSync(path.join(directory, 'styles.css'), 'utf8');
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    return { summary: manifest.summary, html, css, parameters: manifest.parameters ?? {} };
  }

  function writeMotionDocument(root, document) {
    const directory = path.join(root, document.summary.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'index.html'), document.html, 'utf8');
    writeFileSync(path.join(directory, 'styles.css'), document.css, 'utf8');
    writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, summary: document.summary, parameters: document.parameters ?? {} }, null, 2),
      'utf8',
    );
    const catalogFile = path.join(root, 'catalog.json');
    mkdirSync(root, { recursive: true });
    let documents = [];
    if (existsSync(catalogFile)) {
      try { documents = JSON.parse(readFileSync(catalogFile, 'utf8')).documents ?? []; } catch { documents = []; }
    }
    documents = documents.filter((entry) => entry?.summary?.id !== document.summary.id);
    documents.push({ summary: document.summary });
    documents.sort((a, b) => String(a.summary.id).localeCompare(String(b.summary.id)));
    writeFileSync(catalogFile, JSON.stringify({ schemaVersion: 1, documents }, null, 2), 'utf8');
  }

  function motionDocuments() {
    const root = motionRoot();
    const catalogFile = path.join(root, 'catalog.json');
    if (!existsSync(catalogFile)) return [];
    try {
      return (JSON.parse(readFileSync(catalogFile, 'utf8')).documents ?? []).map((entry) => entry.summary);
    } catch {
      return [];
    }
  }

  function motionDirectory(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid motion document id');
    return motionRoot();
  }

  function applyMotionEdits(source, edits) {
    const bytes = Buffer.from(source, 'utf8');
    const ordered = Array.isArray(edits) ? [...edits].sort((a, b) => b.start - a.start) : [];
    let content = bytes;
    for (const edit of ordered) {
      if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > content.length) {
        throw new Error('invalid motion edit range');
      }
      const replacement = Buffer.from(String(edit.replacement ?? ''), 'utf8');
      content = Buffer.concat([content.subarray(0, edit.start), replacement, content.subarray(edit.end)]);
    }
    return content.toString('utf8');
  }

  function chromeExecutable() {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  async function motionPreview(request) {
    const width = Math.max(2, Math.round(Number(request.width) || 1280));
    const height = Math.max(2, Math.round(Number(request.height) || 720));
    const fps = Math.max(1, Number(request.fps) || 30);
    const frame = Math.max(0, Math.round(Number(request.frame) || 0));
    let document = null;
    let page;
    let revisionHash;
    let sourceKey;
    if (typeof request.documentId === 'string' && request.documentId.length > 0) {
      const root = motionRoot();
      document = readMotionDocument(root, request.documentId);
      if (request.revisionHash !== document.summary.revisionHash) throw new Error('motion document changed; reload before previewing');
      page = `<!doctype html><html><head><meta charset="utf-8"><style>${document.css}</style><style>html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden}</style></head><body>${document.html}</body></html>`;
      revisionHash = document.summary.revisionHash;
      sourceKey = request.documentId;
    } else if (typeof request.templateId === 'string' && request.templateId.length > 0) {
      const params = validateTemplateParams(request.templateId, request.params ?? {});
      const rendered = templateToDocument(request.templateId, params, {
        width,
        height,
        fps,
        frame,
        durationSeconds: Math.max(0.1, Number(request.durationFrames) / fps || 1),
      });
      page = rendered.document;
      revisionHash = createHash('sha256').update(request.templateId).update(JSON.stringify(params)).digest('hex');
      sourceKey = `template-${request.templateId}`;
    } else {
      throw new Error('motion_preview requires documentId or templateId');
    }
    const chrome = chromeExecutable();
    if (chrome === null) throw new Error('Chromium/Chrome is required for Motion preview');
    const directory = path.join(CACHE_ROOT, 'motion-preview');
    await mkdir(directory, { recursive: true });
    const key = `${sourceKey}-${frame}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    const htmlFile = path.join(directory, `${key}.html`);
    const pngFile = path.join(directory, `${key}.png`);
    await writeFile(htmlFile, page, 'utf8');
    const budget = Math.max(50, Math.round((frame / fps) * 1000));
    await execFileAsync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--default-background-color=00000000',
      `--window-size=${width},${height}`, `--virtual-time-budget=${budget}`,
      `--screenshot=${pngFile}`, `file://${htmlFile}`,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const bytes = await readFile(pngFile);
    return {
      revisionHash,
      frame,
      pngDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      diagnostics: [],
      source: document ? { kind: 'document', documentId: request.documentId } : { kind: 'template', templateId: request.templateId },
    };
  }

  async function motionAdd(request) {
    let document = null;
    let templateId = null;
    let templateParams = null;
    let revisionHash = null;
    let sourceKey = null;
    if (typeof request.documentId === 'string' && request.documentId.length > 0) {
      const root = motionRoot();
      document = readMotionDocument(root, request.documentId);
      if (request.revisionHash !== document.summary.revisionHash) throw new Error('motion document changed; reload before publishing');
      revisionHash = document.summary.revisionHash;
      sourceKey = request.documentId;
    } else if (typeof request.templateId === 'string' && request.templateId.length > 0) {
      templateId = request.templateId;
      templateParams = validateTemplateParams(templateId, request.params ?? {});
      revisionHash = createHash('sha256').update(templateId).update(JSON.stringify(templateParams)).digest('hex');
      sourceKey = `template-${templateId}`;
    } else {
      throw new Error('motion_add requires documentId or templateId');
    }
    const width = Math.max(2, Math.round(Number(request.width) || 1280));
    const height = Math.max(2, Math.round(Number(request.height) || 720));
    const fps = Math.max(1, Math.round(Number(request.fps) || 30));
    const duration = Math.max(1, Math.round(Number(request.durationFrames) || 30));
    const startFrame = Math.max(0, Math.round(Number(request.startFrame) || 0));
    const directory = path.join(CACHE_ROOT, 'motion-publish', `${sourceKey}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    state.motionJob = { active: true, phase: 'rendering', doneFrames: 0, totalFrames: duration };
    const updateMotion = (phase, doneFrames = 0) => {
      state.motionJob = { active: phase !== 'complete', phase, doneFrames, totalFrames: duration };
    };
    for (let frame = 0; frame < duration; frame += 1) {
      const preview = await motionPreview({
        ...(document ? { documentId: request.documentId } : { templateId, params: templateParams }),
        revisionHash,
        frame,
        width,
        height,
        fps,
        durationFrames: duration,
      });
      const bytes = Buffer.from(preview.pngDataUrl.split(',')[1], 'base64');
      await writeFile(path.join(directory, `${String(frame).padStart(5, '0')}.png`), bytes);
      updateMotion('rendering', frame + 1);
    }
    updateMotion('encoding');
    const transparent = request.transparent === true;
    const output = path.join(directory, transparent ? 'motion.mov' : 'motion.mp4');
    const codec = transparent
      ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
      : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20'];
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(fps), '-i', path.join(directory, '%05d.png'),
      ...codec, output,
    ], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    updateMotion('committing');
    const catalog = importMedia([output]);
    const asset = catalog.items.find((item) => item.path === output);
    if (!asset) throw new Error('motion output could not be imported');
    let timeline = JSON.parse(state.engine.getTimeline()).timeline;
    let trackIndex = Number.isInteger(request.trackIndex) ? request.trackIndex : -1;
    if (trackIndex < 0 || trackIndex >= timeline.tracks.length || timeline.tracks[trackIndex]?.type !== 'video') {
      trackIndex = timeline.tracks.findIndex((track) => track.type === 'video');
    }
    if (trackIndex < 0) {
      const inserted = JSON.parse(state.engine.apply(JSON.stringify({ type: 'insertTrack', kind: 'video' })));
      timeline = inserted.timeline.timeline;
      trackIndex = timeline.tracks.length - 1;
    }
    const applied = JSON.parse(state.engine.apply(JSON.stringify({
      type: 'addClips',
      entries: [{
        mediaRef: asset.id,
        mediaType: 'video',
        sourceClipType: 'video',
        trackIndex,
        startFrame,
        durationFrames: duration,
        hasAudio: false,
        addLinkedAudio: false,
      }],
    })));
    const clipId = applied.result.affectedClipIds[0];
    const contentHash = createHash('sha256').update(await readFile(output)).digest('hex');
    updateMotion('complete');
    return {
      clipId,
      assetId: asset.id,
      contentHash,
      actionName: 'Add Motion Graphic',
      ...(document
        ? { sourceDocument: { documentId: request.documentId, revisionHash } }
        : { source: { kind: 'template', templateId, revisionHash } }),
      output: {
        renderer: 'route-b-chrome-headless',
        rendererVersion: '1',
        outputFile: output,
        fps,
        width,
        height,
        durationFrames: duration,
        durationSeconds: duration / fps,
        contentHash,
      },
    };
  }

  const IMPORTABLE_EXTENSIONS = new Set([
    'mp4', 'mov', 'm4v', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg',
    'tiff', 'heic', 'webp', 'json', 'lottie',
  ]);

  function scanImportFolder(directory, recursive) {
    const files = [];
    const walk = (current, depth) => {
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive && depth < 12) walk(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (IMPORTABLE_EXTENSIONS.has(extension)) files.push(absolute);
      }
    };
    walk(directory, 0);
    files.sort();
    return files;
  }

  function importFolder(directory, recursive) {
    if (typeof directory !== 'string' || !existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error('import_folder requires an existing directory path');
    }
    const files = scanImportFolder(directory, recursive === true);
    if (files.length === 0) return mediaWithThumbnails();
    return importMedia(files);
  }

  async function timelineSprite(mediaRef, requestedFrames) {
    const items = JSON.parse(state.engine.mediaList()).items;
    const item = items.find((entry) => entry.id === mediaRef);
    if (!item) throw new Error(`media not found: ${mediaRef}`);
    const thumbnail = item.thumbnail ?? (state.engine.thumbnail(mediaRef) || null);
    if (thumbnail) state.thumbnails.set(mediaRef, thumbnail);
    if (item.type === 'image') {
      return {
        status: 'cached',
        thumbnail: {
          mediaRef,
          type: 'image',
          thumbnailPath: thumbnail,
          spritePath: thumbnail,
          tileWidth: item.width ?? null,
          tileHeight: item.height ?? null,
          columns: 1,
          times: [0],
        },
      };
    }
    if (item.type !== 'video') {
      return { status: 'failed', thumbnail: null };
    }
    const count = Math.max(4, Math.min(64, Number.isFinite(requestedFrames) ? Math.round(requestedFrames) : 24));
    const duration = Math.max(0.1, Number(item.duration) || 1);
    const width = Math.max(2, Number(item.width) || 320);
    const height = Math.max(2, Number(item.height) || 180);
    const tileWidth = 160;
    const tileHeight = Math.max(2, Math.round((tileWidth * height) / width));
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / columns));
    const directory = path.join(CACHE_ROOT, 'sprites');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${mediaRef}-${count}.jpg`);
    if (!existsSync(file)) {
      const fps = Math.min(30, Math.max(1, count / duration));
      try {
        await execFileAsync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', item.path,
          '-vf', `fps=${fps.toFixed(4)},scale=${tileWidth}:${tileHeight},tile=${columns}x${rows}`,
          '-frames:v', '1', '-q:v', '5', file,
        ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      } catch {
        return { status: 'failed', thumbnail: null };
      }
    }
    if (!existsSync(file)) return { status: 'failed', thumbnail: null };
    return {
      status: 'cached',
      thumbnail: {
        mediaRef,
        type: 'video',
        thumbnailPath: thumbnail,
        spritePath: file,
        tileWidth,
        tileHeight,
        columns,
        times: Array.from({ length: count }, (_, index) => (duration * index) / count),
      },
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
      case 'import_folder':
        return importFolder(args.path, args.recursive === true);
      case 'import_media': {
        const paths = Array.isArray(args.paths) ? args.paths.filter((value) => typeof value === 'string') : [];
        return importMedia(paths);
      }
      case 'export_audio': {
        const outPath = typeof args.outPath === 'string' ? args.outPath : '';
        if (outPath.length === 0) throw new Error('export_audio requires outPath');
        return JSON.parse(state.engine.exportAudio(outPath, args.format === 'mp3' ? 'mp3' : 'm4a', args.duckMusic === true));
      }
      case 'capture_frame_to_media':
        return JSON.parse(state.engine.captureFrameToMedia(
          typeof args.frame === 'number' ? Math.floor(args.frame) : 0,
          typeof args.nameBase === 'string' ? args.nameBase : 'Frame',
          typeof args.sourceMediaId === 'string' ? args.sourceMediaId : null,
        ));
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
          audioFrame: null,
          audioAt: 0,
          nativeAudio: false,
          identity: playbackIdentity(cmd, args),
        };
        try {
          const native = JSON.parse(state.engine.playbackAudioStart(state.playback.startFrame));
          state.playback.nativeAudio = native.nativeAudio === true;
        } catch { state.playback.nativeAudio = false; }
        return null;
      }
      case 'playback_pause':
        if (state.playback !== null) {
          state.playback.paused = true;
          try { state.engine.playbackAudioPause(); } catch { /* no native audio */ }
          state.playback.frame = typeof args.frame === 'number' ? args.frame : state.playback.frame;
        }
        return null;
      case 'playback_stop':
        try { state.engine.playbackAudioStop(); } catch { /* no native audio */ }
        state.playback = null;
        return null;
      case 'playback_seek':
        if (state.playback !== null) {
          try { state.engine.playbackAudioStop(); } catch { /* no native audio */ }
          state.playback.startFrame = typeof args.frame === 'number' ? args.frame : 0;
          state.playback.frame = state.playback.startFrame;
          state.playback.startedAt = Date.now();
          state.playback.sequence = 0;
          state.playback.audioFrame = null;
          state.playback.audioAt = 0;
          state.playback.nativeAudio = false;
          try {
            const native = JSON.parse(state.engine.playbackAudioStart(state.playback.startFrame));
            state.playback.nativeAudio = native.nativeAudio === true;
          } catch { state.playback.nativeAudio = false; }
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
      case 'motion_capability':
        return chromeExecutable() !== null;
      case 'motion_document_list':
        return motionDocuments();
      case 'motion_document_create': {
        const root = motionRoot();
        const id = randomUUID();
        const summary = {
          id,
          title: typeof args.request?.title === 'string' && args.request.title.length > 0 ? args.request.title : 'Untitled Motion',
          revisionHash: motionHash(MOTION_HTML, MOTION_CSS),
          updatedAt: Date.now(),
        };
        const document = { summary, html: MOTION_HTML, css: MOTION_CSS, parameters: {} };
        writeMotionDocument(root, document);
        return document;
      }
      case 'motion_document_read': {
        const root = motionRoot();
        const id = String(args.documentId ?? '');
        motionDirectory(id);
        return readMotionDocument(root, id);
      }
      case 'motion_document_hash': {
        const request = args.request ?? {};
        const root = motionRoot();
        const document = readMotionDocument(root, String(request.documentId ?? ''));
        if (document.summary.revisionHash !== request.baselineHash) throw new Error('motion document revision conflict');
        const result = applyMotionEdits(request.file === 'styles.css' ? document.css : document.html, request.edits);
        return motionHash(
          request.file === 'styles.css' ? document.html : result,
          request.file === 'styles.css' ? result : document.css,
        );
      }
      case 'motion_document_patch': {
        const request = args.request ?? {};
        const root = motionRoot();
        const document = readMotionDocument(root, String(request.documentId ?? ''));
        if (document.summary.revisionHash !== request.baselineHash) throw new Error('motion document revision conflict');
        const result = applyMotionEdits(request.file === 'styles.css' ? document.css : document.html, request.edits);
        const next = {
          ...document,
          html: request.file === 'styles.css' ? document.html : result,
          css: request.file === 'styles.css' ? result : document.css,
          summary: {
            ...document.summary,
            revisionHash: motionHash(
              request.file === 'styles.css' ? document.html : result,
              request.file === 'styles.css' ? result : document.css,
            ),
            updatedAt: Date.now(),
          },
        };
        if (next.summary.revisionHash !== request.expectedResultHash) throw new Error('motion document result hash mismatch');
        writeMotionDocument(root, next);
        return next;
      }
      case 'motion_preview_cancel':
      case 'motion_cancel':
        return false;
      case 'prepare_denoise':
        return JSON.parse(state.engine.prepareDenoise(
          String(args.clipId ?? args.clip_id ?? ''),
          typeof args.mode === 'string' ? args.mode : undefined,
          typeof args.strength === 'number' ? args.strength : undefined,
          typeof args.previewEnabled === 'boolean' ? args.previewEnabled : undefined,
        ));
      case 'cancel_denoise_analysis':
        return false;
      case 'analyze_loudness':
        return JSON.parse(state.engine.analyzeLoudness(
          String(args.clipId ?? args.clip_id ?? ''),
          typeof args.targetLufs === 'number' ? args.targetLufs : undefined,
          typeof args.truePeakCeilingDbtp === 'number' ? args.truePeakCeilingDbtp : undefined,
        ));
      case 'cancel_loudness_analysis':
        return false;
      case 'analyze_stabilization':
        return JSON.parse(state.engine.analyzeStabilization(String(args.clipId ?? args.clip_id ?? '')));
      case 'cancel_stabilization_analysis':
        return false;
      case 'search_model_status':
        return ensureSearch();
      case 'download_search_model': {
        const capability = ensureSearch(true);
        if (capability.visualAvailable !== true) {
          throw new Error(`SigLIP2 assets are not installed (${capability.detail ?? 'model_not_installed'}); use scripts/route-b/search/install-model.mjs`);
        }
        return capability;
      }
      case 'search_index_status':
        ensureSearch();
        return JSON.parse(state.engine.searchIndexStatus(searchAssetsJson()));
      case 'search_index_start':
        ensureSearch();
        return JSON.parse(state.engine.searchIndexStart(searchAssetsJson()));
      case 'search_query':
        return visualSearch(args.query, null, typeof args.fps === 'number' ? args.fps : undefined);
      case 'search_query_image':
        return visualSearch('', String(args.imageBase64 ?? ''), typeof args.fps === 'number' ? args.fps : undefined);
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
            req.bitDepth === 10 ? 10 : null,
            req.duckMusic === true,
            req.hdr10 === true,
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
      const start = JSON.parse(state.engine.exportBegin(
        outPath,
        req.codec ?? 'h264',
        req.quality ?? '1080p',
        typeof req.rangeStartFrame === 'number' ? req.rangeStartFrame : null,
        typeof req.rangeEndFrame === 'number' ? req.rangeEndFrame : null,
        req.bitDepth === 10 ? 10 : null,
        req.duckMusic === true,
        req.hdr10 === true,
      ));
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
      if (sub === '/engine/motion/status' && req.method === 'GET') {
        sendJson(res, 200, state.motionJob ?? { active: false });
        return;
      }
      if (sub === '/engine/playback/sync' && req.method === 'POST') {
        const body = await readJson(req);
        if (state.playback !== null && typeof body.frame === 'number' && Number.isFinite(body.frame)) {
          state.playback.audioFrame = body.frame;
          state.playback.audioAt = Date.now();
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (sub === '/engine/playback/status' && req.method === 'GET') {
        sendJson(res, 200, playbackStatus());
        return;
      }
      if (sub === '/engine/playback/audio' && req.method === 'GET') {
        if (state.playback?.nativeAudio === true) {
          sendJson(res, 409, { error: { code: 'native-audio', message: 'native audio clock is active' } });
          return;
        }
        try {
          const file = state.engine.audioMixWav();
          const bytes = await readFile(file);
          res.statusCode = 200;
          res.setHeader('content-type', 'audio/wav');
          res.setHeader('cache-control', 'no-store');
          res.end(bytes);
        } catch (error) {
          sendJson(res, 404, { error: { code: 'no-audio', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      if (sub === '/engine/playback/stream' && req.method === 'GET') {
        const status = playbackStatus();
        if (status.active !== true) {
          sendJson(res, 409, { error: { code: 'not-playing', message: 'start playback before opening the stream' } });
          return;
        }
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const maxSize = Math.max(160, Math.min(1920, Number.parseInt(requestUrl.searchParams.get('maxSize') ?? '1280', 10) || 1280));
        const frameLimit = Math.max(1, Math.min(1800, Number.parseInt(requestUrl.searchParams.get('frames') ?? '300', 10) || 300));
        const boundary = 'routebframe';
        let closed = false;
        res.statusCode = 200;
        res.setHeader('content-type', `multipart/x-mixed-replace; boundary=${boundary}`);
        res.setHeader('cache-control', 'no-store');
        res.setHeader('connection', 'close');
        res.flushHeaders?.();
        req.on('close', () => { closed = true; });
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        (async () => {
          let sent = 0;
          try {
            while (!closed && sent < frameLimit) {
              const current = playbackStatus();
              if (current.active !== true || current.paused === true) break;
              const payload = JSON.parse(ensureEngine().compositeFrame(current.frame, maxSize));
              const bytes = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
              res.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${bytes.length}\r\n\r\n`);
              res.write(bytes);
              res.write('\r\n');
              sent += 1;
              await delay(Math.max(8, Math.round(1000 / Math.max(1, current.fps))));
            }
          } catch { /* client went away or frame failed */ }
          try { res.end(`--${boundary}--\r\n`); } catch { /* already closed */ }
        })();
        return;
      }
      if (sub === '/engine/preview/frame' && req.method === 'GET') {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const frame = Number.parseInt(requestUrl.searchParams.get('frame') ?? '0', 10) || 0;
        const asJpeg = requestUrl.searchParams.get('format') === 'jpeg';
        try {
          const payload = JSON.parse(asJpeg
            ? ensureEngine().compositeFrameJpeg(frame, 1280, 82)
            : ensureEngine().compositeFrame(frame, 1280));
          const bytes = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
          res.statusCode = 200;
          res.setHeader('content-type', asJpeg ? 'image/jpeg' : 'image/png');
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
          if (cmd === 'request_timeline_sprite') {
            try {
              sendJson(res, 200, await timelineSprite(String(args.mediaRef ?? ''), args.maxFrames));
            } catch (error) {
              sendJson(res, 200, { status: 'failed', thumbnail: null });
            }
            return;
          }
          if (cmd === 'motion_add') {
            try {
              sendJson(res, 200, await motionAdd(args.request ?? {}));
            } catch (error) {
              sendJson(res, 400, { error: { code: 'motion-add-failed', message: error instanceof Error ? error.message : String(error) } });
            }
            return;
          }
          if (cmd === 'motion_preview') {
            try {
              sendJson(res, 200, await motionPreview(args.request ?? {}));
            } catch (error) {
              sendJson(res, 400, { error: { code: 'motion-preview-failed', message: error instanceof Error ? error.message : String(error) } });
            }
            return;
          }
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
      if (sub === '/engine/video/config' && req.method === 'POST') {
        const body = await readJson(req);
        state.video.url = typeof body.url === 'string' && body.url.length > 0 ? body.url : null;
        state.video.key = typeof body.key === 'string' && body.key.length > 0 ? body.key : null;
        state.video.model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'fal-ai/text-to-video';
        sendJson(res, 200, { ok: true, configured: state.video.url !== null, model: state.video.model });
        return;
      }
      if (sub === '/engine/speech/config' && req.method === 'POST') {
        const body = await readJson(req);
        state.speech.url = typeof body.url === 'string' && body.url.length > 0 ? body.url : null;
        state.speech.key = typeof body.key === 'string' && body.key.length > 0 ? body.key : null;
        state.speech.model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'gpt-4o-mini-tts';
        sendJson(res, 200, { ok: true, configured: state.speech.url !== null, model: state.speech.model });
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
      if (sub === '/engine/luts' && req.method === 'GET') {
        sendJson(res, 200, listProjectLuts());
        return;
      }
      if (sub === '/engine/upload' && req.method === 'POST') {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const rawName = requestUrl.searchParams.get('name') ?? '';
        const kind = requestUrl.searchParams.get('kind') === 'lut' ? 'lut' : 'media';
        const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
        if (safeName.length === 0 || safeName === '.' || safeName === '..') {
          sendJson(res, 400, { error: { code: 'invalid-upload', message: 'name is required' } });
          return;
        }
        try {
          const limit = kind === 'lut' ? 16 * 1024 * 1024 : 256 * 1024 * 1024;
          const bytes = await readBody(req, limit);
          if (bytes.length === 0) throw new Error('upload is empty');
          if (kind === 'lut') {
            if (!safeName.toLowerCase().endsWith('.cube')) throw new Error('LUT upload must be a .cube file');
            const text = bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)).toString('utf8');
            if (!/LUT_3D_SIZE\s+\d+/i.test(text)) throw new Error('invalid LUT: missing LUT_3D_SIZE');
            const id = createHash('sha256').update(bytes).digest('hex');
            const directory = projectLutDirectory();
            mkdirSync(directory, { recursive: true });
            writeFileSync(path.join(directory, `${id}.cube`), bytes);
            const name = safeName.replace(/\.cube$/i, '').slice(0, 128) || 'Imported LUT';
            writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ name }), 'utf8');
            sendJson(res, 200, { kind: 'lut', lut: { id, name, intensity: 1 }, luts: listProjectLuts() });
            return;
          }
          const directory = path.join(CACHE_ROOT, 'uploads', randomUUID());
          mkdirSync(directory, { recursive: true });
          const target = path.join(directory, safeName);
          writeFileSync(target, bytes);
          const catalog = importMedia([target]);
          sendJson(res, 200, { kind: 'media', catalog });
          return;
        } catch (error) {
          sendJson(res, 400, { error: { code: 'upload-failed', message: error instanceof Error ? error.message : String(error) } });
          return;
        }
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
    'Render every timeline frame, encode H.264/H.265/ProRes, and mux the linear audio mixdown. Set hdr10 for the true HDR10 path (requires HDR PQ sources; SDR/text/transformed layers and audio are rejected rather than mislabelled).',
    {
      type: 'object',
      properties: {
        outPath: { type: 'string' },
        codec: { type: 'string', enum: ['h264', 'h265', 'prores', 'prores4444'] },
        quality: { type: 'string', enum: ['720p', '1080p', '4k'] },
        bitDepth: { type: 'number', enum: [8, 10] },
        duckMusic: { type: 'boolean' },
        hdr10: { type: 'boolean' },
      },
      required: ['outPath'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(
        ensureEngine().exportVideo(args.outPath, args.codec ?? 'h264', args.quality ?? '1080p', args.bitDepth === 10 ? 10 : null, args.duckMusic === true, args.hdr10 === true),
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
    'opentake_route_b_install_search_model',
    'Verify/stage the SigLIP2 model assets in the persistent models dir; optionally download missing pinned files.',
    {
      type: 'object',
      properties: { download: { type: 'boolean' }, wait: { type: 'boolean' } },
      additionalProperties: false,
    },
    async (args) => {
      const report = await installModel(SEARCH_MODELS_DIR, {
        download: args.download === true,
        wait: args.wait === true,
        timeoutSeconds: 1800,
      });
      state.searchCapability = null;
      state.searchAttempted = false;
      return { text: JSON.stringify(report), data: report };
    },
  );

  registerTool(
    'opentake_route_b_search',
    'Project search over media names/cached transcripts and indexed SigLIP2 visual moments.',
    { type: 'object', properties: { query: { type: 'string' }, imageBase64: { type: 'string' } }, additionalProperties: false },
    async (args) => {
      const value = visualSearch(args.query ?? '', args.imageBase64 ?? null);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_capture_frame',
    'Composite/decode one frame and import it as a still image asset.',
    {
      type: 'object',
      properties: { frame: { type: 'number' }, nameBase: { type: 'string' }, sourceMediaId: { type: 'string' } },
      required: ['frame'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().captureFrameToMedia(
        args.frame,
        args.nameBase ?? 'Frame',
        args.sourceMediaId ?? null,
      ));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_generate_speech',
    'Generate speech through the configured OpenAI-compatible TTS provider and import it as audio.',
    {
      type: 'object',
      properties: { text: { type: 'string' }, voice: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    async (args) => {
      const value = await generateSpeech(args.text, args.voice);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_generate_video',
    'Generate a short video through the configured provider and import it into the project.',
    { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    async (args) => {
      const value = await generateVideo(args.prompt);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_export_audio',
    'Export the timeline audio mixdown to M4A(AAC) or MP3.',
    {
      type: 'object',
      properties: { outPath: { type: 'string' }, format: { type: 'string', enum: ['m4a', 'mp3'] }, duckMusic: { type: 'boolean' } },
      required: ['outPath'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().exportAudio(args.outPath, args.format ?? 'm4a', args.duckMusic === true));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_import_folder',
    'Recursively import supported media files from a folder into the project.',
    {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
      additionalProperties: false,
    },
    async (args) => {
      const value = importFolder(args.path, args.recursive === true);
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_prepare_denoise',
    'Validate/process an audio clip with the local denoise profile and return its AudioDenoise config.',
    {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        mode: { type: 'string', enum: ['adaptive', 'voice'] },
        strength: { type: 'number' },
        previewEnabled: { type: 'boolean' },
      },
      required: ['clipId'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().prepareDenoise(String(args.clipId ?? ''), args.mode, args.strength, args.previewEnabled));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_analyze_loudness',
    'Analyze an audio-bearing clip and return a loudness-normalization result.',
    {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        targetLufs: { type: 'number' },
        truePeakCeilingDbtp: { type: 'number' },
      },
      required: ['clipId'],
      additionalProperties: false,
    },
    async (args) => {
      const value = JSON.parse(ensureEngine().analyzeLoudness(String(args.clipId ?? ''), args.targetLufs, args.truePeakCeilingDbtp));
      return { text: JSON.stringify(value), data: value };
    },
  );

  registerTool(
    'opentake_route_b_analyze_stabilization',
    'Analyze a video clip and return an editable stabilization track (apply via edit_apply).',
    { type: 'object', properties: { clipId: { type: 'string' } }, required: ['clipId'], additionalProperties: false },
    async (args) => {
      const value = JSON.parse(ensureEngine().analyzeStabilization(String(args.clipId ?? '')));
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
