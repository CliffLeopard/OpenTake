/**
 * Global media library for OpenTake Studio.
 *
 * The library is a content-addressed store outside any single project:
 *
 *   <libraryRoot>/
 *   ├── library.json          # manifest (version 1)
 *   ├── media/<id>-<name>     # assets
 *   └── thumbnails/<id>.jpg   # lazily generated previews
 *
 * It never contains project data. Adding a library item to a project copies or
 * hard-links the asset into the project's own `media/` directory and returns a
 * normal project Media object, so projects remain self-contained.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MediaError, ensureThumbnail, isMediaFile, probeMedia, scanMediaFolder } from './media.js';

export const LIBRARY_FILE = 'library.json';
const LIBRARY_VERSION = 1;

export class LibraryError extends Error {
  constructor(code, message, options) {
    super(message ?? code, options);
    this.name = 'LibraryError';
    this.code = code;
  }
}

/** Resolve the default library root (overridable for tests/embedding). */
export function libraryPaths(rootInput) {
  const root = path.resolve(
    rootInput ??
      process.env.OPENTAKE_STUDIO_LIBRARY ??
      path.join(os.homedir(), '.dsh', 'opentake-studio', 'library'),
  );
  return {
    root,
    manifestFile: path.join(root, LIBRARY_FILE),
    mediaDir: path.join(root, 'media'),
    thumbDir: path.join(root, 'thumbnails'),
  };
}

function emptyLibrary() {
  return { version: LIBRARY_VERSION, items: [], folders: [] };
}

function sanitizeName(fileName) {
  const base = path.basename(String(fileName));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.length === 0 ? 'media' : cleaned.slice(0, 180);
}

function validateLibrary(value) {
  if (value === null || typeof value !== 'object' || value.version !== LIBRARY_VERSION) {
    throw new LibraryError('invalid-library', 'library.json has an unsupported shape');
  }
  if (!Array.isArray(value.items)) {
    throw new LibraryError('invalid-library', 'library.json items must be an array');
  }
  const folders = [];
  const folderIds = new Set();
  if (Array.isArray(value.folders)) {
    for (const raw of value.folders) {
      if (raw === null || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || raw.id.length === 0 || folderIds.has(raw.id)) continue;
      folderIds.add(raw.id);
      folders.push({
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'Folder',
        parentId: typeof raw.parentId === 'string' && folderIds.has(raw.parentId) ? raw.parentId : null,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      });
    }
  }
  const seen = new Set();
  const items = [];
  for (const raw of value.items) {
    if (raw === null || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) continue;
    if (typeof raw.fileName !== 'string' || raw.fileName.length === 0) continue;
    if (!['video', 'audio', 'image'].includes(raw.kind)) continue;
    seen.add(raw.id);
    items.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.fileName,
      fileName: path.basename(raw.fileName),
      kind: raw.kind,
      width: Number.isFinite(raw.width) ? raw.width : null,
      height: Number.isFinite(raw.height) ? raw.height : null,
      durationSeconds: Number.isFinite(raw.durationSeconds) ? raw.durationSeconds : null,
      hasAudio: raw.hasAudio === true,
      sizeBytes: Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
      favorite: raw.favorite === true,
      category: typeof raw.category === 'string' ? raw.category : '',
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
      folderId: typeof raw.folderId === 'string' && folderIds.has(raw.folderId) ? raw.folderId : null,
      sourcePath: typeof raw.sourcePath === 'string' ? raw.sourcePath : null,
      importedAt: Number.isFinite(raw.importedAt) ? raw.importedAt : Date.now(),
    });
  }
  return { version: LIBRARY_VERSION, items, folders };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readManifest(paths) {
  try {
    const raw = await readFile(paths.manifestFile, 'utf8');
    return validateLibrary(JSON.parse(raw));
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return emptyLibrary();
    if (error instanceof LibraryError) throw error;
    throw new LibraryError('invalid-library', `Could not read library manifest: ${paths.manifestFile}`, {
      cause: error,
    });
  }
}

