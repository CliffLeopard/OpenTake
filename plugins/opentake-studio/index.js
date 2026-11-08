/**
 * Host half of OpenTake Studio — a native DeepSeek Harness video editor.
 *
 * There is no OpenTake process and no MCP bridge. This plugin owns the project
 * and timeline state, imports media with ffprobe, composes previews through
 * same-origin routes, exports with ffmpeg, and registers native DSH tools that
 * operate on the same service as the browser editor.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ModelError,
  applyOperation,
  findClip,
  findMedia,
  findTrack,
  timelineDurationFrames,
} from './lib/model.js';
import { createProjectAt, openProjectAt, saveProjectAt } from './lib/project.js';
import {
  ensureThumbnail,
  importToProject,
  mediaFilePath,
  mediaMimeType,
  probeMedia,
  resolveTools,
} from './lib/media.js';
import { defaultExtensionForCodec, runExport } from './lib/export.js';
import { captionClipFromSegments, parseSubtitles, projectCaptionSegments, serializeSubtitles } from './lib/captions.js';
import {
  addLibraryItemToProject,
  deleteLibraryItem,
  ensureLibraryThumbnail,
  importFolderToLibrary,
  libraryAssetPath,
  libraryPaths,
  listLibrary,
  updateLibraryItem,
} from './lib/library.js';
import {
  TRANSCRIPT_CAPTION_STYLE,
  readTranscripts,
  transcribeMedia,
  transcriptToCaptionSegments,
  transcriptionSettings,
} from './lib/transcribe.js';
import { generateImage, generateSpeech, generationProviders } from './lib/generate.js';

export const name = 'opentake-studio';
export const inject = ['tools', 'webServer', 'connection'];

const PLUGIN_VERSION = '0.1.0';
const PREFIX = '/opentake-studio';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UNDO = 100;
const DEFAULT_IMAGE_FRAMES = 150;

class RouteError extends Error {
  constructor(message, code = 'invalid-input', status = 400) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value) {
  return String(value ?? 'opentake-studio')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'opentake-studio';
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', filename = null) {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  if (filename !== null) res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.end(text);
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

async function readBoundedJson(req, limit = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) {
      req.resume();
      throw new RouteError('The request body is too large', 'invalid-input', 413);
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new RouteError('The request body is not valid JSON', 'invalid-input');
  }
  if (!isRecord(parsed)) throw new RouteError('The request body must be a JSON object', 'invalid-input');
  return parsed;
}

function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null;
  const match = /^(\d*)-(\d*)$/.exec(header.slice(6).trim());
  if (match === null) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection');
  const toolRegistry = ctx.get('tools');

  const state = {
    disposed: false,
    root: null,
    paths: null,
    project: null,
    undo: [],
    redo: [],
    saveTimer: null,
    saveError: null,
    lastError: null,
    export: { state: 'idle', progress: 0, output: null, error: null },
    exportAbort: null,
  };

  function stopExportForProjectSwitch() {
    if (state.exportAbort !== null) {
      state.exportAbort.abort();
      state.exportAbort = null;
    }
    state.export = { state: 'idle', progress: 0, output: null, error: null };
  }

  function safeDecode(raw, label) {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new RouteError(`Malformed ${label} in the URL`, 'invalid-input');
    }
  }

  function ensureProject() {
    if (state.project === null || state.paths === null) {
      throw new RouteError('Open or create a project first', 'no-project', 409);
    }
    return state.project;
  }

  function scheduleSave() {
    if (state.saveTimer !== null) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      void saveNow();
    }, 250);
    state.saveTimer.unref?.();
  }

  async function saveNow() {
    if (state.project === null || state.paths === null) return;
    try {
      await saveProjectAt(state.paths.root, state.project);
      state.saveError = null;
    } catch (error) {
      state.saveError = messageOf(error);
    }
  }

  function commit(project) {
    if (state.project !== null) {
      state.undo.push(state.project);
      if (state.undo.length > MAX_UNDO) state.undo.shift();
    }
    state.redo = [];
    state.project = project;
    scheduleSave();
  }

  function resetHistory() {
    state.undo = [];
    state.redo = [];
  }

  async function buildState() {
    let asrInfo = null;
    try {
      const settings = transcriptionSettings();
      asrInfo = {
        url: settings.url,
        model: settings.model,
        keyRef: settings.keyRef,
        language: settings.language ?? null,
        loopback: settings.loopback,
        configured: settings.loopback || (process.env[settings.keyRef]?.length ?? 0) > 0,
      };
    } catch {
      asrInfo = { configured: false, error: 'invalid-asr-url' };
    }
    let ffmpeg;
    try {
      ffmpeg = await resolveTools();
    } catch {
      ffmpeg = { available: false, ffmpeg: null, ffprobe: null, version: null };
    }
    return {
      version: 1,
      project: state.project,
      projectRoot: state.paths?.root ?? null,
      ffmpeg,
      export: { ...state.export },
      canUndo: state.undo.length > 0,
      canRedo: state.redo.length > 0,
      saveError: state.saveError,
      lastError: state.lastError,
      pluginVersion: PLUGIN_VERSION,
      ...(asrInfo === null ? {} : { asr: asrInfo }),
      generation: await generationProviders(ctx),
    };
  }

  function trackTypeForMedia(media) {
    return media.kind === 'audio' ? 'audio' : 'video';
  }

  function pickTrack(project, type, trackId, createdTracks) {
    if (typeof trackId === 'string' && trackId.length > 0) {
      const createdType = createdTracks?.get(trackId);
      if (createdType !== undefined) {
        if (createdType !== type) throw new RouteError(`Track ${trackId} is not a ${type} track`, 'model-error');
        return trackId;
      }
      const track = findTrack(project, trackId);
      if (track === null) throw new RouteError(`Track ${trackId} does not exist`, 'model-error');
      if (track.type !== type) throw new RouteError(`Track ${trackId} is not a ${type} track`, 'model-error');
      return track.id;
    }
    const existing = project.tracks.find((track) => track.type === type);
    return existing?.id ?? null;
  }

  function normalizeOperations(operations) {
    const project = ensureProject();
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new RouteError('At least one operation is required', 'invalid-input');
    }
    const expanded = [];
    const pendingTracks = new Map();
    const createdTracks = new Map();
    const createdMedia = new Map();
    for (const operation of operations) {
      if (!isRecord(operation) || typeof operation.type !== 'string') {
        throw new RouteError('Every operation needs a type', 'invalid-input');
      }
      const op = { ...operation };
      if (op.type === 'add-media' && isRecord(op.media) && typeof op.media.id === 'string') {
        createdMedia.set(op.media.id, op.media);
      }
      if (op.type === 'add-track') {
        op.trackId = typeof op.trackId === 'string' && op.trackId.length > 0 ? op.trackId : randomUUID();
        if (op.trackType !== 'video' && op.trackType !== 'audio') {
          throw new RouteError('add-track needs trackType video or audio', 'invalid-input');
        }
        createdTracks.set(op.trackId, op.trackType);
      } else if (op.type === 'add-clip') {
        const media = findMedia(project, op.mediaId) ?? createdMedia.get(op.mediaId) ?? null;
        if (media === null) throw new RouteError(`Unknown media ${String(op.mediaId)}`, 'invalid-input');
        op.clipId = typeof op.clipId === 'string' && op.clipId.length > 0 ? op.clipId : randomUUID();
        op.splitRightClipId = randomUUID();
        const type = trackTypeForMedia(media);
        let trackId = pickTrack(project, type, op.trackId, createdTracks);
        if (trackId === null) trackId = pendingTracks.get(type) ?? null;
        if (trackId === null) {
          trackId = randomUUID();
          pendingTracks.set(type, trackId);
          createdTracks.set(trackId, type);
          expanded.push({ type: 'add-track', trackId, trackType: type, name: type === 'audio' ? 'Audio' : 'Video' });
        }
        op.trackId = trackId;
        op.startFrame = intOr(op.startFrame, 0);
        op.trimStartFrame = intOr(op.trimStartFrame, 0);
        const maxSource = media.durationFrames;
        if (maxSource !== null) {
          if (op.trimStartFrame >= maxSource) op.trimStartFrame = 0;
          const available = Math.max(1, maxSource - op.trimStartFrame);
          op.durationFrames = Math.min(intOr(op.durationFrames, available), available);
        } else {
          const imageDefault = Math.max(1, Math.round(project.fps * 5));
          op.durationFrames = intOr(op.durationFrames, imageDefault);
        }
        if (op.durationFrames < 1) op.durationFrames = 1;
      } else if (op.type === 'add-text') {
        op.clipId = typeof op.clipId === 'string' && op.clipId.length > 0 ? op.clipId : randomUUID();
        op.splitRightClipId = randomUUID();
        op.startFrame = intOr(op.startFrame, 0);
        op.durationFrames = Math.max(1, intOr(op.durationFrames, 90));
        const rangeEnd = op.startFrame + op.durationFrames;
        if (typeof op.trackId === 'string' && op.trackId.length > 0) {
          op.trackId = pickTrack(project, 'video', op.trackId, createdTracks);
        } else {
          // Text is an overlay: use a dedicated Text track with a free interval,
          // never the visual track it would otherwise overwrite/split.
          const existingText = project.tracks.find(
            (track) =>
              track.type === 'video' &&
              track.name === 'Text' &&
              !track.clips.some(
                (clip) => clip.startFrame < rangeEnd && clip.startFrame + clip.durationFrames > op.startFrame,
              ),
          );
          if (existingText !== undefined) {
            op.trackId = existingText.id;
          } else {
            op.trackId = randomUUID();
            createdTracks.set(op.trackId, 'video');
            expanded.push({ type: 'add-track', trackId: op.trackId, trackType: 'video', name: 'Text' });
          }
        }
        op.text = normalizeTextStyle(op.text, op.content);
      } else if (op.type === 'add-effect') {
        if (!isRecord(op.effect)) throw new RouteError('add-effect needs an effect object', 'invalid-input');
        op.effect = {
          ...op.effect,
          id: typeof op.effect.id === 'string' && op.effect.id.length > 0 ? op.effect.id : randomUUID(),
          enabled: op.effect.enabled !== false,
        };
      } else if (op.type === 'add-marker') {
        if (!isRecord(op.marker)) throw new RouteError('add-marker needs a marker object', 'invalid-input');
        op.marker = {
          ...op.marker,
          id: typeof op.marker.id === 'string' && op.marker.id.length > 0 ? op.marker.id : randomUUID(),
          frame: intOr(op.marker.frame, 0),
          label: typeof op.marker.label === 'string' ? op.marker.label : 'Marker',
          color: typeof op.marker.color === 'string' ? op.marker.color : '#fbbf24',
        };
      } else if (op.type === 'add-transition') {
        if (!isRecord(op.transition)) throw new RouteError('add-transition needs a transition object', 'invalid-input');
        op.transition = {
          ...op.transition,
          id:
            typeof op.transition.id === 'string' && op.transition.id.length > 0
              ? op.transition.id
              : randomUUID(),
          type: typeof op.transition.type === 'string' ? op.transition.type : 'dissolve',
          durationFrames: Math.max(1, intOr(op.transition.durationFrames, Math.round(project.fps / 2))),
        };
      } else if (op.type === 'add-caption') {
        op.clipId = typeof op.clipId === 'string' && op.clipId.length > 0 ? op.clipId : randomUUID();
        op.splitRightClipId = randomUUID();
        op.startFrame = intOr(op.startFrame, 0);
        op.durationFrames = Math.max(1, intOr(op.durationFrames, 90));
        const rangeEnd = op.startFrame + op.durationFrames;
        if (typeof op.trackId === 'string' && op.trackId.length > 0) {
          op.trackId = pickTrack(project, 'video', op.trackId, createdTracks);
        } else {
          const existingCaption = project.tracks.find(
            (track) =>
              track.type === 'video' &&
              track.name === 'Captions' &&
              !track.clips.some(
                (clip) => clip.startFrame < rangeEnd && clip.startFrame + clip.durationFrames > op.startFrame,
              ),
          );
          if (existingCaption !== undefined) {
            op.trackId = existingCaption.id;
          } else {
            op.trackId = randomUUID();
            createdTracks.set(op.trackId, 'video');
            expanded.push({ type: 'add-track', trackId: op.trackId, trackType: 'video', name: 'Captions' });
          }
        }
        op.style = normalizeCaptionStyle(op.style);
        op.segments = Array.isArray(op.segments) ? op.segments : [];
      } else if (op.type === 'move-clip') {
        op.splitRightClipId = randomUUID();
      } else if (op.type === 'split-clip') {
        op.leftClipId = typeof op.leftClipId === 'string' && op.leftClipId.length > 0 ? op.leftClipId : randomUUID();
        op.rightClipId = typeof op.rightClipId === 'string' && op.rightClipId.length > 0 ? op.rightClipId : randomUUID();
      }
      expanded.push(op);
    }
    return expanded;
  }

  function normalizeTextStyle(input, content) {
    const style = isRecord(input) ? input : {};
    return {
      content: typeof style.content === 'string' ? style.content : String(content ?? 'Text'),
      fontSize: intOr(style.fontSize, 48) || 48,
      color: typeof style.color === 'string' ? style.color : '#ffffff',
      fontWeight: style.fontWeight === '400' || style.fontWeight === '700' ? style.fontWeight : '600',
      align: style.align === 'left' || style.align === 'right' ? style.align : 'center',
    };
  }

  function normalizeCaptionStyle(input) {
    const style = isRecord(input) ? input : {};
    return {
      fontSize: intOr(style.fontSize, 48) || 48,
      color: typeof style.color === 'string' ? style.color : '#ffffff',
      fontWeight: style.fontWeight === '400' || style.fontWeight === '700' ? style.fontWeight : '600',
      align: style.align === 'left' || style.align === 'right' ? style.align : 'center',
      background: typeof style.background === 'string' ? style.background : 'rgba(0,0,0,0.35)',
    };
  }

  async function applyOperations(operations) {
    const current = ensureProject();
    let next = current;
    for (const operation of normalizeOperations(operations)) {
      next = applyOperation(next, operation);
    }
    commit(next);
    state.lastError = null;
    await saveNow();
    return buildState();
  }

  async function maybeAutoTracks(mediaList) {
    const operations = mediaList.map((media) => ({ type: 'add-media', media }));
    return operations;
  }

  async function createProjectFromPath(input) {
    const root = projectRootFromInput(input);
    stopExportForProjectSwitch();
    const created = await createProjectAt(root, {
      name: typeof input.name === 'string' ? input.name : undefined,
      fps: input.fps,
      width: input.width,
      height: input.height,
    });
    state.root = created.paths.root;
    state.paths = created.paths;
    state.project = created.project;
    state.saveError = null;
    state.lastError = null;
    resetHistory();
    return buildState();
  }

  async function openProjectFromPath(input) {
    const root = projectRootFromInput(input);
    stopExportForProjectSwitch();
    const opened = await openProjectAt(root);
    state.root = opened.paths.root;
    state.paths = opened.paths;
    state.project = opened.project;
    state.saveError = null;
    state.lastError = null;
    resetHistory();
    return buildState();
  }

  function projectRootFromInput(input) {
    const root = typeof input === 'string' ? input : input?.path;
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new RouteError('A project folder path is required', 'invalid-input');
    }
    if (!path.isAbsolute(root)) throw new RouteError('The project folder must be an absolute path', 'invalid-input');
    return root;
  }

  async function importFolder(input) {
    ensureProject();
    const folderPath = input.path;
    if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) {
      throw new RouteError('An absolute media folder path is required', 'invalid-input');
    }
    const result = await importToProject({
      projectRoot: state.paths.root,
      folderPath,
      project: state.project,
    });
    if (result.media.length > 0) {
      await applyOperations(await maybeAutoTracks(result.media));
    }
    return { ...(await buildState()), imported: result.imported, skipped: result.skipped };
  }

  async function uploadMedia(req, name) {
    ensureProject();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new RouteError('A file name is required', 'invalid-input');
    }
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._ -]+/g, '_');
    if (safeName.length === 0) throw new RouteError('The file name is not valid', 'invalid-input');
    const id = randomUUID();
    const fileName = `${id}-${safeName}`;
    const target = path.join(state.paths.mediaDir, fileName);
    let size = 0;
    await mkdir(state.paths.mediaDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const out = createWriteStream(target, { flags: 'wx' });
        let failed = false;
        req.on('data', (chunk) => {
          if (failed) return;
          size += chunk.byteLength;
          if (size > MAX_UPLOAD_BYTES) {
            failed = true;
            req.unpipe(out);
            out.destroy();
            reject(new RouteError('The upload is too large', 'invalid-input', 413));
          }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
    try {
      const probe = await probeMedia(target);
      const media = {
        id,
        name: safeName,
        kind: probe.kind,
        fileName,
        durationFrames: probe.durationSeconds === null ? null : Math.round(probe.durationSeconds * state.project.fps),
        sourceDurationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        hasAudio: probe.hasAudio,
        sizeBytes: size,
        importedAt: Date.now(),
      };
      return await applyOperations([{ type: 'add-media', media }]);
    } catch (error) {
      state.lastError = messageOf(error);
      throw error instanceof RouteError ? error : new RouteError(messageOf(error), 'media-error');
    }
  }

  async function serveFileWithRange(req, res, file, contentType) {
    const info = await stat(file);
    if (!info.isFile()) throw new RouteError('File not found', 'media-not-found', 404);
    const size = info.size;
    const parsed = parseRange(req.headers.range, size);
    if (parsed === 'invalid') {
      res.statusCode = 416;
      res.setHeader('content-range', `bytes */${size}`);
      res.end();
      return;
    }
    const start = parsed === null ? 0 : parsed.start;
    const end = parsed === null ? size - 1 : parsed.end;
    res.statusCode = parsed === null ? 200 : 206;
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(end - start + 1));
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'no-store');
    if (parsed !== null) res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise((resolve, reject) => {
      const stream = createReadStream(file, { start, end });
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }

  async function serveMediaFile(req, res, mediaId) {
    const project = ensureProject();
    const media = findMedia(project, mediaId);
    if (media === null) {
      sendJson(res, 404, { error: { code: 'media-not-found', message: 'Unknown media' } });
      return;
    }
    let file;
    try {
      file = mediaFilePath(state.paths.root, media);
    } catch (error) {
      sendJson(res, 400, { error: { code: 'media-error', message: messageOf(error) } });
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      sendJson(res, 404, { error: { code: 'media-not-found', message: 'The media file is missing' } });
      return;
    }
    const contentType = mediaMimeType(media.fileName) ?? 'application/octet-stream';
    const range = parseRange(req.headers.range, info.size);
    if (range === 'invalid') {
      res.statusCode = 416;
      res.setHeader('content-range', `bytes */${info.size}`);
      res.end();
      return;
    }
    if (range === null) {
      res.statusCode = 200;
      res.setHeader('content-type', contentType);
      res.setHeader('content-length', String(info.size));
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    res.statusCode = 206;
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(range.end - range.start + 1));
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function serveThumbnail(res, mediaId) {
    const project = ensureProject();
    const media = findMedia(project, mediaId);
    if (media === null) {
      sendJson(res, 404, { error: { code: 'media-not-found', message: 'Unknown media' } });
      return;
    }
    let thumbnail;
    try {
      thumbnail = await ensureThumbnail({ projectRoot: state.paths.root, media });
    } catch (error) {
      sendJson(res, 500, { error: { code: 'media-error', message: messageOf(error) } });
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'no-store');
    const stream = createReadStream(thumbnail);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function undo() {
    const project = ensureProject();
    if (state.undo.length === 0) throw new RouteError('Nothing to undo', 'invalid-input');
    state.redo.push(project);
    state.project = state.undo.pop();
    scheduleSave();
    return buildState();
  }

  async function redo() {
    ensureProject();
    if (state.redo.length === 0) throw new RouteError('Nothing to redo', 'invalid-input');
    state.undo.push(state.project);
    state.project = state.redo.pop();
    scheduleSave();
    return buildState();
  }

  function summaryOf(project) {
    if (project === null) return null;
    return {
      name: project.name,
      fps: project.fps,
      width: project.width,
      height: project.height,
      durationFrames: timelineDurationFrames(project),
      media: project.media.map((media) => ({
        id: media.id,
        name: media.name,
        kind: media.kind,
        durationFrames: media.durationFrames,
        width: media.width,
        height: media.height,
      })),
      tracks: project.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        name: track.name,
        muted: track.muted,
        hidden: track.hidden,
        ...(track.volume === undefined ? {} : { volume: track.volume }),
        clips: track.clips.map((clip) => ({
          id: clip.id,
          type: clip.type,
          mediaId: clip.mediaId,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          trimStartFrame: clip.trimStartFrame,
          volume: clip.volume,
          opacity: clip.opacity,
          transform: clip.transform,
          ...(clip.text === null ? {} : { text: clip.text.content }),
          ...(clip.speed === undefined ? {} : { speed: clip.speed }),
          ...(clip.fadeInFrames === undefined ? {} : { fadeInFrames: clip.fadeInFrames }),
          ...(clip.fadeOutFrames === undefined ? {} : { fadeOutFrames: clip.fadeOutFrames }),
          ...(Array.isArray(clip.effects) && clip.effects.length > 0 ? { effects: clip.effects } : {}),
          ...(clip.keyframes !== undefined && Object.keys(clip.keyframes).length > 0
            ? { keyframes: clip.keyframes }
            : {}),
          ...(clip.caption === undefined ? {} : { caption: clip.caption }),
          ...(clip.crop === undefined ? {} : { crop: clip.crop }),
          ...(clip.mask === undefined ? {} : { mask: clip.mask }),
          ...(clip.blendMode === undefined ? {} : { blendMode: clip.blendMode }),
        })),
      })),
      ...(project.markers === undefined ? {} : { markers: project.markers }),
      ...(project.transitions === undefined ? {} : { transitions: project.transitions }),
    };
  }

  function addTrack(type) {
    ensureProject();
    const trackId = randomUUID();
    return applyOperations([{ type: 'add-track', trackId, trackType: type, name: type === 'audio' ? 'Audio' : 'Video' }]).then(
      () => ({ trackId, state: buildState() }),
    );
  }

  async function addClip(input) {
    const project = ensureProject();
    const media = findMedia(project, input.mediaId);
    if (media === null) throw new RouteError(`Unknown media ${String(input.mediaId)}`, 'invalid-input');
    const op = {
      type: 'add-clip',
      mediaId: media.id,
      startFrame: intOr(input.startFrame, 0),
      ...(typeof input.trackId === 'string' ? { trackId: input.trackId } : {}),
      ...(input.durationFrames === undefined ? {} : { durationFrames: input.durationFrames }),
      ...(input.trimStartFrame === undefined ? {} : { trimStartFrame: input.trimStartFrame }),
    };
    const normalized = normalizeOperations([op]);
    const clipOp = normalized.find((candidate) => candidate.type === 'add-clip');
    const response = await applyOperations(normalized);
    return { clipId: clipOp.clipId, trackId: clipOp.trackId, state: response };
  }

  async function addText(input) {
    ensureProject();
    const op = {
      type: 'add-text',
      startFrame: intOr(input.startFrame, 0),
      durationFrames: intOr(input.durationFrames, 90),
      content: input.content,
      ...(typeof input.trackId === 'string' ? { trackId: input.trackId } : {}),
      ...(isRecord(input.transform) ? { transform: input.transform } : {}),
      ...(isRecord(input.text) ? { text: input.text } : {}),
    };
    const normalized = normalizeOperations([op]);
    const textOp = normalized.find((candidate) => candidate.type === 'add-text');
    const response = await applyOperations(normalized);
    return { clipId: textOp.clipId, trackId: textOp.trackId, state: response };
  }

  async function splitClip(clipId, atFrame) {
    ensureProject();
    if (typeof clipId !== 'string') throw new RouteError('clipId is required', 'invalid-input');
    const found = findClip(ensureProject(), clipId);
    if (found === null) throw new RouteError(`Unknown clip ${clipId}`, 'invalid-input');
    const frame = intOr(atFrame, -1);
    if (frame <= found.clip.startFrame || frame >= found.clip.startFrame + found.clip.durationFrames) {
      throw new RouteError('The split frame must be strictly inside the clip', 'invalid-input');
    }
    const normalized = normalizeOperations([{ type: 'split-clip', clipId, atFrame: frame }]);
    const response = await applyOperations(normalized);
    const split = normalized.find((candidate) => candidate.type === 'split-clip');
    return { leftClipId: split.leftClipId, rightClipId: split.rightClipId, state: response };
  }

  async function renderTextAsset(input) {
    const project = ensureProject();
    const clipId = typeof input.clipId === 'string' ? input.clipId : '';
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(clipId) || clipId === '.' || clipId === '..') {
      throw new RouteError('clipId is not a safe file identifier', 'invalid-input');
    }
    const found = clipId.length === 0 ? null : findClip(project, clipId);
    if (found === null || (found.clip.type !== 'text' && found.clip.type !== 'caption')) {
      throw new RouteError('renderTextAsset needs an existing text or caption clip id', 'invalid-input');
    }
    const segmentIndex = input.segmentIndex === undefined ? null : Number(input.segmentIndex);
    if (segmentIndex !== null && (!Number.isInteger(segmentIndex) || segmentIndex < 0)) {
      throw new RouteError('segmentIndex must be a non-negative integer', 'invalid-input');
    }
    if (found.clip.type === 'caption' && segmentIndex === null) {
      throw new RouteError('caption renders need a segmentIndex', 'invalid-input');
    }
    const dataUrl = typeof input.dataUrl === 'string' ? input.dataUrl : '';
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (match === null) throw new RouteError('dataUrl must be a base64 PNG data URL', 'invalid-input');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new RouteError('The rendered text image is empty or too large', 'invalid-input', 413);
    }
    const renderDir = path.join(state.paths.root, 'renders');
    await mkdir(renderDir, { recursive: true });
    const fileName = segmentIndex === null ? `${clipId}.png` : `${clipId}-seg-${segmentIndex}.png`;
    await writeFile(path.join(renderDir, fileName), bytes);
    return { text: 'Text render saved', data: { clipId, segmentIndex, bytes: bytes.length } };
  }

  async function uploadLut(req, rawName) {
    ensureProject();
    const safeName = String(rawName ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120);
    if (!safeName.toLowerCase().endsWith('.cube')) {
      throw new RouteError('A .cube LUT file name is required', 'invalid-input');
    }
    const dir = path.join(state.paths.root, 'luts');
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, safeName);
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = createWriteStream(target, { flags: 'wx' });
        let failed = false;
        req.on('data', (chunk) => {
          if (failed) return;
          size += chunk.byteLength;
          if (size > 32 * 1024 * 1024) {
            failed = true;
            req.unpipe(out);
            out.destroy();
            reject(new RouteError('The LUT is too large (max 32 MiB)', 'invalid-input', 413));
          }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
    return { text: 'LUT saved', data: { file: safeName, bytes: size } };
  }

  function libraryItemById(itemId) {
    return listLibrary({}).then((result) => {
      const item = result.items.find((entry) => entry.id === itemId);
      if (item === undefined) throw new RouteError('Library item not found', 'library-item-not-found', 404);
      return item;
    });
  }

  async function importLibraryFolder(input) {
    const folder = input.path;
    if (typeof folder !== 'string' || folder.trim().length === 0) {
      throw new RouteError('A library import needs an absolute folder path', 'invalid-input');
    }
    const result = await importFolderToLibrary({ folderPath: path.resolve(folder) });
    return { items: result.library.items, imported: result.imported, skipped: result.skipped };
  }

  async function addLibraryItemToCurrentProject(input) {
    const project = ensureProject();
    const itemId = typeof input.id === 'string' ? input.id : '';
    if (itemId.length === 0) throw new RouteError('Library add needs an item id', 'invalid-input');
    const media = await addLibraryItemToProject({
      projectRoot: state.paths.root,
      projectFps: project.fps,
      itemId,
    });
    return applyOperations([{ type: 'add-media', media }]);
  }

  async function serveLibraryFile(req, res, itemId) {
    const item = await libraryItemById(itemId);
    const file = libraryAssetPath(undefined, item);
    await serveFileWithRange(req, res, file, mediaMimeType(item.name));
  }

  async function serveLibraryThumbnail(res, itemId) {
    const item = await libraryItemById(itemId);
    const thumbnail = await ensureLibraryThumbnail({ item });
    const data = await readFile(thumbnail);
    res.statusCode = 200;
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'no-store');
    res.end(data);
  }

  async function generateProjectImage(input) {
    const project = ensureProject();
    const media = await generateImage({
      ctx,
      projectRoot: state.paths.root,
      prompt: input.prompt,
      size: input.size,
    });
    void project;
    return applyOperations([{ type: 'add-media', media }]);
  }

  async function generateProjectSpeech(input) {
    const project = ensureProject();
    const media = await generateSpeech({
      ctx,
      project,
      projectRoot: state.paths.root,
      text: input.text,
      voice: input.voice,
      model: input.model,
    });
    return applyOperations([{ type: 'add-media', media }]);
  }

  async function transcribeProjectMedia(input) {
    const project = ensureProject();
    const media = findMedia(project, input.mediaId);
    if (media === null) throw new RouteError('Unknown media id', 'invalid-input');
    const transcript = await transcribeMedia({
      ctx,
      project,
      projectRoot: state.paths.root,
      media,
    });
    let resultState = null;
    if (input.createCaptions === true) {
      const caption = transcriptToCaptionSegments(transcript, project.fps);
      if (caption !== null) {
        resultState = await applyOperations([
          {
            type: 'add-caption',
            ...caption,
            style: TRANSCRIPT_CAPTION_STYLE,
          },
        ]);
      }
    }
    return { transcript, state: resultState };
  }

  async function searchProject(query) {
    const project = ensureProject();
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle.length === 0) return { query: '', results: [] };
    const results = [];
    for (const media of project.media) {
      if (media.name.toLowerCase().includes(needle)) {
        results.push({ kind: 'media', mediaId: media.id, name: media.name, snippet: media.name });
      }
    }
    const transcripts = await readTranscripts(state.paths.root);
    for (const transcript of transcripts) {
      if (transcript.text.toLowerCase().includes(needle)) {
        const hit = transcript.segments.find((segment) => segment.text.toLowerCase().includes(needle));
        results.push({
          kind: 'transcript',
          mediaId: transcript.mediaId,
          name: transcript.mediaName,
          startSeconds: hit?.startSeconds ?? 0,
          endSeconds: hit?.endSeconds ?? 0,
          snippet: hit?.text ?? transcript.text.slice(0, 160),
        });
      }
    }
    return { query, results };
  }

  async function importCaptions(input) {
    const project = ensureProject();
    const text = typeof input.text === 'string' ? input.text : '';
    const parsed = parseSubtitles(text);
    const caption = captionClipFromSegments(project, parsed.segments, {
      style: isRecord(input.style) ? input.style : undefined,
      ...(typeof input.trackId === 'string' ? { trackId: input.trackId } : {}),
    });
    return applyOperations([{ type: 'add-caption', ...caption }]);
  }

  function exportCaptions(format) {
    const project = ensureProject();
    const normalized = format === 'vtt' ? 'vtt' : 'srt';
    const segments = projectCaptionSegments(project);
    return { text: serializeSubtitles(segments, normalized), format: normalized };
  }

  async function startExport(input) {
    ensureProject();
    if (state.export.state === 'running') throw new RouteError('An export is already running', 'export-running', 409);
    const project = state.project;
    const durationFrames = timelineDurationFrames(project);
    if (durationFrames <= 0) throw new RouteError('Add at least one clip before exporting', 'invalid-input');
    const tools = await resolveTools();
    if (!tools.available) throw new RouteError('ffmpeg is not available on this machine', 'ffmpeg-unavailable', 503);
    let output;
    if (typeof input.path === 'string' && input.path.trim().length > 0) {
      output = path.resolve(input.path);
    } else {
      const extension = defaultExtensionForCodec(input.codec ?? 'h264');
      output = path.join(state.paths.exportsDir, `${slugify(project.name)}-${Date.now()}${extension}`);
    }
    if (existsSync(output) && input.overwrite !== true) {
      throw new RouteError('The output file already exists; pass overwrite:true to replace it', 'output-exists', 409);
    }
    await mkdir(path.dirname(output), { recursive: true });
    state.export = { state: 'running', progress: 0, output, error: null };
    const controller = new AbortController();
    state.exportAbort = controller;
    const exportProject = structuredClone(project);
    const exportOptions = {};
    for (const key of ['codec', 'width', 'height', 'fps', 'crf', 'bitrate']) {
      if (input[key] !== undefined) exportOptions[key] = input[key];
    }
    void runExport({
      project: exportProject,
      projectRoot: state.paths.root,
      outputPath: output,
      options: exportOptions,
      signal: controller.signal,
      onProgress: (progress) => {
        if (state.export.state === 'running') state.export.progress = Math.max(0, Math.min(1, progress));
      },
    })
      .then(() => {
        if (controller.signal.aborted) {
          state.export = { state: 'idle', progress: 0, output: null, error: null };
          return;
        }
        state.export = { state: 'done', progress: 1, output, error: null };
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          state.export = { state: 'idle', progress: 0, output: null, error: null };
          return;
        }
        state.export = { state: 'error', progress: 0, output, error: messageOf(error) };
      })
      .finally(() => {
        if (state.exportAbort === controller) state.exportAbort = null;
      });
    return buildState();
  }

  async function cancelExport() {
    if (state.export.state !== 'running') return buildState();
    if (state.exportAbort !== null) {
      state.exportAbort.abort();
      state.exportAbort = null;
    }
    state.export = { state: 'idle', progress: 0, output: null, error: null };
    return buildState();
  }

  function rejected(req, res) {
    if (typeof connection?.requestRejection !== 'function') {
      res.statusCode = 503;
      res.end();
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined || rejection === null) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  }

  function statusForCode(code) {
    switch (code) {
      case 'project-exists':
      case 'export-running':
        return 409;
      case 'project-not-found':
      case 'media-not-found':
      case 'library-item-not-found':
        return 404;
      case 'no-project':
        return 409;
      case 'ffmpeg-unavailable':
      case 'asr-unavailable':
      case 'generation-unavailable':
      case 'encoder-unavailable':
        return 503;
      case 'asr-failed':
      case 'generation-failed':
        return 502;
      case 'invalid-input':
      case 'invalid-project':
      case 'model-error':
      case 'media-error':
      case 'invalid-captions':
      case 'invalid-library':
      case 'library-path-escape':
        return 400;
      default:
        return 500;
    }
  }

  function errorResponse(res, error) {
    const code = error instanceof RouteError ? error.code : error?.code ?? 'internal-error';
    const status = error instanceof RouteError
      ? error.status
      : error instanceof ModelError
        ? 400
        : statusForCode(code);
    state.lastError = messageOf(error);
    sendJson(res, status, { error: { code, message: messageOf(error) } });
  }

  async function handle(req, res) {
    if (rejected(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    let sub = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    if (sub === '' || sub === '/') sub = '/state';
    try {
      if (sub === '/library' && req.method === 'GET') {
        const query = url.searchParams;
        const result = await listLibrary({
          query: query.get('query') ?? undefined,
          kind: query.get('kind') ?? undefined,
          favorite: query.get('favorite') === null ? undefined : query.get('favorite') === 'true',
          category: query.get('category') ?? undefined,
        });
        sendJson(res, 200, { items: result.items, root: result.root });
        return;
      }
      if (sub === '/library/import' && req.method === 'POST') {
        sendJson(res, 200, await importLibraryFolder(await readBoundedJson(req)));
        return;
      }
      if (sub === '/library/update' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        const item = await updateLibraryItem({ itemId: body.id, patch: body.patch });
        sendJson(res, 200, { ok: true, item });
        return;
      }
      if (sub === '/library/delete' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        const item = await deleteLibraryItem({ itemId: body.id });
        sendJson(res, 200, { ok: true, item });
        return;
      }
      if (sub === '/library/add-to-project' && req.method === 'POST') {
        sendJson(res, 200, await addLibraryItemToCurrentProject(await readBoundedJson(req)));
        return;
      }
      if (sub.startsWith('/library/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveLibraryFile(req, res, safeDecode(sub.slice('/library/file/'.length), 'library item id'));
        return;
      }
      if (sub.startsWith('/library/thumb/') && req.method === 'GET') {
        await serveLibraryThumbnail(res, safeDecode(sub.slice('/library/thumb/'.length), 'library item id'));
        return;
      }
      if (sub === '/state' && req.method === 'GET') {
        sendJson(res, 200, await buildState());
        return;
      }
      if (sub === '/project/new' && req.method === 'POST') {
        sendJson(res, 200, await createProjectFromPath(await readBoundedJson(req)));
        return;
      }
      if (sub === '/project/open' && req.method === 'POST') {
        sendJson(res, 200, await openProjectFromPath(await readBoundedJson(req)));
        return;
      }
      if (sub === '/project/save' && req.method === 'POST') {
        ensureProject();
        await saveNow();
        sendJson(res, 200, await buildState());
        return;
      }
      if (sub === '/media/import' && req.method === 'POST') {
        sendJson(res, 200, await importFolder(await readBoundedJson(req)));
        return;
      }
      if (sub === '/media/upload' && req.method === 'POST') {
        sendJson(res, 200, await uploadMedia(req, url.searchParams.get('name') ?? ''));
        return;
      }
      if (sub.startsWith('/media/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveMediaFile(req, res, safeDecode(sub.slice('/media/file/'.length), 'media id'));
        return;
      }
      if (sub.startsWith('/media/thumb/') && req.method === 'GET') {
        await serveThumbnail(res, safeDecode(sub.slice('/media/thumb/'.length), 'media id'));
        return;
      }
      if (sub === '/edit' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        sendJson(res, 200, await applyOperations(body.operations));
        return;
      }
      if (sub === '/undo' && req.method === 'POST') {
        sendJson(res, 200, await undo());
        return;
      }
      if (sub === '/redo' && req.method === 'POST') {
        sendJson(res, 200, await redo());
        return;
      }
      if (sub === '/luts/upload' && req.method === 'POST') {
        const uploaded = await uploadLut(req, url.searchParams.get('name') ?? '');
        sendJson(res, 200, { ok: true, ...uploaded.data });
        return;
      }
      if (sub === '/generate/providers' && req.method === 'GET') {
        sendJson(res, 200, await generationProviders(ctx));
        return;
      }
      if (sub === '/generate/image' && req.method === 'POST') {
        sendJson(res, 200, await generateProjectImage(await readBoundedJson(req)));
        return;
      }
      if (sub === '/generate/tts' && req.method === 'POST') {
        sendJson(res, 200, await generateProjectSpeech(await readBoundedJson(req)));
        return;
      }
      if (sub === '/transcribe' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        const result = await transcribeProjectMedia(body);
        sendJson(res, 200, result.state ?? { transcript: result.transcript });
        return;
      }
      if (sub === '/transcripts' && req.method === 'GET') {
        const transcripts = await readTranscripts(ensureProject() && state.paths.root);
        sendJson(res, 200, { transcripts });
        return;
      }
      if (sub === '/search' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        const result = await searchProject(body.query);
        sendJson(res, 200, result);
        return;
      }
      if (sub === '/captions/import' && req.method === 'POST') {
        sendJson(res, 200, await importCaptions(await readBoundedJson(req, 4 * 1024 * 1024)));
        return;
      }
      if ((sub === '/captions/export' || sub === '/captions/export.srt' || sub === '/captions/export.vtt') && req.method === 'GET') {
        const format = sub.endsWith('.vtt') ? 'vtt' : sub.endsWith('.srt') ? 'srt' : (url.searchParams.get('format') === 'vtt' ? 'vtt' : 'srt');
        const exported = exportCaptions(format);
        sendText(res, 200, exported.text, 'text/plain; charset=utf-8', `captions.${exported.format}`);
        return;
      }
      if (sub === '/text/render' && req.method === 'POST') {
        const body = await readBoundedJson(req, 16 * 1024 * 1024);
        await renderTextAsset(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (sub === '/export' && req.method === 'POST') {
        sendJson(res, 200, await startExport(await readBoundedJson(req)));
        return;
      }
      if (sub === '/export/status' && req.method === 'GET') {
        sendJson(res, 200, await buildState());
        return;
      }
      if (sub === '/export/cancel' && req.method === 'POST') {
        sendJson(res, 200, await cancelExport());
        return;
      }
      if (sub === '/tracks' && req.method === 'POST') {
        const body = await readBoundedJson(req);
        if (body.type !== 'video' && body.type !== 'audio') {
          throw new RouteError('type must be video or audio', 'invalid-input');
        }
        const result = await addTrack(body.type);
        sendJson(res, 200, await result.state);
        return;
      }
      sendJson(res, 404, { error: { code: 'not-found', message: `Unknown route ${sub}` } });
    } catch (error) {
      errorResponse(res, error);
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: handle,
      }),
    `opentake-studio: ${PREFIX}`,
  );

  // --- Native agent tools ---------------------------------------------------

  const textOutput = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' }, data: {} },
      required: ['text'],
      additionalProperties: true,
    },
    render(_args, value) {
      return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
    },
  };

  function registerTool(name, description, parameters, run) {
    const dispose = toolRegistry.register({
      name,
      description,
      parameters,
      output: textOutput,
      async execute(args) {
        const result = await run(isRecord(args) ? args : {});
        return { text: result.text, data: result.data ?? null };
      },
    });
    ctx.effect(() => dispose, `opentake-studio: tool ${name}`);
  }

  registerTool(
    'opentake_studio_get_state',
    'Read the current OpenTake Studio project: fps, resolution, duration frames, tracks, clips and media. Call this before editing.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const project = ensureProject();
      const summary = summaryOf(project);
      return { text: JSON.stringify(summary), data: summary };
    },
  );

  registerTool(
    'opentake_studio_list_media',
    'List the media assets imported into the current project (id, name, kind, dimensions, duration frames).',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const project = ensureProject();
      const media = summaryOf(project).media;
      return { text: JSON.stringify(media), data: { media } };
    },
  );

  registerTool(
    'opentake_studio_edit',
    'Apply high-level edit operations to the current project (speed, keyframes, effects, fades, markers, transitions, captions, plus existing timeline operations). Returns the updated state.',
    {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          items: { type: 'object' },
          description: 'Operation objects; see the plugin DESIGN §11.2 for shapes.',
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await applyOperations(args.operations);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_rename_project',
    'Rename the current project (display name only; folder path is unchanged).',
    {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await applyOperations([{ type: 'rename-project', name: args.name }]);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_update_track',
    'Rename, mute, hide or show a track.',
    {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        name: { type: 'string' },
        muted: { type: 'boolean' },
        hidden: { type: 'boolean' },
        volume: { type: 'number' },
      },
      required: ['trackId'],
      additionalProperties: false,
    },
    async (args) => {
      const operation = { type: 'update-track', trackId: args.trackId };
      if (args.name !== undefined) operation.name = args.name;
      if (args.muted !== undefined) operation.muted = args.muted;
      if (args.hidden !== undefined) operation.hidden = args.hidden;
      if (args.volume !== undefined) operation.volume = args.volume;
      const result = await applyOperations([operation]);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_remove_track',
    'Remove an empty or populated track and all of its clips.',
    {
      type: 'object',
      properties: { trackId: { type: 'string' } },
      required: ['trackId'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await applyOperations([{ type: 'remove-track', trackId: args.trackId }]);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_set_mask',
    'Set or clear a normalized rect/ellipse mask (with feather/invert) on a clip.',
    {
      type: 'object',
      properties: { clipId: { type: 'string' }, mask: { type: 'object', description: 'Mask rect; omit to clear' } },
      required: ['clipId'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await applyOperations([
        { type: 'set-mask', clipId: args.clipId, mask: args.mask === undefined ? null : args.mask },
      ]);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_set_blend_mode',
    'Set a clip blend mode (normal/screen/multiply/overlay/darken/lighten/add/difference).',
    {
      type: 'object',
      properties: { clipId: { type: 'string' }, blendMode: { type: 'string' } },
      required: ['clipId', 'blendMode'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await applyOperations([
        { type: 'set-blend-mode', clipId: args.clipId, blendMode: args.blendMode },
      ]);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_import_captions',
    'Import SRT or WebVTT subtitle text into a caption clip on a dedicated Captions track.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Full SRT or WebVTT file contents' },
        style: { type: 'object' },
        trackId: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await importCaptions(args);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_export_captions',
    'Export every caption clip in the current project as SRT (default) or WebVTT text.',
    {
      type: 'object',
      properties: { format: { type: 'string', enum: ['srt', 'vtt'] } },
      additionalProperties: false,
    },
    async (args) => {
      const exported = exportCaptions(args.format);
      return { text: exported.text, data: { format: exported.format } };
    },
  );

  registerTool(
    'opentake_studio_transcribe_media',
    'Transcribe a project video/audio asset with the configured Whisper-compatible endpoint; optionally create a caption clip.',
    {
      type: 'object',
      properties: {
        mediaId: { type: 'string' },
        createCaptions: { type: 'boolean' },
      },
      required: ['mediaId'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await transcribeProjectMedia(args);
      return {
        text: result.transcript.text,
        data: { transcript: result.transcript, state: result.state ?? null },
      };
    },
  );

  registerTool(
    'opentake_studio_search',
    'Search project media names and stored transcripts for a literal query.',
    {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await searchProject(args.query);
      return { text: JSON.stringify(result.results), data: result };
    },
  );

  registerTool(
    'opentake_studio_generate_image',
    'Generate an image with the configured OpenAI-compatible provider and add it to the current project.',
    {
      type: 'object',
      properties: { prompt: { type: 'string' }, size: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await generateProjectImage(args);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_generate_speech',
    'Generate speech audio with the configured OpenAI-compatible provider and add it to the current project.',
    {
      type: 'object',
      properties: {
        text: { type: 'string' },
        voice: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await generateProjectSpeech(args);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_library_list',
    'List the global media library (name, kind, dimensions, duration, favorite, category).',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['video', 'audio', 'image'] },
        favorite: { type: 'boolean' },
        category: { type: 'string' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const result = await listLibrary(args);
      return { text: JSON.stringify(result.items), data: { items: result.items, root: result.root } };
    },
  );

  registerTool(
    'opentake_studio_library_import',
    'Import every media file in an absolute folder into the global media library.',
    {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await importLibraryFolder(args);
      return { text: `Imported ${result.imported.length} item(s)`, data: result };
    },
  );

  registerTool(
    'opentake_studio_library_add_to_project',
    'Add a library item to the current project as a media asset.',
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await addLibraryItemToCurrentProject(args);
      return { text: JSON.stringify(summaryOf(result.project)), data: summaryOf(result.project) };
    },
  );

  registerTool(
    'opentake_studio_library_update',
    'Update a library item name, favorite flag, category or tags.',
    {
      type: 'object',
      properties: { id: { type: 'string' }, patch: { type: 'object' } },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    async (args) => {
      const item = await updateLibraryItem({ itemId: args.id, patch: args.patch });
      return { text: JSON.stringify(item), data: { item } };
    },
  );

  registerTool(
    'opentake_studio_library_delete',
    'Delete a library item and its asset.',
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async (args) => {
      const item = await deleteLibraryItem({ itemId: args.id });
      return { text: 'Library item deleted', data: { item } };
    },
  );

  registerTool(
    'opentake_studio_new_project',
    'Create a new OpenTake Studio project in an absolute folder path. The folder becomes the project root; media/ and exports/ are created inside it.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute project folder path' },
        name: { type: 'string' },
        fps: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await createProjectFromPath(args);
      return { text: `Created project "${result.project.name}" at ${result.projectRoot}`, data: { projectRoot: result.projectRoot } };
    },
  );

  registerTool(
    'opentake_studio_open_project',
    'Open an existing OpenTake Studio project by its absolute folder path (the folder containing opentake-studio.json).',
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async (args) => {
      const result = await openProjectFromPath(args);
      return { text: `Opened project "${result.project.name}" at ${result.projectRoot}`, data: { projectRoot: result.projectRoot } };
    },
  );

  registerTool(
    'opentake_studio_import_media',
    'Import every media file in an absolute folder into the current project. Video/audio/image files are probed with ffprobe and copied under the project media folder.',
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async (args) => {
      const result = await importFolder(args);
      const names = result.project.media.slice(-result.imported.length).map((media) => `${media.name} (${media.kind})`);
      return { text: `Imported ${result.imported.length} file(s): ${names.join(', ') || 'none'}`, data: { imported: result.imported, skipped: result.skipped } };
    },
  );

  registerTool(
    'opentake_studio_add_clip',
    'Place a media asset on the timeline. Frames are project frames at project fps. Omit trackId to use/create the first compatible track. durationFrames defaults to the remaining source length.',
    {
      type: 'object',
      properties: {
        mediaId: { type: 'string' },
        startFrame: { type: 'number' },
        trackId: { type: 'string' },
        durationFrames: { type: 'number' },
        trimStartFrame: { type: 'number' },
      },
      required: ['mediaId', 'startFrame'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await addClip(args);
      const summary = summaryOf(result.state.project);
      return { text: `Added clip ${result.clipId} on track ${result.trackId}; duration ${summary.durationFrames} frames`, data: { clipId: result.clipId, trackId: result.trackId } };
    },
  );

  registerTool(
    'opentake_studio_move_clip',
    'Move a clip to a start frame and/or another compatible track. Existing clips are trimmed or split on overlap.',
    {
      type: 'object',
      properties: { clipId: { type: 'string' }, startFrame: { type: 'number' }, trackId: { type: 'string' } },
      required: ['clipId', 'startFrame'],
      additionalProperties: false,
    },
    async (args) => {
      await applyOperations([{ type: 'move-clip', clipId: args.clipId, startFrame: args.startFrame, ...(args.trackId ? { trackId: args.trackId } : {}) }]);
      return { text: `Moved clip ${args.clipId} to frame ${args.startFrame}` };
    },
  );

  registerTool(
    'opentake_studio_trim_clip',
    'Trim a clip by setting its durationFrames and/or its source trimStartFrame.',
    {
      type: 'object',
      properties: { clipId: { type: 'string' }, durationFrames: { type: 'number' }, trimStartFrame: { type: 'number' } },
      required: ['clipId'],
      additionalProperties: false,
    },
    async (args) => {
      await applyOperations([{ type: 'trim-clip', clipId: args.clipId, ...(args.durationFrames === undefined ? {} : { durationFrames: args.durationFrames }), ...(args.trimStartFrame === undefined ? {} : { trimStartFrame: args.trimStartFrame }) }]);
      return { text: `Trimmed clip ${args.clipId}` };
    },
  );

  registerTool(
    'opentake_studio_split_clip',
    'Split a clip at an absolute project frame strictly inside it. Returns the left and right clip ids.',
    {
      type: 'object',
      properties: { clipId: { type: 'string' }, atFrame: { type: 'number' } },
      required: ['clipId', 'atFrame'],
      additionalProperties: false,
    },
    async (args) => {
      const result = await splitClip(args.clipId, args.atFrame);
      return { text: `Split into ${result.leftClipId} and ${result.rightClipId}`, data: { leftClipId: result.leftClipId, rightClipId: result.rightClipId } };
    },
  );

  registerTool(
    'opentake_studio_remove_clips',
    'Remove one or more clips by id in one undoable edit.',
    { type: 'object', properties: { clipIds: { type: 'array', items: { type: 'string' } } }, required: ['clipIds'], additionalProperties: false },
    async (args) => {
      const clipIds = Array.isArray(args.clipIds) ? args.clipIds.filter((id) => typeof id === 'string') : [];
      if (clipIds.length === 0) throw new RouteError('clipIds must contain at least one clip id', 'invalid-input');
      await applyOperations([{ type: 'remove-clips', clipIds }]);
      return { text: `Removed ${clipIds.length} clip(s)` };
    },
  );

  registerTool(
    'opentake_studio_set_clip_properties',
    'Set volume (0..1), opacity (0..1) and/or transform (normalized x/y/width/height/rotation) on one or more clips.',
    {
      type: 'object',
      properties: {
        clipIds: { type: 'array', items: { type: 'string' } },
        volume: { type: 'number' },
        opacity: { type: 'number' },
        transform: { type: 'object' },
      },
      required: ['clipIds'],
      additionalProperties: false,
    },
    async (args) => {
      await applyOperations([{
        type: 'set-clip-properties',
        clipIds: Array.isArray(args.clipIds) ? args.clipIds : [],
        ...(args.volume === undefined ? {} : { volume: args.volume }),
        ...(args.opacity === undefined ? {} : { opacity: args.opacity }),
        ...(args.transform === undefined ? {} : { transform: args.transform }),
      }]);
      return { text: `Updated ${Array.isArray(args.clipIds) ? args.clipIds.length : 0} clip(s)` };
    },
  );

  registerTool(
    'opentake_studio_add_text',
    'Add a text overlay on a video track. Frames are project frames; transform is normalized 0..1 with x/y as top-left.',
    {
      type: 'object',
      properties: {
        content: { type: 'string' },
        startFrame: { type: 'number' },
        durationFrames: { type: 'number' },
        trackId: { type: 'string' },
        fontSize: { type: 'number' },
        color: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['content', 'startFrame'],
      additionalProperties: false,
    },
    async (args) => {
      const text = { content: args.content, ...(args.fontSize === undefined ? {} : { fontSize: args.fontSize }), ...(args.color === undefined ? {} : { color: args.color }) };
      const result = await addText({
        content: args.content,
        startFrame: args.startFrame,
        durationFrames: args.durationFrames,
        trackId: args.trackId,
        text,
        transform: {
          ...(args.x === undefined ? {} : { x: args.x }),
          ...(args.y === undefined ? {} : { y: args.y }),
        },
      });
      return { text: `Added text clip ${result.clipId}`, data: { clipId: result.clipId } };
    },
  );

  registerTool(
    'opentake_studio_undo',
    'Undo the most recent OpenTake Studio edit.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      await undo();
      return { text: 'Undid the last edit' };
    },
  );

  registerTool(
    'opentake_studio_redo',
    'Redo the most recently undone OpenTake Studio edit.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      await redo();
      return { text: 'Redid the last edit' };
    },
  );

  registerTool(
    'opentake_studio_export',
    'Start an asynchronous ffmpeg export of the current timeline to an MP4. Omit path to write into the project exports/ folder. Poll opentake_studio_get_state or read the returned path.',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
        overwrite: { type: 'boolean' },
        codec: { type: 'string', enum: ['h264', 'h265', 'prores', 'vp9'] },
        width: { type: 'number' },
        height: { type: 'number' },
        fps: { type: 'number' },
        crf: { type: 'number' },
        bitrate: { type: 'string' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const result = await startExport(args);
      return { text: `Export started: ${result.export.output}`, data: { output: result.export.output } };
    },
  );

  ctx.effect(
    () => () => {
      state.disposed = true;
      if (state.saveTimer !== null) {
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
      }
      state.exportAbort?.abort();
      state.exportAbort = null;
      void saveNow();
    },
    'opentake-studio: lifecycle',
  );
}
