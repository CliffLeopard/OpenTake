/**
 * Media probing, import, thumbnails and ffmpeg/ffprobe process wrappers for
 * OpenTake Studio. Pure Node builtins: no third-party packages and no shell.
 *
 * The module owns the <projectRoot>/media and <projectRoot>/thumbnails layout
 * described in docs/DESIGN.md §4. Every path that leaves the project media
 * directory is resolved and validated here; every ffmpeg/ffprobe invocation
 * receives an argv array (never a shell string).
 */

import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'm2v', 'ts', 'm2ts',
  'mts', '3gp', '3g2', 'ogv', 'vob', 'wmv', 'flv', 'f4v', 'mxf', 'dv', 'asf',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'wave', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff',
  'aif', 'aifc', 'caf', 'mka', 'ac3', 'eac3', 'dts', 'amr', 'wv', 'ape',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif',
  'avif', 'jxl', 'ico', 'tga', 'pnm', 'pbm', 'pgm', 'ppm', 'exr', 'dpx',
]);

/** Lottie animations: plain bodymovin JSON, or the (unsupported) .lottie ZIP. */
const LOTTIE_EXTENSIONS = new Set(['json', 'lottie']);
const MAX_LOTTIE_JSON_BYTES = 64 * 1024 * 1024;

const MIME_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/x-m4v'],
  ['mov', 'video/quicktime'],
  ['qt', 'video/quicktime'],
  ['webm', 'video/webm'],
  ['mkv', 'video/x-matroska'],
  ['avi', 'video/x-msvideo'],
  ['mpg', 'video/mpeg'],
  ['mpeg', 'video/mpeg'],
  ['m2v', 'video/mpeg'],
  ['ts', 'video/mp2t'],
  ['m2ts', 'video/mp2t'],
  ['mts', 'video/mp2t'],
  ['3gp', 'video/3gpp'],
  ['3g2', 'video/3gpp2'],
  ['ogv', 'video/ogg'],
  ['wmv', 'video/x-ms-wmv'],
  ['flv', 'video/x-flv'],
  ['f4v', 'video/x-f4v'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['wave', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['wma', 'audio/x-ms-wma'],
  ['aiff', 'audio/aiff'],
  ['aif', 'audio/aiff'],
  ['aifc', 'audio/aiff'],
  ['caf', 'audio/x-caf'],
  ['mka', 'audio/x-matroska'],
  ['ac3', 'audio/ac3'],
  ['eac3', 'audio/eac3'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['avif', 'image/avif'],
  ['jxl', 'image/jxl'],
  ['json', 'application/json'],
  ['lottie', 'application/zip'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
]);

/** Directory names that must never be entered while scanning an import folder. */
const SCAN_SKIP_DIRECTORIES = new Set(['media', 'thumbnails', 'exports']);

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_WIDTH = 320;
const TOOL_PROBE_TIMEOUT_MS = 10_000;

/** Base error used by this module; every instance carries a stable `code`. */
export class MediaError extends Error {
  constructor(message, code = 'media-error', options) {
    super(message, options);
    this.name = 'MediaError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

let toolCache = null;

function isExecutableFile(candidate) {
  try {
    const info = statSync(candidate);
    if (!info.isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const executable = process.platform === 'win32' && !/\.exe$/i.test(command) ? `${command}.exe` : command;
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const candidate = path.join(entry, executable);
    if (isExecutableFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

function resolveFromEnvironment(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const absolute = path.resolve(trimmed);
    return isExecutableFile(absolute) ? absolute : null;
  }
  return findOnPath(trimmed) ?? null;
}

function readFfmpegVersion(ffmpegPath) {
  if (ffmpegPath === null) return null;
  try {
    const stdout = execFileSync(ffmpegPath, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      timeout: TOOL_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = /ffmpeg version\s+(\S+)/i.exec(String(stdout));
    return match === null ? null : match[1];
  } catch {
    return null;
  }
}

/**
 * Resolve the system ffmpeg/ffprobe once and cache the result.
 *
 * Order: OPENTAKE_STUDIO_FFMPEG / OPENTAKE_STUDIO_FFPROBE, then PATH. A stale
 * environment value that no longer points at an executable falls back to PATH
 * so a bad override cannot silently disable export.
 *
 * @returns {{ available: boolean, ffmpeg: string|null, ffprobe: string|null, version: string|null }}
 */
export function resolveTools() {
  if (toolCache !== null) return { ...toolCache };
  const ffmpeg =
    resolveFromEnvironment(process.env.OPENTAKE_STUDIO_FFMPEG) ?? findOnPath('ffmpeg');
  const ffprobe =
    resolveFromEnvironment(process.env.OPENTAKE_STUDIO_FFPROBE) ?? findOnPath('ffprobe');
  toolCache = {
    available: ffmpeg !== null && ffprobe !== null,
    ffmpeg,
    ffprobe,
    version: readFfmpegVersion(ffmpeg),
  };
  return { ...toolCache };
}

/** Drop the cached tool paths (tests, or after the user installs ffmpeg). */
export function resetToolCache() {
  toolCache = null;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function extensionOf(fileName) {
  const extension = path.extname(String(fileName ?? '')).toLowerCase();
  return extension.startsWith('.') ? extension.slice(1) : extension;
}

/** @returns {'video'|'audio'|'image'|null} */
export function mediaKindForFile(fileName) {
  const extension = extensionOf(fileName);
  if (extension.length === 0) return null;
  if (LOTTIE_EXTENSIONS.has(extension)) return 'lottie';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return null;
}

/** Every extension this module treats as importable media (dotless, sorted). */
export function mediaExtensions() {
  return [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...LOTTIE_EXTENSIONS].sort();
}

/** True when the file name has a known video, audio or image extension. */
export function isMediaFile(fileName) {
  return mediaKindForFile(fileName) !== null;
}

/** Best-effort MIME type for the media file route. */
export function mediaMimeType(fileName) {
  return MIME_TYPES.get(extensionOf(fileName)) ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe wrappers
// ---------------------------------------------------------------------------

function abortError() {
  const error = new MediaError('The ffmpeg operation was aborted', 'aborted');
  error.name = 'AbortError';
  return error;
}

function assertArgv(args, functionName) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((argument) => typeof argument === 'string')) {
    throw new MediaError(`${functionName} expects a non-empty argv array of strings`, 'invalid-input');
  }
}

function stderrTail(stderr) {
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (text.length === 0) return '(no stderr)';
  return text.length > 4000 ? `…${text.slice(-4000)}` : text;
}

function parseTimecode(value) {
  const match = /^(-?\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Spawn ffmpeg with an argv array. `-progress pipe:1`-style output is parsed
 * and forwarded to `onProgress({ outTimeSeconds, frame, progress, ... })`.
 * stderr is retained as a bounded tail for error reporting.
 *
 * @param {string[]} args
 * @param {{ onProgress?: (progress: object) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number, stderr: string }>}
 */
export async function runFfmpeg(args, { onProgress, signal } = {}) {
  assertArgv(args, 'runFfmpeg');
  const tools = resolveTools();
  if (tools.ffmpeg === null) {
    throw new MediaError('ffmpeg is not available (set OPENTAKE_STUDIO_FFMPEG or install ffmpeg)', 'ffmpeg-unavailable');
  }
  if (signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tools.ffmpeg, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new MediaError(`Could not start ffmpeg: ${error.message}`, 'ffmpeg-unavailable', { cause: error }));
      return;
    }

    let settled = false;
    let aborted = false;
    let killTimer = null;
    let stderr = '';
    let stdoutLineBuffer = '';
    const progressBlock = {};

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may already be gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore: already exited.
        }
      }, 2000);
      killTimer.unref?.();
    };

    const cleanup = () => {
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const emitProgress = () => {
      const microseconds = Number(progressBlock.out_time_us ?? progressBlock.out_time_ms);
      const fromUs = Number.isFinite(microseconds) && microseconds >= 0 ? microseconds / 1e6 : null;
      const outTimeSeconds = fromUs ?? parseTimecode(progressBlock.out_time);
      const frame = Number(progressBlock.frame);
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            ...progressBlock,
            outTimeSeconds,
            frame: Number.isFinite(frame) ? frame : null,
          });
        } catch {
          // A broken progress callback must not kill the export.
        }
      }
      for (const key of Object.keys(progressBlock)) delete progressBlock[key];
    };

    const consumeStdout = (chunk) => {
      stdoutLineBuffer += chunk;
      let newline = stdoutLineBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutLineBuffer.slice(0, newline).trim();
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        if (line.length > 0) {
          const equals = line.indexOf('=');
          if (equals > 0) {
            progressBlock[line.slice(0, equals)] = line.slice(equals + 1);
            if (line.slice(0, equals) === 'progress') emitProgress();
          }
        }
        newline = stdoutLineBuffer.indexOf('\n');
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', consumeStdout);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
    });

    child.on('error', (error) => {
      if (aborted) {
        finish(abortError());
        return;
      }
      const code = error && error.code === 'ENOENT' ? 'ffmpeg-unavailable' : 'ffmpeg-failed';
      finish(new MediaError(`Could not run ffmpeg: ${error.message}`, code, { cause: error }));
    });

    child.on('close', (code, closingSignal) => {
      if (settled) return;
      if (aborted) {
        finish(abortError());
        return;
      }
      if (code === 0) {
        finish(null, { code: 0, stderr });
        return;
      }
      const reason = closingSignal === null ? `exit code ${String(code)}` : `signal ${closingSignal}`;
      finish(
        new MediaError(`ffmpeg failed (${reason}): ${stderrTail(stderr)}`, 'ffmpeg-failed'),
      );
    });

    if (signal !== undefined) signal.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Spawn ffprobe with an argv array and resolve its stdout.
 *
 * @param {string[]} args
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function runFfprobe(args, { signal } = {}) {
  assertArgv(args, 'runFfprobe');
  const tools = resolveTools();
  if (tools.ffprobe === null) {
    throw new MediaError('ffprobe is not available (set OPENTAKE_STUDIO_FFPROBE or install ffprobe)', 'ffprobe-unavailable');
  }
  if (signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tools.ffprobe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new MediaError(`Could not start ffprobe: ${error.message}`, 'ffprobe-unavailable', { cause: error }));
      return;
    }

    let settled = false;
    let aborted = false;
    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore.
      }
    };
    const cleanup = () => {
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) stdout = stdout.slice(-MAX_STDOUT_BYTES);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
    });

    child.on('error', (error) => {
      if (aborted) {
        finish(abortError());
        return;
      }
      const code = error && error.code === 'ENOENT' ? 'ffprobe-unavailable' : 'ffprobe-failed';
      finish(new MediaError(`Could not run ffprobe: ${error.message}`, code, { cause: error }));
    });
    child.on('close', (code, closingSignal) => {
      if (settled) return;
      if (aborted) {
        finish(abortError());
        return;
      }
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const reason = closingSignal === null ? `exit code ${String(code)}` : `signal ${closingSignal}`;
      finish(new MediaError(`ffprobe failed (${reason}): ${stderrTail(stderr)}`, 'ffprobe-failed'));
    });

    if (signal !== undefined) signal.addEventListener?.('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function parseFrameRate(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 1e6) / 1e6;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Validate a bodymovin/Lottie animation document and derive its timing.
 * Requires the standard markers (`v`, numeric `fr`/`ip`/`op`/`w`/`h` and a
 * `layers` array); throws `unsupported-media` otherwise.
 */
function lottieMetadata(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MediaError('JSON file is not a Lottie animation (expected an object)', 'unsupported-media');
  }
  const hasVersion = data.v !== undefined && (typeof data.v === 'string' || typeof data.v === 'number');
  if (!hasVersion) {
    throw new MediaError('JSON file is missing the Lottie bodymovin version marker "v"', 'unsupported-media');
  }
  const frameRate = Number(data.fr);
  const inPoint = Number(data.ip);
  const outPoint = Number(data.op);
  const widthValue = Number(data.w);
  const heightValue = Number(data.h);
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new MediaError('Lottie animation has an invalid frame rate (fr must be > 0)', 'unsupported-media');
  }
  if (!Number.isFinite(inPoint) || inPoint < 0) {
    throw new MediaError('Lottie animation has an invalid in point (ip must be >= 0)', 'unsupported-media');
  }
  if (!Number.isFinite(outPoint) || outPoint <= inPoint) {
    throw new MediaError('Lottie animation has an invalid out point (op must be > ip)', 'unsupported-media');
  }
  if (!Number.isFinite(widthValue) || widthValue <= 0 || !Number.isFinite(heightValue) || heightValue <= 0) {
    throw new MediaError('Lottie animation has invalid dimensions (w/h must be > 0)', 'unsupported-media');
  }
  if (!Array.isArray(data.layers)) {
    throw new MediaError('Lottie animation is missing its layers array', 'unsupported-media');
  }
  return {
    width: Math.round(widthValue),
    height: Math.round(heightValue),
    fps: frameRate,
    durationSeconds: (outPoint - inPoint) / frameRate,
  };
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