async function writeManifest(paths, library) {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.mediaDir, { recursive: true });
  await mkdir(paths.thumbDir, { recursive: true });
  const temporary = `${paths.manifestFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
  await rename(temporary, paths.manifestFile);
}

async function linkOrCopy(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EEXIST') return;
    await copyFile(source, destination);
  }
}

/**
 * Import every media file under `folderPath` into the global library.
 * Content-addressed: identical bytes are deduplicated by SHA-256.
 */
export async function importFolderToLibrary({ folderPath, libraryRoot, folderId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  await mkdir(paths.mediaDir, { recursive: true });
  await mkdir(paths.thumbDir, { recursive: true });
  const files = await scanMediaFolder(folderPath);
  const imported = [];
  const skipped = [];
  const known = new Set(library.items.map((item) => item.sha256).filter(Boolean));
  for (const source of files) {
    if (!isMediaFile(source)) continue;
    try {
      const probe = await probeMedia(source);
      const sha256 = await sha256File(source);
      if (known.has(sha256)) {
        skipped.push({ source, reason: 'duplicate' });
        continue;
      }
      const id = randomUUID();
      const fileName = `${id}-${sanitizeName(path.basename(source))}`;
      await linkOrCopy(source, path.join(paths.mediaDir, fileName));
      const item = {
        id,
        name: path.basename(source),
        fileName,
        kind: probe.kind,
        width: probe.width,
        height: probe.height,
        durationSeconds: probe.durationSeconds,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes,
        sha256,
        favorite: false,
        category: '',
        tags: [],
        folderId: typeof folderId === 'string' && library.folders.some((folder) => folder.id === folderId) ? folderId : null,
        sourcePath: source,
        importedAt: Date.now(),
      };
      library.items.push(item);
      known.add(sha256);
      imported.push(item);
    } catch (error) {
      skipped.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (imported.length > 0) await writeManifest(paths, library);
  return { library, imported, skipped };
}

/** List library items, optionally filtered. */
export async function listLibrary({ libraryRoot, query, kind, favorite, category, folderId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const items = library.items
    .filter((item) => (kind === undefined ? true : item.kind === kind))
    .filter((item) => (favorite === undefined ? true : item.favorite === favorite))
    .filter((item) => (category === undefined ? true : item.category === category))
    .filter((item) => (folderId === undefined ? true : folderId === null ? item.folderId === null : item.folderId === folderId))
    .filter((item) => {
      if (needle.length === 0) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.category.toLowerCase().includes(needle) ||
        item.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    })
    .sort((left, right) => right.importedAt - left.importedAt);
  return { ...paths, items, folders: library.folders };
}

function findItem(library, itemId) {
  const item = library.items.find((entry) => entry.id === itemId);
  if (item === undefined) throw new LibraryError('library-item-not-found', `Library item not found: ${itemId}`);
  return item;
}

/** Update name/favorite/category/tags. */
export async function updateLibraryItem({ libraryRoot, itemId, patch } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const item = findItem(library, itemId);
  if (patch !== null && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim().length > 0) item.name = patch.name.trim();
    if (typeof patch.favorite === 'boolean') item.favorite = patch.favorite;
    if (typeof patch.category === 'string') item.category = patch.category;
    if (patch.folderId === null) item.folderId = null;
    else if (typeof patch.folderId === 'string') {
      const targetFolder = library.folders.find((folder) => folder.id === patch.folderId);
      if (targetFolder === undefined) throw new LibraryError('folder-not-found', `Folder not found: ${patch.folderId}`);
      item.folderId = targetFolder.id;
    }
    if (Array.isArray(patch.tags)) item.tags = patch.tags.filter((tag) => typeof tag === 'string');
  }
  await writeManifest(paths, library);
  return item;
}

/** Delete a library item and its asset. */
export async function deleteLibraryItem({ libraryRoot, itemId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const item = findItem(library, itemId);
  library.items = library.items.filter((entry) => entry.id !== itemId);
  await writeManifest(paths, library);
  // Remove only files inside the library's own directories.
  const asset = path.join(paths.mediaDir, path.basename(item.fileName));
  const thumb = path.join(paths.thumbDir, `${item.id}.jpg`);
  await rm(asset, { force: true }).catch(() => {});
  await rm(thumb, { force: true }).catch(() => {});
  return item;
}

/** Resolve a library item's absolute asset path, rejecting escapes. */
export function libraryAssetPath(libraryRoot, item) {
  const paths = libraryPaths(libraryRoot);
  const resolved = path.resolve(paths.mediaDir, path.basename(item.fileName));
  if (!resolved.startsWith(`${paths.mediaDir}${path.sep}`)) {
    throw new LibraryError('library-path-escape', 'Library asset path escapes the library directory');
  }
  return resolved;
}

/** Generate (or reuse) a JPEG thumbnail for a library item. */
export async function ensureLibraryThumbnail({ libraryRoot, item } = {}) {
  const paths = libraryPaths(libraryRoot);
  const source = libraryAssetPath(libraryRoot, item);
  const file = await stat(source).catch(() => null);
  if (file === null || !file.isFile()) throw new LibraryError('library-item-missing', 'Library asset is missing');
  const media = {
    id: item.id,
    kind: item.kind,
    fileName: item.fileName,
    durationFrames: null,
  };
  return ensureThumbnail({ projectRoot: paths.root, media });
}

/**
 * Add a library item to a project: hard-link/copy into the project's media
 * directory and return a project Media object (caller adds it with `add-media`).
 */
export async function addLibraryItemToProject({ libraryRoot, projectRoot, projectFps, itemId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const item = findItem(library, itemId);
  const source = libraryAssetPath(libraryRoot, item);
  const root = path.resolve(projectRoot);
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir, { recursive: true });
  const mediaId = randomUUID();
  const fileName = `${mediaId}-${sanitizeName(item.name)}`;
  const destination = path.join(mediaDir, fileName);
  await linkOrCopy(source, destination);
  const fps = Math.max(1, Number(projectFps) || 30);
  return {
    id: mediaId,
    name: item.name,
    kind: item.kind,
    fileName,
    durationFrames:
      item.kind === 'image' || item.durationSeconds === null
        ? null
        : Math.max(1, Math.round(item.durationSeconds * fps)),
    sourceDurationSeconds: item.durationSeconds,
    width: item.width,
    height: item.height,
    hasAudio: item.hasAudio,
    sizeBytes: item.sizeBytes,
    importedAt: Date.now(),
  };
}

/** Create a library folder; parentId must exist when supplied. */
export async function createLibraryFolder({ libraryRoot, name, parentId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const value = typeof name === 'string' ? name.trim() : '';
  if (value.length === 0) throw new LibraryError('invalid-input', 'A folder name is required');
  let parent = null;
  if (parentId !== undefined && parentId !== null) {
    parent = library.folders.find((folder) => folder.id === parentId);
    if (parent === undefined) throw new LibraryError('folder-not-found', `Folder not found: ${parentId}`);
    parent = parent.id;
  }
  const folder = { id: randomUUID(), name: value.slice(0, 120), parentId: parent, createdAt: Date.now() };
  library.folders.push(folder);
  await writeManifest(paths, library);
  return folder;
}

/** Rename a folder or move it under another folder. */
export async function updateLibraryFolder({ libraryRoot, folderId, patch } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const folder = library.folders.find((entry) => entry.id === folderId);
  if (folder === undefined) throw new LibraryError('folder-not-found', `Folder not found: ${folderId}`);
  if (patch !== null && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim().length > 0) folder.name = patch.name.trim().slice(0, 120);
    if (patch.parentId === null) folder.parentId = null;
    else if (typeof patch.parentId === 'string') {
      if (patch.parentId === folder.id) throw new LibraryError('invalid-input', 'A folder cannot be its own parent');
      const parent = library.folders.find((entry) => entry.id === patch.parentId);
      if (parent === undefined) throw new LibraryError('folder-not-found', `Folder not found: ${patch.parentId}`);
      // Reject cycles by walking up from the proposed parent.
      let cursor = parent;
      const seen = new Set();
      while (cursor !== undefined && cursor !== null) {
        if (cursor.id === folder.id) throw new LibraryError('invalid-input', 'Folder cycle');
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        cursor = library.folders.find((entry) => entry.id === cursor.parentId);
      }
      folder.parentId = parent.id;
    }
  }
  await writeManifest(paths, library);
  return folder;
}

/** Delete a folder, moving its child folders and items to its parent/root. */
export async function deleteLibraryFolder({ libraryRoot, folderId } = {}) {
  const paths = libraryPaths(libraryRoot);
  const library = await readManifest(paths);
  const folder = library.folders.find((entry) => entry.id === folderId);
  if (folder === undefined) throw new LibraryError('folder-not-found', `Folder not found: ${folderId}`);
  const parentId = folder.parentId;
  library.folders = library.folders.filter((entry) => entry.id !== folderId);
  for (const child of library.folders) if (child.parentId === folderId) child.parentId = parentId;
  for (const item of library.items) if (item.folderId === folderId) item.folderId = parentId;
  await writeManifest(paths, library);
  return folder;
}

/** Move an item to a folder (null = root). */
export async function moveLibraryItem({ libraryRoot, itemId, folderId } = {}) {
  return updateLibraryItem({ libraryRoot, itemId, patch: { folderId: folderId ?? null } });
}

/** Read the raw manifest (for tools/tests). */
export async function openLibrary({ libraryRoot } = {}) {
  const paths = libraryPaths(libraryRoot);
  return { ...paths, ...(await readManifest(paths)) };
}
