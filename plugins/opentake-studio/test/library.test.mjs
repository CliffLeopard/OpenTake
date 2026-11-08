import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addLibraryItemToProject,
  deleteLibraryItem,
  importFolderToLibrary,
  libraryAssetPath,
  libraryPaths,
  listLibrary,
  updateLibraryItem,
} from '../lib/library.js';
import { createProject } from '../lib/model.js';

const exec = promisify(execFile);
const FFMPEG = process.env.OPENTAKE_STUDIO_FFMPEG ?? 'ffmpeg';

async function canFfmpeg() {
  try {
    await exec(FFMPEG, ['-version']);
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = await canFfmpeg();
const skip = HAS_FFMPEG ? {} : { skip: 'ffmpeg is not available' };

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function generateVideo(file) {
  await exec(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ]);
}

test('library paths default under the DSH home and can be overridden', () => {
  const defaults = libraryPaths();
  assert.ok(defaults.root.includes('.dsh'));
  assert.equal(defaults.manifestFile, path.join(defaults.root, 'library.json'));
  const custom = libraryPaths('/tmp/custom-library');
  assert.equal(custom.root, '/tmp/custom-library');
  assert.equal(custom.mediaDir, '/tmp/custom-library/media');
});

test('imports media, dedupes by sha256, lists and filters', skip, async () => {
  const root = await tempDir('ots-library-');
  const folder = await tempDir('ots-library-src-');
  try {
    const video = path.join(folder, 'a.mp4');
    await generateVideo(video);
    const first = await importFolderToLibrary({ folderPath: folder, libraryRoot: root });
    assert.equal(first.imported.length, 1);
    assert.equal(first.skipped.length, 0);
    const item = first.imported[0];
    assert.equal(item.kind, 'video');
    assert.equal(item.name, 'a.mp4');
    assert.ok(item.sha256.length === 64);
    assert.ok((await stat(libraryAssetPath(root, item))).size > 0);
    assert.ok((await stat(path.join(root, 'library.json'))).isFile());

    const second = await importFolderToLibrary({ folderPath: folder, libraryRoot: root });
    assert.equal(second.imported.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0].reason, 'duplicate');

    const listed = await listLibrary({ libraryRoot: root });
    assert.equal(listed.items.length, 1);
    assert.equal((await listLibrary({ libraryRoot: root, kind: 'audio' })).items.length, 0);
    assert.equal((await listLibrary({ libraryRoot: root, query: 'a.mp4' })).items.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test('updates favorite/category/name and deletes assets', skip, async () => {
  const root = await tempDir('ots-library-');
  const folder = await tempDir('ots-library-src-');
  try {
    await generateVideo(path.join(folder, 'b.mp4'));
    const { imported } = await importFolderToLibrary({ folderPath: folder, libraryRoot: root });
    const id = imported[0].id;
    const updated = await updateLibraryItem({
      libraryRoot: root,
      itemId: id,
      patch: { name: 'Renamed', favorite: true, category: 'B-roll', tags: ['sky'] },
    });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.favorite, true);
    const favorites = await listLibrary({ libraryRoot: root, favorite: true });
    assert.equal(favorites.items.length, 1);
    const asset = libraryAssetPath(root, updated);
    assert.ok((await stat(asset)).isFile());
    await deleteLibraryItem({ libraryRoot: root, itemId: id });
    await assert.rejects(stat(asset));
    assert.equal((await listLibrary({ libraryRoot: root })).items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test('adds a library item to a project as a normal media asset', skip, async () => {
  const root = await tempDir('ots-library-');
  const folder = await tempDir('ots-library-src-');
  const projectRoot = await tempDir('ots-library-project-');
  try {
    await generateVideo(path.join(folder, 'clip.mp4'));
    const { imported } = await importFolderToLibrary({ folderPath: folder, libraryRoot: root });
    const item = imported[0];
    const project = createProject({ name: 'Library Project', fps: 24 });
    const media = await addLibraryItemToProject({
      libraryRoot: root,
      projectRoot,
      projectFps: project.fps,
      itemId: item.id,
    });
    assert.equal(media.kind, 'video');
    assert.equal(media.durationFrames, 24);
    assert.ok((await stat(path.join(projectRoot, 'media', media.fileName))).isFile());
    assert.equal((await readFile(path.join(projectRoot, 'media', media.fileName))).length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