/** Extract one regular file from a ZIP buffer using only Node built-ins. */
function readZipEntry(buffer, matcher) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new MediaError('Lottie container is not a valid ZIP archive', 'unsupported-media');
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset >= buffer.length) {
    throw new MediaError('Lottie container ZIP directory is out of bounds', 'unsupported-media');
  }
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0) continue; // encrypted entry
    if (!matcher(name)) continue;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new MediaError('Lottie container uses unsupported ZIP64 entries', 'unsupported-media');
    }
    if (uncompressedSize > MAX_LOTTIE_JSON_BYTES) {
      throw new MediaError('Lottie animation in container is too large', 'unsupported-media');
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new MediaError('Lottie container has an invalid ZIP local header', 'unsupported-media');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      throw new MediaError('Lottie container entry is truncated', 'unsupported-media');
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_LOTTIE_JSON_BYTES });
      } catch (error) {
        throw new MediaError('Lottie container deflate entry is invalid', 'unsupported-media', { cause: error });
      }
    } else {
      throw new MediaError(`Lottie container uses unsupported ZIP compression ${method}`, 'unsupported-media');
    }
    return { name, data };
  }
  throw new MediaError('Lottie container has no animation JSON entry', 'unsupported-media');
}

/**
 * Read and validate a Lottie animation from a `.json` or `.lottie` file.
 * @returns {Promise<{ animation: object, animationPath: string, sizeBytes: number }>}
 */
