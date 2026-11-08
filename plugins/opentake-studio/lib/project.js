/**
 * Project storage for OpenTake Studio.
 *
 * A project is a directory owned by the user:
 *
 *   <root>/opentake-studio.json   canonical Project JSON
 *   <root>/media/                 imported media files
 *   <root>/thumbnails/            generated JPEG thumbnails
 *   <root>/exports/               default export output
 *
 * The JSON is written atomically (temporary sibling + rename) so a crash or a
 * concurrent reader never observes a half-written project.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createProject, normalizeProject } from './model.js';

export const PROJECT_FILE = 'opentake-studio.json';

/** A project-storage failure with a stable code for the Host routes. */
export class ProjectError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

/**
 * Resolve the conventional paths of one project root.
 * @param {string} root absolute or relative directory
 * @returns {{ root: string, name: string, projectFile: string, mediaDir: string, thumbDir: string, exportsDir: string }}
 */
export function projectPaths(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ProjectError('A project folder path is required', 'invalid-input');
  }
  const resolved = path.resolve(root);
  return {
    root: resolved,
    name: path.basename(resolved) || 'OpenTake Studio',
    projectFile: path.join(resolved, PROJECT_FILE),
    mediaDir: path.join(resolved, 'media'),
    thumbDir: path.join(resolved, 'thumbnails'),
    exportsDir: path.join(resolved, 'exports'),
  };
}

async function ensureDirectories(paths) {
  await Promise.all([
    mkdir(paths.mediaDir, { recursive: true }),
    mkdir(paths.thumbDir, { recursive: true }),
    mkdir(paths.exportsDir, { recursive: true }),
  ]);
}

/**
 * Create a new project directory.
 * @param {string} root
 * @param {{ name?: string, fps?: number, width?: number, height?: number }} [options]
 * @returns {Promise<{ project: import('./model.js').Project, paths: ReturnType<typeof projectPaths> }>}
 */
export async function createProjectAt(root, options = {}) {
  const paths = projectPaths(root);
  await mkdir(paths.root, { recursive: true });
  await ensureDirectories(paths);
  const project = createProject({
    name: options.name ?? paths.name,
    ...(options.fps === undefined ? {} : { fps: options.fps }),
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
  });
  try {
    await writeFile(paths.projectFile, JSON.stringify(project, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new ProjectError('A project already exists in this folder', 'project-exists');
    }
    throw new ProjectError(`Could not create the project file: ${messageOf(error)}`, 'io-error');
  }
  return { project, paths };
}

/**
 * Open an existing project directory.
 * @param {string} root
 * @returns {Promise<{ project: import('./model.js').Project, paths: ReturnType<typeof projectPaths> }>}
 */
export async function openProjectAt(root) {
  const paths = projectPaths(root);
  let raw;
  try {
    raw = await readFile(paths.projectFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ProjectError('No OpenTake Studio project was found in this folder', 'project-not-found');
    }
    throw new ProjectError(`Could not read the project file: ${messageOf(error)}`, 'io-error');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectError('The project file is not valid JSON', 'invalid-project');
  }
  let project;
  try {
    project = normalizeProject(parsed);
  } catch (error) {
    throw new ProjectError(`The project file is invalid: ${messageOf(error)}`, 'invalid-project');
  }
  await ensureDirectories(paths);
  return { project, paths };
}

/**
 * Atomically save a project next to its media.
 * @param {string} root
 * @param {import('./model.js').Project} project
 * @returns {Promise<ReturnType<typeof projectPaths>>}
 */
export async function saveProjectAt(root, project) {
  const paths = projectPaths(root);
  await mkdir(paths.root, { recursive: true });
  await ensureDirectories(paths);
  const temporary = `${paths.projectFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(project, null, 2), 'utf8');
    await rename(temporary, paths.projectFile);
  } catch (error) {
    throw new ProjectError(`Could not save the project: ${messageOf(error)}`, 'io-error');
  }
  return paths;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
