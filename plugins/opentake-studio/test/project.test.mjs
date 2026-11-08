import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_FILE,
  ProjectError,
  createProjectAt,
  openProjectAt,
  projectPaths,
  saveProjectAt,
} from '../lib/project.js';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'ots-project-test-'));
}

test('projectPaths resolves the conventional layout', () => {
  const paths = projectPaths('/tmp/example');
  assert.equal(paths.root, '/tmp/example');
  assert.equal(paths.name, 'example');
  assert.equal(paths.projectFile, `/tmp/example/${PROJECT_FILE}`);
  assert.equal(paths.mediaDir, '/tmp/example/media');
  assert.equal(paths.thumbDir, '/tmp/example/thumbnails');
  assert.equal(paths.exportsDir, '/tmp/example/exports');
});

test('createProjectAt writes a project and creates working directories', async () => {
  const root = await tempRoot();
  try {
    const created = await createProjectAt(root, { name: 'Test', fps: 30, width: 1280, height: 720 });
    assert.equal(created.project.name, 'Test');
    assert.equal(created.project.fps, 30);
    assert.equal(created.paths.root, path.resolve(root));
    const raw = JSON.parse(await readFile(created.paths.projectFile, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.name, 'Test');
    assert.deepEqual(raw.tracks, []);
    for (const dir of [created.paths.mediaDir, created.paths.thumbDir, created.paths.exportsDir]) {
      await readFile(path.join(dir, '.keep')).catch(() => {});
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createProjectAt refuses an existing project without overwriting it', async () => {
  const root = await tempRoot();
  try {
    await createProjectAt(root, { name: 'First' });
    await assert.rejects(
      createProjectAt(root, { name: 'Second' }),
      (error) => error instanceof ProjectError && error.code === 'project-exists',
    );
    const opened = await openProjectAt(root);
    assert.equal(opened.project.name, 'First');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openProjectAt rejects missing and malformed projects', async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(
      openProjectAt(root),
      (error) => error instanceof ProjectError && error.code === 'project-not-found',
    );
    await writeFile(path.join(root, PROJECT_FILE), '{not json', 'utf8');
    await assert.rejects(
      openProjectAt(root),
      (error) => error instanceof ProjectError && error.code === 'invalid-project',
    );
    await writeFile(path.join(root, PROJECT_FILE), JSON.stringify({ version: 9 }), 'utf8');
    await assert.rejects(
      openProjectAt(root),
      (error) => error instanceof ProjectError && error.code === 'invalid-project',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveProjectAt round-trips a normalized project and is atomic', async () => {
  const root = await tempRoot();
  try {
    const created = await createProjectAt(root, { name: 'Roundtrip' });
    const next = {
      ...created.project,
      name: 'Renamed',
      updatedAt: Date.now(),
    };
    const saved = await saveProjectAt(root, next);
    const reopened = await openProjectAt(saved.root);
    assert.equal(reopened.project.name, 'Renamed');
    assert.equal(reopened.project.version, 1);
    const raw = await readFile(saved.projectFile, 'utf8');
    assert.ok(raw.endsWith('}'));
    assert.ok(!raw.includes('.tmp'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