export async function readLottieAnimation(filePath) {
  const extension = extensionOf(filePath);
  const info = await stat(filePath).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new MediaError(`Lottie file does not exist: ${filePath}`, 'io-error');
  }
  if (info.size > 64 * 1024 * 1024) {
    throw new MediaError(`Lottie file is too large to read (${info.size} bytes)`, 'unsupported-media');
  }
  const buffer = await readFile(filePath);
  let animationText;
  let animationPath;
  if (extension === 'lottie') {
    const entry = readZipEntry(buffer, (name) => /(^|\/)animations\/[^/]+\.json$/i.test(name));
    animationText = entry.data.toString('utf8');
    animationPath = entry.name;
  } else {
    animationText = buffer.toString('utf8');
    animationPath = path.basename(filePath);
  }
  let animation;
  try {
    animation = JSON.parse(animationText);
  } catch (error) {
    throw new MediaError(`Invalid JSON in Lottie file: ${filePath}`, 'probe-failed', { cause: error });
  }
  lottieMetadata(animation);
  return { animation, animationPath, sizeBytes: info.size };
}

async function probeLottieMedia(filePath, info) {
  const extension = extensionOf(filePath);
  if (info.size > MAX_LOTTIE_JSON_BYTES) {
    throw new MediaError(
      `Lottie JSON is too large to probe (${info.size} bytes; limit ${MAX_LOTTIE_JSON_BYTES})`,
      'unsupported-media',
    );
  }

  void extension;
  const { animation: parsed } = await readLottieAnimation(filePath);

  const metadata = lottieMetadata(parsed);
  return {
    kind: 'lottie',
    durationSeconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    hasAudio: false,
    sizeBytes: info.size,
  };
}

/**
 * Probe a media file.
 *
 * Lottie `.json` files are validated by reading/parsing JSON only (no ffprobe);
 * `.lottie` ZIP containers are reported as unsupported. Everything else goes
 * through ffprobe.
 *
 * @returns {Promise<{ kind: 'video'|'audio'|'image'|'lottie', durationSeconds: number|null,
 *   width: number|null, height: number|null, fps: number|null, hasAudio: boolean,
 *   sizeBytes: number }>}
 */
export async function probeMedia(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new MediaError('probeMedia requires a file path', 'invalid-input');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new MediaError(`Could not read media file: ${filePath}`, 'io-error', { cause: error });
  }
  if (!info.isFile()) {
    throw new MediaError(`Media path is not a regular file: ${filePath}`, 'io-error');
  }

  const extensionKind = mediaKindForFile(filePath);
  if (extensionKind === 'lottie') {
    return probeLottieMedia(filePath, info);
  }

  const tools = resolveTools();
  if (tools.ffprobe === null) {
    throw new MediaError('ffprobe is not available (set OPENTAKE_STUDIO_FFPROBE or install ffprobe)', 'ffprobe-unavailable');
  }

  let stdout;
  try {
    stdout = await runFfprobe(
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    if (error instanceof MediaError && ['ffprobe-unavailable', 'aborted'].includes(error.code)) throw error;
    throw new MediaError(`ffprobe could not read media file: ${filePath}`, 'probe-failed', { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new MediaError(`ffprobe returned invalid JSON for: ${filePath}`, 'probe-failed', { cause: error });
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStream = streams.find(
    (stream) => stream?.codec_type === 'video' && stream?.disposition?.attached_pic !== 1,
  ) ?? streams.find((stream) => stream?.codec_type === 'video');
  const audioStream = streams.find((stream) => stream?.codec_type === 'audio');

  let kind = null;
  if (extensionKind === 'image') kind = 'image';
  else if (videoStream !== undefined) kind = 'video';
  else if (audioStream !== undefined) kind = 'audio';
  else if (extensionKind !== null) kind = extensionKind;
  if (kind === null) {
    throw new MediaError(`Unsupported or unreadable media file: ${filePath}`, 'unsupported-media');
  }

  let durationSeconds = null;
  if (kind === 'image') {
    durationSeconds = null;
  } else {
    durationSeconds =
      positiveNumber(parsed?.format?.duration) ??
      positiveNumber(videoStream?.duration) ??
      positiveNumber(audioStream?.duration);
  }

  const width = positiveNumber(videoStream?.width);
  const height = positiveNumber(videoStream?.height);
  const fps = kind === 'image'
    ? null
    : parseFrameRate(videoStream?.avg_frame_rate) ?? parseFrameRate(videoStream?.r_frame_rate);

  return {
    kind,
    durationSeconds,
    width: kind === 'audio' ? null : (width === null ? null : Math.round(width)),
    height: kind === 'audio' ? null : (height === null ? null : Math.round(height)),
    fps,
    hasAudio: kind !== 'image' && audioStream !== undefined,
    sizeBytes: info.size,
  };
}

// ---------------------------------------------------------------------------
// Scanning and importing
// ---------------------------------------------------------------------------

/**
 * Recursively list regular files under `folderPath`.
 *
 * Skips hidden entries (dot-prefixed) and the project-owned `media`,
 * `thumbnails` and `exports` directories so importing a project folder never
 * re-imports its own generated files. Symlinks are skipped to avoid cycles.
 *
 * @returns {Promise<string[]>} absolute file paths, sorted
 */
export async function scanMediaFolder(folderPath) {
  if (typeof folderPath !== 'string' || folderPath.length === 0) {
    throw new MediaError('scanMediaFolder requires a folder path', 'invalid-input');
  }
  const root = path.resolve(folderPath);
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    throw new MediaError(`Media folder does not exist: ${root}`, 'io-error', { cause: error });
  }
  if (!rootInfo.isDirectory()) {
    throw new MediaError(`Media folder is not a directory: ${root}`, 'invalid-input');
  }

  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) {
        throw new MediaError(`Could not read media folder: ${root}`, 'io-error', { cause: error });
      }
      continue; // Unreadable nested directory: skip it rather than fail the import.
    }

    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
      // Symlinks and special files are intentionally ignored.
    }
  }

  files.sort();
  return files;
}

/** Replace characters that are unsafe in generated media file names. */
function safeFileName(fileName) {
  const base = path.basename(String(fileName));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned.length === 0) return 'media';
  // Preserve the extension when truncating very long names.
  if (cleaned.length <= 180) return cleaned;
  const extension = path.extname(cleaned);
  const stem = cleaned.slice(0, 180 - extension.length);
  return `${stem}${extension}`;
}

function mediaKey(name, sizeBytes) {
  return `${name}\u0000${String(sizeBytes)}`;
}

/**
 * Import every media file found under `folderPath` into the project.
 *
 * Files are hard-linked to `<root>/media/<id>-<safeName>` with a copy fallback
 * (cross-device or filesystem without link support). Each imported file is
 * probed; non-media, duplicate and unprobeable files are reported in
 * `skipped`. The returned Media objects still have to be added to the project
 * by the caller with the `add-media` operation (DESIGN §4).
 *
 * @returns {Promise<{ media: object[], imported: string[], skipped: string[] }>}
 */
export async function importToProject({ projectRoot, folderPath, project } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new MediaError('projectRoot must be an absolute path', 'invalid-input');
  }
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) {
    throw new MediaError('folderPath must be an absolute path', 'invalid-input');
  }

  const root = path.resolve(projectRoot);
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir, { recursive: true });

  const fps = project !== null && typeof project === 'object' && Number.isFinite(project.fps) && project.fps > 0
    ? project.fps
    : 30;
  const existingMedia = project !== null && typeof project === 'object' && Array.isArray(project.media)
    ? project.media
    : [];
  const known = new Set();
  for (const entry of existingMedia) {
    if (
      entry !== null && typeof entry === 'object' &&
      typeof entry.name === 'string' && Number.isFinite(entry.sizeBytes)
    ) {
      known.add(mediaKey(entry.name, entry.sizeBytes));
    }
  }

  const sourceFiles = await scanMediaFolder(folderPath);
  const media = [];
  const imported = [];
  const skipped = [];

  for (const sourcePath of sourceFiles) {
    const sourceName = path.basename(sourcePath);
    if (!isMediaFile(sourceName)) {
      skipped.push(sourcePath);
      continue;
    }

    let sourceInfo;
    try {
      sourceInfo = await stat(sourcePath);
    } catch {
      skipped.push(sourcePath);
      continue;
    }
    if (!sourceInfo.isFile()) {
      skipped.push(sourcePath);
      continue;
    }

    const key = mediaKey(sourceName, sourceInfo.size);
    if (known.has(key)) {
      skipped.push(sourcePath);
      continue;
    }

    const id = randomUUID();
    const fileName = `${id}-${safeFileName(sourceName)}`;
    const destination = path.join(mediaDir, fileName);

    try {
      try {
        await link(sourcePath, destination); // Preferred: zero-copy hard link.
      } catch {
        await copyFile(sourcePath, destination); // EXDEV / unsupported filesystem fallback.
      }
    } catch (error) {
      throw new MediaError(`Could not import media file: ${sourcePath}`, 'io-error', { cause: error });
    }

    let probe;
    try {
      probe = await probeMedia(destination);
    } catch {
      await rm(destination, { force: true });
      skipped.push(sourcePath);
      continue;
    }

    const durationFrames = probe.kind === 'image'
      ? null
      : probe.durationSeconds === null
        ? null
        : Math.max(1, Math.round(probe.durationSeconds * fps));

    if (probe.kind !== 'image' && durationFrames === null) {
      await rm(destination, { force: true });
      skipped.push(sourcePath);
      continue;
    }

    media.push({
      id,
      name: sourceName,
      kind: probe.kind,
      fileName,
      durationFrames,
      sourceDurationSeconds: probe.kind === 'image' ? null : probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      sizeBytes: sourceInfo.size,
      importedAt: Date.now(),
    });
    imported.push(sourcePath);
    known.add(key);
  }

  return { media, imported, skipped };
}

// ---------------------------------------------------------------------------
// Project media paths and thumbnails
// ---------------------------------------------------------------------------

/**
 * Resolve `<root>/media/<fileName>` and reject any path that escapes the media
 * directory (including absolute file names and `..` segments).
 */
export function mediaFilePath(projectRoot, media) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new MediaError('projectRoot must be a non-empty path', 'invalid-input');
  }
  if (media === null || typeof media !== 'object' || typeof media.fileName !== 'string' || media.fileName.length === 0) {
    throw new MediaError('media.fileName is required', 'invalid-input');
  }
  if (media.fileName.includes('\u0000')) {
    throw new MediaError('media.fileName contains an invalid character', 'invalid-path');
  }
  if (media.fileName.includes('\\')) {
    // Generated file names never contain backslashes; reject them so the same
    // project cannot escape media/ when moved to a Windows host.
    throw new MediaError(`Media path contains a disallowed separator: ${media.fileName}`, 'invalid-path');
  }

  const mediaDir = path.resolve(projectRoot, 'media');
  const candidate = path.resolve(mediaDir, media.fileName);
  const relative = path.relative(mediaDir, candidate);
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MediaError(`Media path escapes the project media directory: ${media.fileName}`, 'invalid-path');
  }
  return candidate;
}

function sanitizeId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new MediaError('media.id is required', 'invalid-input');
  }
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (safe.length === 0 || safe === '..') {
    throw new MediaError('media.id is not a valid file name', 'invalid-input');
  }
  return safe;
}

function formatSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  const fixed = number.toFixed(6).replace(/\.?0+$/, '');
  return fixed.length === 0 ? '0' : fixed;
}

function thumbnailTimeSeconds(media, atFrame) {
  const duration = Number(media?.sourceDurationSeconds);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : null;

  if (
    safeDuration !== null &&
    Number.isFinite(atFrame) && atFrame > 0 &&
    Number.isFinite(media?.durationFrames) && media.durationFrames > 0
  ) {
    const sourceFps = media.durationFrames / safeDuration;
    if (Number.isFinite(sourceFps) && sourceFps > 0) {
      const requested = atFrame / sourceFps;
      return Math.max(0, Math.min(requested, safeDuration - 0.05));
    }
  }
  if (safeDuration === null) return 0;
  return Math.max(0, Math.min(1, safeDuration / 2));
}

/**
 * Return a cached JPEG thumbnail at `<root>/thumbnails/<mediaId>.jpg`,
 * generating it with ffmpeg when missing. Video frames are taken at
 * `min(1s, duration/2)` (or `atFrame` when supplied); images are scaled
 * directly; audio and Lottie get a neutral placeholder card (the client
 * renders Lottie itself).
 *
 * @returns {Promise<string>} absolute thumbnail path
 */
export async function ensureThumbnail({ projectRoot, media, atFrame } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new MediaError('projectRoot must be a non-empty path', 'invalid-input');
  }
  if (media === null || typeof media !== 'object') {
    throw new MediaError('media is required', 'invalid-input');
  }
  const root = path.resolve(projectRoot);
  const thumbnailDir = path.join(root, 'thumbnails');
  await mkdir(thumbnailDir, { recursive: true });
  const destination = path.join(thumbnailDir, `${sanitizeId(media.id)}.jpg`);

  try {
    const cached = await stat(destination);
    if (cached.isFile() && cached.size > 0) return destination;
  } catch {
    // Not cached yet.
  }

  // Validate the source path before checking tools: an escaping media entry is
  // a caller error regardless of whether ffmpeg happens to be installed.
  // Audio and Lottie cannot be decoded by ffmpeg from their original file here
  // (Lottie is rendered by the client), so they get a neutral placeholder.
  const isAudio = media.kind === 'audio';
  const needsPlaceholder = isAudio || media.kind === 'lottie';
  const source = needsPlaceholder ? null : mediaFilePath(root, media);

  const tools = resolveTools();
  if (tools.ffmpeg === null) {
    throw new MediaError('ffmpeg is not available (set OPENTAKE_STUDIO_FFMPEG or install ffmpeg)', 'ffmpeg-unavailable');
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-an'];
  if (needsPlaceholder) {
    const height = Math.round((THUMBNAIL_WIDTH * 9) / 16);
    args.push(
      '-f', 'lavfi',
      '-i', `color=c=0x11161d:s=${THUMBNAIL_WIDTH}x${height}:d=1`,
      '-frames:v', '1',
    );
  } else {
    if (media.kind === 'video') {
      args.push('-ss', formatSeconds(thumbnailTimeSeconds(media, atFrame)));
    }
    args.push('-i', source, '-frames:v', '1', '-vf', `scale=${THUMBNAIL_WIDTH}:-2`);
  }
  args.push('-q:v', '3', destination);

  try {
    await runFfmpeg(args, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }

  let generated;
  try {
    generated = await stat(destination);
  } catch (error) {
    throw new MediaError(`Thumbnail generation produced no file for media ${media.id}`, 'ffmpeg-failed', { cause: error });
  }
  if (!generated.isFile() || generated.size === 0) {
    await rm(destination, { force: true });
    throw new MediaError(`Thumbnail generation produced an empty file for media ${media.id}`, 'ffmpeg-failed');
  }
  return destination;
}


// ---------------------------------------------------------------------------
// Proxy media
// ---------------------------------------------------------------------------

export const PROXY_DIR = 'proxies';
export const DEFAULT_PROXY_HEIGHT = 360;

/** Resolve the proxy file path for a media asset (validated inside root). */
export function proxyFilePath(projectRoot, media) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new MediaError('proxyFilePath requires a projectRoot path', 'invalid-input');
  }
  if (media === null || typeof media !== 'object' || typeof media.id !== 'string') {
    throw new MediaError('proxyFilePath requires a media object', 'invalid-input');
  }
  const root = path.resolve(projectRoot);
  const dir = path.join(root, PROXY_DIR);
  const file = path.join(dir, `${path.basename(media.id)}.mp4`);
  if (!file.startsWith(`${dir}${path.sep}`)) {
    throw new MediaError('Proxy path escapes the project proxies directory', 'invalid-input');
  }
  return file;
}

/**
 * Generate (or reuse) a low-resolution preview proxy for a video asset.
 * Export always uses the original file; proxies are preview-only.
 */
export async function ensureProxy({ projectRoot, media, height = DEFAULT_PROXY_HEIGHT } = {}) {
  if (media === null || typeof media !== 'object') {
    throw new MediaError('ensureProxy requires a media object', 'invalid-input');
  }
  if (media.kind !== 'video') {
    throw new MediaError('Proxies are only generated for video media', 'invalid-input');
  }
  const tools = resolveTools();
  if (tools.ffmpeg === null) {
    throw new MediaError('ffmpeg is not available (set OPENTAKE_STUDIO_FFMPEG or install ffmpeg)', 'ffmpeg-unavailable');
  }
  const source = mediaFilePath(projectRoot, media);
  const destination = proxyFilePath(projectRoot, media);
  try {
    const info = await stat(destination);
    if (info.isFile() && info.size > 0) return destination;
  } catch {
    // Generate below.
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const targetHeight = Math.max(120, Math.min(720, Math.round(Number(height) || DEFAULT_PROXY_HEIGHT)));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', `scale=-2:${targetHeight}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
    destination,
  ];
  try {
    await runFfmpeg(args, { signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    throw new MediaError(`Proxy generation failed for media ${media.id}`, 'ffmpeg-failed', { cause: error });
  }
  const generated = await stat(destination).catch(() => null);
  if (generated === null || !generated.isFile() || generated.size === 0) {
    await rm(destination, { force: true }).catch(() => {});
    throw new MediaError(`Proxy generation produced no file for media ${media.id}`, 'ffmpeg-failed');
  }
  return destination;
}
