/**
 * Host integration tests for OpenTake Studio (`plugins/opentake-studio/index.js`).
 *
 * These tests run the real plugin against a fake Cordis host surface:
 *
 *   - `ctx.get('tools')` with the live DSH registration contract
 *     (duplicate names fail, `register()` returns the exact disposer);
 *   - `ctx.webServer.register({ kind: 'prefix', path, handler })`;
 *   - `ctx.effect(fn)` registering disposers;
 *   - `connection.requestRejection(req)` as the same-origin fence.
 *
 * Requests are issued through an in-process fake `IncomingMessage`/`ServerResponse`
 * pair, so no DSH host and no HTTP listener is involved. ffmpeg/ffprobe are the
 * real system binaries; tests that need media generation/encoding are skipped
 * when those tools are unavailable.
 *
 * Run with: node --test plugins/opentake-studio/test/host.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { apply, inject, name } from '../index.js';
import { resetToolCache, resolveTools, runFfmpeg, runFfprobe } from '../lib/media.js';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS = resolveTools();
const CAN_FFMPEG = TOOLS.available;
const FFPEG_SKIP = CAN_FFMPEG ? false : 'ffmpeg/ffprobe are not available on this machine';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, 'base64');

const PREFIX = '/opentake-studio';

/** Tool list registered by index.js, in registration order. */
const EXPECTED_TOOLS = [
  'opentake_studio_get_state',
  'opentake_studio_list_media',
  'opentake_studio_edit',
  'opentake_studio_rename_project',
  'opentake_studio_update_track',
  'opentake_studio_remove_track',
  'opentake_studio_import_captions',
  'opentake_studio_export_captions',
  'opentake_studio_library_list',
  'opentake_studio_library_import',
  'opentake_studio_library_add_to_project',
  'opentake_studio_library_update',
  'opentake_studio_library_delete',
  'opentake_studio_new_project',
  'opentake_studio_open_project',
  'opentake_studio_import_media',
  'opentake_studio_add_clip',
  'opentake_studio_move_clip',
  'opentake_studio_trim_clip',
  'opentake_studio_split_clip',
  'opentake_studio_remove_clips',
  'opentake_studio_set_clip_properties',
  'opentake_studio_add_text',
  'opentake_studio_undo',
  'opentake_studio_redo',
  'opentake_studio_export',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = Object.create(null);
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

/**
 * Build one plugin instance over a fake Cordis host.
 * @returns {{
 *   tools: Map<string, object>,
 *   routes: Array<object>,
 *   request(method: string, url: string, options?: object): Promise<object>,
 *   setRejection(value: number | undefined): void,
 *   dispose(): void,
 * }}
 */
function createHost({ connectionGuard = true } = {}) {
  const tools = new Map();
  const routes = [];
  const cleanups = [];
  let rejection;

  const toolRegistry = {
    register(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`tool already registered: ${definition.name}`);
      }
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };

  const ctx = {
    get(service) {
      return service === 'tools' ? toolRegistry : undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    webServer: {
      register(options) {
        routes.push(options);
        return () => {
          const index = routes.indexOf(options);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    connection: connectionGuard
      ? {
          requestRejection() {
            return rejection;
          },
        }
      : {},
  };

  apply(ctx);

  async function request(method, url, { body, headers = {} } = {}) {
    const route = routes.find(
      (candidate) =>
        candidate.kind === 'prefix' &&
        (url === candidate.path || url.startsWith(`${candidate.path}/`)),
    );
    assert.ok(route, `plugin registered no prefix route matching ${url}`);

    const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))];
    const req = Readable.from(payload);
    req.method = method;
    req.url = url;
    req.headers = { ...headers };

    const res = new FakeResponse();
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fake response timed out for ${method} ${url}`)),
        20_000,
      );
      timer.unref?.();
      res.once('finish', () => {
        clearTimeout(timer);
        resolve();
      });
      res.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    await route.handler(req, res);
    await finished;

    const bytes = Buffer.concat(res.chunks);
    const text = bytes.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not every response is JSON (byte streams and empty bodies).
    }
    return { status: res.statusCode, headers: res.headers, bytes, text, json };
  }

  return {
    tools,
    routes,
    request,
    setRejection(value) {
      rejection = value;
    },
    dispose() {
      for (const cleanup of [...cleanups].reverse()) {
        try {
          cleanup();
        } catch {
          // Disposal is best effort in a test double.
        }
      }
    },
  };
}

async function withHost(fn) {
  const host = createHost();
  try {
    return await fn(host);
  } finally {
    host.dispose();
  }
}

let tempRoot = null;
let fixtureDir = null;
let fixtureFiles = null;
let projectCounter = 0;

function nextProjectDir(label = 'project') {
  projectCounter += 1;
  return path.join(tempRoot, `${label}-${projectCounter}`);
}

async function createProjectOn(host, label = 'project', options = {}) {
  const root = options.root ?? nextProjectDir(label);
  const response = await host.request('POST', `${PREFIX}/project/new`, {
    body: JSON.stringify({
      path: root,
      name: options.name ?? 'Host Test',
      fps: options.fps ?? 30,
      width: options.width ?? 320,
      height: options.height ?? 180,
    }),
  });
  assert.equal(response.status, 200, response.text);
  return { root: response.json.projectRoot, state: response.json };
}

async function openProjectOn(host, root) {
  return host.request('POST', `${PREFIX}/project/open`, {
    body: JSON.stringify({ path: root }),
  });
}

async function edit(host, operations) {
  return host.request('POST', `${PREFIX}/edit`, {
    body: JSON.stringify({ operations }),
  });
}

async function callTool(host, toolName, args = {}) {
  const tool = host.tools.get(toolName);
  assert.ok(tool, `tool ${toolName} is not registered`);
  return tool.execute(args, { callId: 'host-test', signal: new AbortController().signal });
}

function allClips(state) {
  return (state.project?.tracks ?? []).flatMap((track) =>
    track.clips.map((clip) => ({ ...clip, trackId: track.id, trackName: track.name })),
  );
}

function clipById(state, clipId) {
  return allClips(state).find((clip) => clip.id === clipId) ?? null;
}

function trackById(state, trackId) {
  return (state.project?.tracks ?? []).find((track) => track.id === trackId) ?? null;
}

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function waitForExport(host, { timeoutMs = 30_000 } = {}) {
  let last = null;
  const done = await waitFor(
    async () => {
      const response = await host.request('GET', `${PREFIX}/export/status`);
      assert.equal(response.status, 200, response.text);
      last = response.json.export;
      return last.state !== 'running';
    },
    { timeoutMs },
  );
  assert.ok(done, `export did not settle: ${JSON.stringify(last)}`);
  return last;
}

async function probeStreams(filePath) {
  const text = await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath,
  ]);
  return JSON.parse(text);
}

/**
 * Add one media entry backed by an arbitrary local file (no ffprobe needed).
 * Used by the byte-serving tests so they run without ffmpeg.
 */
async function addManualMedia(host, projectRoot, options = {}) {
  const fileName = options.fileName ?? 'manual.mp4';
  const content = options.content ?? Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await mkdir(path.join(projectRoot, 'media'), { recursive: true });
  await writeFile(path.join(projectRoot, 'media', fileName), content);
  const media = {
    id: options.id ?? 'manual-media',
    name: options.name ?? fileName,
    kind: options.kind ?? 'video',
    fileName,
    durationFrames: options.kind === 'image' ? null : (options.durationFrames ?? 60),
    sourceDurationSeconds: options.kind === 'image' ? null : 2,
    width: options.kind === 'audio' ? null : 320,
    height: options.kind === 'audio' ? null : 180,
    hasAudio: false,
    sizeBytes: content.byteLength,
    importedAt: Date.now(),
  };
  const response = await edit(host, [{ type: 'add-media', media }]);
  assert.equal(response.status, 200, response.text);
  return { media, content };
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ots-host-test-'));
  fixtureDir = path.join(tempRoot, 'fixtures');
  await mkdir(fixtureDir, { recursive: true });
  fixtureFiles = {};
  if (!CAN_FFMPEG) return;

  fixtureFiles.video = path.join(fixtureDir, 'clip.mp4');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    fixtureFiles.video,
  ]);

  fixtureFiles.silent = path.join(fixtureDir, 'silent.mp4');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    fixtureFiles.silent,
  ]);

  fixtureFiles.sound = path.join(fixtureDir, 'sound.m4a');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    fixtureFiles.sound,
  ]);

  fixtureFiles.image = path.join(fixtureDir, 'card.png');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1',
    '-frames:v', '1',
    fixtureFiles.image,
  ]);

  await writeFile(path.join(fixtureDir, 'notes.txt'), 'not media');
});

after(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Create a project and import the generated fixture folder.
 * @returns {Promise<{ root: string, state: object, byName: Map<string, object> }>}
 */
async function projectWithFixtures(host, label = 'media-project', options = {}) {
  const project = await createProjectOn(host, label, options);
  const response = await host.request('POST', `${PREFIX}/media/import`, {
    body: JSON.stringify({ path: fixtureDir }),
  });
  assert.equal(response.status, 200, response.text);
  const byName = new Map(response.json.project.media.map((media) => [media.name, media]));
  return { ...project, state: response.json, byName };
}

/* ------------------------------------------------------------------------- */
/* Plugin shape and static contract                                          */
/* ------------------------------------------------------------------------- */

test('the host plugin exports the contract, one prefix route and the native tool set', async () => {
  assert.equal(name, 'opentake-studio');
  assert.deepEqual(inject, ['tools', 'webServer', 'connection']);

  await withHost(async (host) => {
    assert.equal(host.routes.length, 1);
    assert.equal(host.routes[0].kind, 'prefix');
    assert.equal(host.routes[0].path, PREFIX);
    assert.equal(typeof host.routes[0].handler, 'function');

    assert.deepEqual([...host.tools.keys()], EXPECTED_TOOLS);
    assert.equal(host.tools.has('opentake_studio_list_media'), true);

    for (const [toolName, definition] of host.tools) {
      assert.match(toolName, /^opentake_studio_[a-z_]+$/);
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 12, `${toolName} needs a real description`);
      assert.equal(definition.parameters.type, 'object');
      assert.equal(definition.parameters.additionalProperties, false);
      assert.equal(definition.output.schema.type, 'object');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(typeof definition.execute, 'function');
    }

    // Spot-check parameter schemas against DESIGN §7.4.
    assert.deepEqual(host.tools.get('opentake_studio_add_clip').parameters.required, [
      'mediaId',
      'startFrame',
    ]);
    assert.deepEqual(host.tools.get('opentake_studio_new_project').parameters.required, ['path']);
    assert.deepEqual(host.tools.get('opentake_studio_add_text').parameters.required, [
      'content',
      'startFrame',
    ]);
    assert.deepEqual(host.tools.get('opentake_studio_export').parameters.required, undefined);
  });
});

test('host/client sources stay pure DSH: no MCP, no external editor binary, react-only client', async () => {
  const hostFiles = ['index.js', 'lib/model.js', 'lib/project.js', 'lib/media.js', 'lib/export.js'];
  const sources = new Map();
  for (const file of hostFiles) {
    sources.set(file, await readFile(path.join(PLUGIN_ROOT, file), 'utf8'));
  }
  const clientSource = await readFile(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  const patch = await readFile(path.join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');

  // The bundle patch points at this package only.
  assert.match(patch, /name:\s*'@opentake\/studio'/);

  // Host/lib code imports only Node builtins and local modules.
  for (const [file, source] of sources) {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./'),
        `${file} imports unexpected dependency ${specifier}`,
      );
    }
    assert.doesNotMatch(source, /@modelcontextprotocol|mcp-client|external_mcp|opentake-agent/i);
    assert.doesNotMatch(source, /OpenTake\.app|\/Applications\//);
  }

  // Only the media library spawns processes, and only the resolved ffmpeg/ffprobe.
  assert.doesNotMatch(sources.get('index.js'), /child_process|spawn\(/);
  const mediaSource = sources.get('lib/media.js');
  const spawnCalls = [...mediaSource.matchAll(/spawn\(([^,)]+)/g)].map((match) => match[1].trim());
  assert.deepEqual(spawnCalls, ['tools.ffmpeg', 'tools.ffprobe']);

  // No third-party dependencies at all.
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);

  // The client bundle loads through the DSH module loader and requires only react.
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/);
  const requires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(requires)], ['react']);
  assert.doesNotMatch(clientSource, /@deepseek-ai\//);

  // Slot registrations from DESIGN §8.
  assert.match(clientSource, /slots\.inject\('main'/);
  assert.match(clientSource, /name:\s*'main'/);
  assert.match(clientSource, /slots\.inject\('sidebar\.panellist'/);
  assert.match(clientSource, /name:\s*'sidebar\.panellist'/);
  assert.match(clientSource, /order:\s*15/);
  assert.match(clientSource, /slots\.inject\('settings\.section'/);
  assert.match(clientSource, /ctx\.locale\.register\(NS/);
  assert.match(clientSource, /const inject = \['slots', 'locale'\]/);
  assert.match(clientSource, /__DSH_DIRECTORY_PICKER__/);
  assert.match(clientSource, /ctx\.get\('uiWorkspace'\)/);
  assert.match(clientSource, /document\.createElement\('style'\)/);

  // The scoped stylesheet uses catalog theme tokens; the only literal color is
  // the intentional black video-canvas backdrop.
  const stylesStart = clientSource.indexOf('const STYLES = `');
  assert.ok(stylesStart >= 0, 'client.js must define one scoped STYLES sheet');
  const stylesEnd = clientSource.indexOf('\n`;', stylesStart);
  assert.ok(stylesEnd > stylesStart);
  const styles = clientSource.slice(stylesStart + 'const STYLES = `'.length, stylesEnd);
  assert.ok(styles.length > 1_000);
  const tokenNames = new Set(
    [...styles.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((match) => match[0]),
  );
  assert.ok(tokenNames.size >= 10, `expected theme tokens, saw ${tokenNames.size}`);
  const literalColors = [...styles.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)]
    .map((match) => match[0]);
  assert.deepEqual(literalColors, ['#000'], 'styles must use theme tokens (canvas backdrop excepted)');
  assert.doesNotMatch(styles, /(^|\n)\s*(body|html|:root)\b/);
});

/* ------------------------------------------------------------------------- */
/* State, routing and error mapping                                          */
/* ------------------------------------------------------------------------- */

test('reads empty state and fails closed without a project or browser fence', async () => {
  await withHost(async (host) => {
    const state = await host.request('GET', `${PREFIX}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.json.version, 1);
    assert.equal(state.json.project, null);
    assert.equal(state.json.projectRoot, null);
    assert.equal(state.json.export.state, 'idle');
    assert.equal(state.json.canUndo, false);
    assert.equal(state.json.canRedo, false);
    assert.equal(state.json.lastError, null);
    assert.equal(state.json.saveError, null);
    assert.equal(state.json.pluginVersion, '0.1.0');
    assert.equal(typeof state.json.ffmpeg.available, 'boolean');
    assert.equal(state.json.ffmpeg.available, TOOLS.available);

    // `/opentake-studio` and `/opentake-studio/` alias the state route.
    const alias = await host.request('GET', PREFIX);
    assert.equal(alias.status, 200);
    assert.equal(alias.json.project, null);

    // The same-origin fence applies to every route, including byte streaming.
    host.setRejection(403);
    for (const [method, url] of [
      ['GET', `${PREFIX}/state`],
      ['POST', `${PREFIX}/edit`],
      ['GET', `${PREFIX}/media/file/manual-media`],
      ['POST', `${PREFIX}/export`],
    ]) {
      const guarded = await host.request(method, url, {
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(guarded.status, 403, `${method} ${url} must be fenced`);
      assert.equal(guarded.bytes.length, 0);
    }
    host.setRejection(undefined);

    // No project: mutating routes answer 409 `no-project`; state stays readable.
    for (const [method, url, body] of [
      ['POST', `${PREFIX}/edit`, JSON.stringify({ operations: [] })],
      ['POST', `${PREFIX}/export`, '{}'],
      ['POST', `${PREFIX}/media/import`, JSON.stringify({ path: tempRoot })],
      ['POST', `${PREFIX}/media/upload?name=x.mp4`, Buffer.from('bytes')],
      ['POST', `${PREFIX}/project/save`, undefined],
      ['POST', `${PREFIX}/undo`, undefined],
      ['POST', `${PREFIX}/redo`, undefined],
    ]) {
      const response = await host.request(method, url, { body });
      assert.equal(response.status, 409, `${url}: ${response.text}`);
      assert.equal(response.json.error.code, 'no-project');
    }

    // Unknown routes and method mismatches answer JSON 404 (no 405 mapping).
    const unknown = await host.request('GET', `${PREFIX}/does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'not-found');
    const wrongMethod = await host.request('POST', `${PREFIX}/state`, { body: '{}' });
    assert.equal(wrongMethod.status, 404);
    assert.equal(wrongMethod.json.error.code, 'not-found');

    // A tool call without a project rejects with the same code.
    await assert.rejects(
      () => callTool(host, 'opentake_studio_get_state'),
      (error) => error.code === 'no-project',
    );
  });
});

test('creates, saves, opens and rejects projects (new/open/save/exists/not-found/invalid)', async () => {
  await withHost(async (host) => {
    const projectRoot = await createProjectOn(host, 'lifecycle', {
      name: 'First Project',
      fps: 24,
      width: 1280,
      height: 720,
    }).then((created) => created.root);

    const createdState = (await host.request('GET', `${PREFIX}/state`)).json;
    assert.equal(createdState.project.name, 'First Project');
    assert.equal(createdState.project.fps, 24);
    assert.equal(createdState.project.width, 1280);
    assert.equal(createdState.project.height, 720);
    assert.equal(createdState.project.tracks.length, 0);
    assert.equal(createdState.project.media.length, 0);
    assert.equal(createdState.projectRoot, projectRoot);
    for (const directory of ['media', 'thumbnails', 'exports']) {
      await access(path.join(projectRoot, directory));
    }
    const projectFile = path.join(projectRoot, 'opentake-studio.json');
    assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).name, 'First Project');

    // Creating again in the same folder is refused without overwriting.
    const duplicate = await host.request('POST', `${PREFIX}/project/new`, {
      body: JSON.stringify({ path: projectRoot, name: 'Second' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, 'project-exists');
    assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).name, 'First Project');

    // Save is explicit and idempotent.
    const saved = await host.request('POST', `${PREFIX}/project/save`);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.saveError, null);

    // Open another project, then switch back to the first one.
    const otherRoot = await createProjectOn(host, 'other').then((created) => created.root);
    assert.equal((await host.request('GET', `${PREFIX}/state`)).json.projectRoot, otherRoot);
    const reopened = await openProjectOn(host, projectRoot);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.project.name, 'First Project');
    assert.equal(reopened.json.canUndo, false);

    // Missing project folder -> 404 project-not-found.
    const missing = await openProjectOn(host, path.join(tempRoot, 'missing-project-dir'));
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'project-not-found');

    // Relative paths and malformed project files are rejected.
    const relative = await host.request('POST', `${PREFIX}/project/new`, {
      body: JSON.stringify({ path: 'relative/path' }),
    });
    assert.equal(relative.status, 400);
    assert.equal(relative.json.error.code, 'invalid-input');

    const brokenRoot = nextProjectDir('broken');
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(path.join(brokenRoot, 'opentake-studio.json'), '{not json', 'utf8');
    const broken = await openProjectOn(host, brokenRoot);
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, 'invalid-project');

    // The tool path shares the same service.
    const toolState = await callTool(host, 'opentake_studio_get_state');
    assert.equal(typeof toolState.text, 'string');
    assert.equal(toolState.data.name, 'First Project');
    assert.equal(toolState.data.fps, 24);
  });
});

test('maps model failures and malformed requests to stable HTTP codes', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'errors');
    const manual = await addManualMedia(host, root, { id: 'error-media' });

    const addClip = await edit(host, [
      { type: 'add-clip', mediaId: manual.media.id, startFrame: 0 },
    ]);
    assert.equal(addClip.status, 200, addClip.text);
    const clipId = allClips(addClip.json)[0].id;

    // Empty/invalid bodies.
    const empty = await host.request('POST', `${PREFIX}/edit`, {
      body: JSON.stringify({ operations: [] }),
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'invalid-input');
    const badJson = await host.request('POST', `${PREFIX}/edit`, { body: '{oops' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'invalid-input');
    const unknownMedia = await edit(host, [
      { type: 'add-clip', mediaId: 'not-a-media', startFrame: 0 },
    ]);
    assert.equal(unknownMedia.status, 400);
    assert.equal(unknownMedia.json.error.code, 'invalid-input');

    // Host pre-validated split frame -> 400 invalid-input.
    const toolSplit = await assert.rejects(
      () => callTool(host, 'opentake_studio_split_clip', { clipId, atFrame: 0 }),
      (error) => error.code === 'invalid-input',
    );
    void toolSplit;

    // Model errors are reported as 400 while keeping the model's stable code.
    const trimOutOfBounds = await edit(host, [
      { type: 'trim-clip', clipId, durationFrames: 99_999 },
    ]);
    assert.equal(trimOutOfBounds.status, 400);
    assert.equal(trimOutOfBounds.json.error.code, 'out-of-bounds');

    // Model `invalid-input` does map to 400.
    const nonIntegerMove = await edit(host, [
      { type: 'move-clip', clipId, startFrame: 1.5 },
    ]);
    assert.equal(nonIntegerMove.status, 400);
    assert.equal(nonIntegerMove.json.error.code, 'invalid-input');

    // Splitting through the raw /edit route is not pre-validated, but the
    // model's `invalid-split` code is a ModelError and maps to 400.
    const rawBadSplit = await edit(host, [
      { type: 'split-clip', clipId, atFrame: 0 },
    ]);
    assert.equal(rawBadSplit.status, 400);
    assert.equal(rawBadSplit.json.error.code, 'invalid-split');
  });
});

/* ------------------------------------------------------------------------- */
/* Media import                                                              */
/* ------------------------------------------------------------------------- */

test('imports generated media, dedupes re-imports and reports skipped files', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    const { root, state, byName } = await projectWithFixtures(host, 'import');
    assert.equal(state.project.media.length, 4, 'video + silent video + audio + image');
    assert.equal(state.project.tracks.length, 0, 'import only fills the library');

    assert.deepEqual(
      [...byName.keys()].sort(),
      ['card.png', 'clip.mp4', 'silent.mp4', 'sound.m4a'],
    );
    assert.equal(byName.get('clip.mp4').kind, 'video');
    assert.equal(byName.get('clip.mp4').hasAudio, true);
    assert.equal(byName.get('clip.mp4').durationFrames, 60);
    assert.equal(byName.get('silent.mp4').hasAudio, false);
    assert.equal(byName.get('sound.m4a').kind, 'audio');
    assert.equal(byName.get('sound.m4a').width, null);
    assert.equal(byName.get('card.png').kind, 'image');
    assert.equal(byName.get('card.png').durationFrames, null);

    const importedResponse = await host.request('POST', `${PREFIX}/media/import`, {
      body: JSON.stringify({ path: fixtureDir }),
    });
    assert.equal(importedResponse.json.imported.length, 0);
    assert.equal(importedResponse.json.skipped.length, 5, '4 duplicates + notes.txt');

    for (const media of byName.values()) {
      const destination = path.join(root, 'media', media.fileName);
      await access(destination);
      assert.equal((await stat(destination)).size, media.sizeBytes);
    }

    // Tool wrapper reports the same service result.
    const secondRoot = await createProjectOn(host, 'import-tool').then((created) => created.root);
    void secondRoot;
    const toolResult = await callTool(host, 'opentake_studio_import_media', { path: fixtureDir });
    assert.match(toolResult.text, /Imported 4 file\(s\)/);
    assert.equal(toolResult.data.imported.length, 4);

    // Invalid inputs: relative path -> 400; missing absolute folder -> io-error.
    const relative = await host.request('POST', `${PREFIX}/media/import`, {
      body: JSON.stringify({ path: 'fixtures' }),
    });
    assert.equal(relative.status, 400);
    assert.equal(relative.json.error.code, 'invalid-input');
    const missing = await host.request('POST', `${PREFIX}/media/import`, {
      body: JSON.stringify({ path: path.join(tempRoot, 'no-such-media-folder') }),
    });
    assert.equal(missing.status, 500, 'MediaError io-error is not mapped to 400');
    assert.equal(missing.json.error.code, 'io-error');
  });
});

/* ------------------------------------------------------------------------- */
/* Timeline edits and native tools                                           */
/* ------------------------------------------------------------------------- */

test('add-clip creates compatible tracks and clamps durations to the source', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'add-clip');
    const video = await addManualMedia(host, root, { id: 'video-media', fileName: 'clip.mp4' });

    const first = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 0 },
    ]);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.project.tracks.length, 1);
    const videoTrack = first.json.project.tracks[0];
    assert.equal(videoTrack.type, 'video');
    assert.equal(videoTrack.name, 'Video');
    assert.equal(videoTrack.clips.length, 1);
    assert.equal(videoTrack.clips[0].durationFrames, 60, 'default duration is the remaining source');

    // A second clip on the same track, with a duration clamp.
    const clamped = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 120, durationFrames: 99_999 },
    ]);
    assert.equal(clamped.status, 200, clamped.text);
    const clampedClip = allClips(clamped.json).find((clip) => clip.startFrame === 120);
    assert.equal(clampedClip.durationFrames, 60, 'duration is clamped to the media length');

    // A trim start past the source resets to 0 rather than failing (documented
    // in review-findings.md as a host-normalization quirk).
    const resetTrim = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 240, trimStartFrame: 500 },
    ]);
    assert.equal(resetTrim.status, 200, resetTrim.text);
    const resetClip = allClips(resetTrim.json).find((clip) => clip.startFrame === 240);
    assert.equal(resetClip.trimStartFrame, 0);
    assert.equal(resetClip.durationFrames, 60);

    // The audio media kind lands on its own audio track. Media added in one
    // request are visible to a later add-clip (host normalization reads state).
    const audioMedia = await edit(host, [
      {
        type: 'add-media',
        media: {
          id: 'audio-media',
          name: 'sound.m4a',
          kind: 'audio',
          fileName: 'sound.m4a',
          durationFrames: 60,
          sourceDurationSeconds: 2,
          width: null,
          height: null,
          hasAudio: true,
          sizeBytes: 10,
          importedAt: Date.now(),
        },
      },
    ]);
    assert.equal(audioMedia.status, 200, audioMedia.text);
    const audio = await edit(host, [
      { type: 'add-clip', mediaId: 'audio-media', startFrame: 0 },
    ]);
    assert.equal(audio.status, 200, audio.text);
    const audioTrack = audio.json.project.tracks.find((track) => track.type === 'audio');
    assert.ok(audioTrack, 'audio clip creates an audio track');
    assert.equal(audioTrack.name, 'Audio');
    assert.equal(audioTrack.clips[0].type, 'audio');

    // Image clips default to 150 project frames on the host (fps-independent).
    const imageMedia = await edit(host, [
      {
        type: 'add-media',
        media: {
          id: 'image-media',
          name: 'card.png',
          kind: 'image',
          fileName: 'card.png',
          durationFrames: null,
          sourceDurationSeconds: null,
          width: 320,
          height: 180,
          hasAudio: false,
          sizeBytes: 10,
          importedAt: Date.now(),
        },
      },
    ]);
    assert.equal(imageMedia.status, 200, imageMedia.text);
    const image = await edit(host, [
      { type: 'add-clip', mediaId: 'image-media', startFrame: 400 },
    ]);
    assert.equal(image.status, 200, image.text);
    const imageClip = allClips(image.json).find((clip) => clip.startFrame === 400);
    assert.equal(imageClip.type, 'image');
    assert.equal(imageClip.durationFrames, 150);

    // Tool wrapper returns the new ids and the shared summary.
    const viaTool = await callTool(host, 'opentake_studio_add_clip', {
      mediaId: video.media.id,
      startFrame: 600,
    });
    assert.equal(typeof viaTool.data.clipId, 'string');
    assert.equal(typeof viaTool.data.trackId, 'string');
    assert.match(viaTool.text, /Added clip/);
    assert.equal(
      clipById((await host.request('GET', `${PREFIX}/state`)).json, viaTool.data.clipId).startFrame,
      600,
    );
  });
});

test('add-text uses a dedicated Text track and never splits the video clip', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'text');
    const video = await addManualMedia(host, root, { id: 'text-video' });
    const base = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 0, durationFrames: 60 },
    ]);
    const videoTrack = base.json.project.tracks[0];
    const videoClip = videoTrack.clips[0];

    // First text: no explicit track, same interval as the video clip.
    const first = await edit(host, [
      {
        type: 'add-text',
        content: 'Hello Studio',
        startFrame: 0,
        durationFrames: 30,
        text: { content: 'Hello Studio', fontSize: 64, color: '#ff0000' },
      },
    ]);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.project.tracks.length, 2, 'text gets its own track');

    const stillVideoTrack = trackById(first.json, videoTrack.id);
    assert.equal(stillVideoTrack.clips.length, 1, 'the video clip must not be split');
    assert.equal(stillVideoTrack.clips[0].id, videoClip.id);
    assert.equal(stillVideoTrack.clips[0].durationFrames, 60);

    const textTrack = first.json.project.tracks.find(
      (track) => track.id !== videoTrack.id && track.name === 'Text',
    );
    assert.ok(textTrack, 'a video track named Text is created');
    assert.equal(textTrack.type, 'video');
    const textClip = textTrack.clips[0];
    assert.equal(textClip.type, 'text');
    assert.equal(textClip.mediaId, null);
    assert.equal(textClip.startFrame, 0);
    assert.equal(textClip.durationFrames, 30);
    assert.equal(textClip.text.content, 'Hello Studio');
    assert.equal(textClip.text.fontSize, 64);
    assert.equal(textClip.text.color, '#ff0000');
    assert.deepEqual(textClip.transform, { x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 0 });

    // A non-overlapping text reuses the same Text track.
    const reused = await edit(host, [
      { type: 'add-text', content: 'Later', startFrame: 40, durationFrames: 20 },
    ]);
    assert.equal(reused.status, 200, reused.text);
    assert.equal(reused.json.project.tracks.length, 2);
    assert.equal(
      trackById(reused.json, textTrack.id).clips.length,
      2,
      'free interval on the Text track is reused',
    );

    // Overlapping text needs another Text track.
    const overlapping = await edit(host, [
      { type: 'add-text', content: 'Overlap', startFrame: 0, durationFrames: 10 },
    ]);
    assert.equal(overlapping.status, 200, overlapping.text);
    assert.equal(overlapping.json.project.tracks.length, 3);
    assert.equal(
      overlapping.json.project.tracks.filter((track) => track.name === 'Text').length,
      2,
    );

    // Tool wrapper sets fontSize/color/transform through the same service.
    const tool = await callTool(host, 'opentake_studio_add_text', {
      content: 'Tool overlay',
      startFrame: 100,
      durationFrames: 30,
      fontSize: 40,
      color: '#00ff00',
      x: 0.2,
      y: 0.3,
    });
    assert.equal(typeof tool.data.clipId, 'string');
    const toolClip = clipById((await host.request('GET', `${PREFIX}/state`)).json, tool.data.clipId);
    assert.equal(toolClip.text.content, 'Tool overlay');
    assert.equal(toolClip.text.fontSize, 40);
    assert.equal(toolClip.text.color, '#00ff00');
    assert.equal(toolClip.transform.x, 0.2);
    assert.equal(toolClip.transform.y, 0.3);

    // An explicit trackId places the text on that video track and applies the
    // normal overwrite rule (the covered video clip is replaced).
    const explicit = await edit(host, [
      {
        type: 'add-text',
        content: 'Explicit track',
        startFrame: 0,
        durationFrames: 60,
        trackId: videoTrack.id,
      },
    ]);
    assert.equal(explicit.status, 200, explicit.text);
    const explicitTrack = trackById(explicit.json, videoTrack.id);
    assert.equal(explicitTrack.clips.length, 1);
    assert.equal(explicitTrack.clips[0].type, 'text');
    assert.equal(explicitTrack.clips[0].text.content, 'Explicit track');
  });
});

test('split, undo and redo round-trip through routes and tools while auto-saving', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'history');
    const video = await addManualMedia(host, root, { id: 'history-media' });
    const base = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 0, durationFrames: 60 },
    ]);
    const clipId = allClips(base.json)[0].id;

    const split = await callTool(host, 'opentake_studio_split_clip', {
      clipId,
      atFrame: 30,
    });
    assert.equal(typeof split.data.leftClipId, 'string');
    assert.equal(typeof split.data.rightClipId, 'string');
    let state = (await host.request('GET', `${PREFIX}/state`)).json;
    let clips = allClips(state);
    assert.equal(clips.length, 2);
    assert.deepEqual(
      clips.map((clip) => [clip.startFrame, clip.durationFrames]).sort((a, b) => a[0] - b[0]),
      [[0, 30], [30, 30]],
    );
    assert.equal(state.canUndo, true);

    const projectFile = path.join(root, 'opentake-studio.json');
    let saved = JSON.parse(await readFile(projectFile, 'utf8'));
    assert.equal(saved.tracks[0].clips.length, 2, 'edits save immediately');

    await callTool(host, 'opentake_studio_undo');
    state = (await host.request('GET', `${PREFIX}/state`)).json;
    assert.equal(allClips(state).length, 1);
    assert.equal(allClips(state)[0].durationFrames, 60);
    assert.equal(state.canRedo, true);
    assert.ok(
      await waitFor(async () => {
        const current = JSON.parse(await readFile(projectFile, 'utf8').catch(() => '{}'));
        return current?.tracks?.[0]?.clips?.length === 1;
      }),
      'undo persists through the debounced save',
    );

    await callTool(host, 'opentake_studio_redo');
    state = (await host.request('GET', `${PREFIX}/state`)).json;
    assert.equal(allClips(state).length, 2);

    // Route-level undo/redo use the same history; a new edit clears redo.
    const undoRoute = await host.request('POST', `${PREFIX}/undo`);
    assert.equal(undoRoute.status, 200);
    assert.equal(allClips(undoRoute.json).length, 1);
    const extra = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 200 },
    ]);
    assert.equal(extra.json.canRedo, false, 'a new edit clears the redo stack');

    // Empty history is an invalid-input 400 on a fresh project.
    await createProjectOn(host, 'history-empty');
    const nothingToUndo = await host.request('POST', `${PREFIX}/undo`);
    assert.equal(nothingToUndo.status, 400);
    assert.equal(nothingToUndo.json.error.code, 'invalid-input');
    const nothingToRedo = await host.request('POST', `${PREFIX}/redo`);
    assert.equal(nothingToRedo.status, 400);
    assert.equal(nothingToRedo.json.error.code, 'invalid-input');
  });
});

test('remove-clips and set-clip-properties share one undoable service', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'properties');
    const video = await addManualMedia(host, root, { id: 'props-media' });
    const base = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 0, durationFrames: 60 },
    ]);
    const clipId = allClips(base.json)[0].id;

    const updated = await callTool(host, 'opentake_studio_set_clip_properties', {
      clipIds: [clipId],
      volume: 0.5,
      opacity: 0.75,
      transform: { x: 0.25, y: 0.1 },
    });
    assert.match(updated.text, /Updated 1 clip/);
    const clip = clipById((await host.request('GET', `${PREFIX}/state`)).json, clipId);
    assert.equal(clip.volume, 0.5);
    assert.equal(clip.opacity, 0.75);
    assert.equal(clip.transform.x, 0.25);
    assert.equal(clip.transform.y, 0.1);
    assert.equal(clip.transform.width, 1, 'a partial transform keeps the other fields');

    const invalidVolume = await edit(host, [
      { type: 'set-clip-properties', clipIds: [clipId], volume: 2 },
    ]);
    assert.equal(invalidVolume.status, 400);
    assert.equal(invalidVolume.json.error.code, 'invalid-input');

    const viaRoute = await edit(host, [
      { type: 'set-clip-properties', clipIds: [clipId], opacity: 0.2 },
    ]);
    assert.equal(viaRoute.status, 200);
    assert.equal(allClips(viaRoute.json)[0].opacity, 0.2);

    const removed = await callTool(host, 'opentake_studio_remove_clips', { clipIds: [clipId] });
    assert.match(removed.text, /Removed 1 clip/);
    assert.equal(allClips((await host.request('GET', `${PREFIX}/state`)).json).length, 0);
    await callTool(host, 'opentake_studio_undo');
    assert.equal(allClips((await host.request('GET', `${PREFIX}/state`)).json).length, 1);

    await assert.rejects(
      () => callTool(host, 'opentake_studio_remove_clips', { clipIds: [] }),
      (error) => error.code === 'invalid-input',
    );
    const moveToMissingTrack = await edit(host, [
      { type: 'move-clip', clipId, startFrame: 0, trackId: 'missing-track' },
    ]);
    assert.equal(moveToMissingTrack.status, 400, 'model errors map to 400');
    assert.equal(moveToMissingTrack.json.error.code, 'track-not-found');
  });
});

/* ------------------------------------------------------------------------- */
/* Byte serving: Range, HEAD, traversal                                      */
/* ------------------------------------------------------------------------- */

test('serves media bytes with byte ranges, HEAD and 416 handling', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'range');
    const content = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'); // 36 bytes
    const { media } = await addManualMedia(host, root, {
      id: 'range-media',
      fileName: 'range.mp4',
      content,
    });
    const url = `${PREFIX}/media/file/${media.id}`;

    const full = await host.request('GET', url);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'video/mp4');
    assert.equal(full.headers['content-length'], String(content.byteLength));
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['cache-control'], 'no-store');
    assert.deepEqual(full.bytes, content);

    const firstBytes = await host.request('GET', url, { headers: { range: 'bytes=0-9' } });
    assert.equal(firstBytes.status, 206);
    assert.equal(firstBytes.headers['content-range'], `bytes 0-9/${content.byteLength}`);
    assert.equal(firstBytes.headers['content-length'], '10');
    assert.equal(firstBytes.bytes.toString('utf8'), '0123456789');

    const suffix = await host.request('GET', url, { headers: { range: 'bytes=-10' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], `bytes 26-35/${content.byteLength}`);
    assert.equal(suffix.bytes.toString('utf8'), 'qrstuvwxyz');

    const openEnded = await host.request('GET', url, { headers: { range: 'bytes=30-' } });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers['content-range'], `bytes 30-35/${content.byteLength}`);
    assert.equal(openEnded.bytes.toString('utf8'), 'uvwxyz');

    const clamped = await host.request('GET', url, { headers: { range: 'bytes=5-999' } });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers['content-range'], `bytes 5-35/${content.byteLength}`);
    assert.equal(clamped.bytes.byteLength, 31);

    const suffixTooLarge = await host.request('GET', url, { headers: { range: 'bytes=-999' } });
    assert.equal(suffixTooLarge.status, 206);
    assert.equal(suffixTooLarge.headers['content-range'], `bytes 0-35/${content.byteLength}`);

    const single = await host.request('GET', url, { headers: { range: 'bytes=0-0' } });
    assert.equal(single.status, 206);
    assert.equal(single.headers['content-range'], `bytes 0-0/${content.byteLength}`);
    assert.deepEqual(single.bytes, Buffer.from('0'));

    for (const range of ['bytes=abc', 'bytes=36-40', 'bytes=5-4', 'bytes=-0', 'bytes=0-1,3-4']) {
      const invalid = await host.request('GET', url, { headers: { range } });
      assert.equal(invalid.status, 416, `range ${range}`);
      assert.equal(invalid.headers['content-range'], `bytes */${content.byteLength}`);
      assert.equal(invalid.bytes.length, 0);
    }

    // A non-bytes unit is ignored (full 200), matching RFC 9110 optional ranges.
    const ignoredUnit = await host.request('GET', url, { headers: { range: 'items=0-1' } });
    assert.equal(ignoredUnit.status, 200);
    assert.deepEqual(ignoredUnit.bytes, content);

    const head = await host.request('HEAD', url);
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(content.byteLength));
    assert.equal(head.headers['accept-ranges'], 'bytes');
    assert.equal(head.bytes.length, 0);

    const headRange = await host.request('HEAD', url, { headers: { range: 'bytes=0-9' } });
    assert.equal(headRange.status, 206);
    assert.equal(headRange.headers['content-range'], `bytes 0-9/${content.byteLength}`);
    assert.equal(headRange.headers['content-length'], '10');
    assert.equal(headRange.bytes.length, 0);

    const missing = await host.request('GET', `${PREFIX}/media/file/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'media-not-found');

    // A malicious project entry cannot read outside <root>/media.
    const escapeRoot = nextProjectDir('traversal');
    await mkdir(escapeRoot, { recursive: true });
    await writeFile(
      path.join(escapeRoot, 'opentake-studio.json'),
      JSON.stringify({
        version: 1,
        name: 'escape',
        fps: 30,
        width: 320,
        height: 180,
        createdAt: 1,
        updatedAt: 1,
        media: [
          {
            id: 'escape-media',
            name: 'escape.mp4',
            kind: 'video',
            fileName: '../escape.mp4',
            durationFrames: 60,
            sourceDurationSeconds: 2,
            width: 320,
            height: 180,
            hasAudio: false,
            sizeBytes: 10,
            importedAt: 1,
          },
        ],
        tracks: [],
      }),
      'utf8',
    );
    const opened = await openProjectOn(host, escapeRoot);
    assert.equal(opened.status, 200, opened.text);
    const escapedRead = await host.request('GET', `${PREFIX}/media/file/escape-media`);
    assert.equal(escapedRead.status, 400);
    assert.equal(escapedRead.json.error.code, 'media-error');
    assert.match(escapedRead.json.error.message, /escapes the project media directory/);

    // Malformed percent-encoding is a client error.
    const malformed = await host.request('GET', `${PREFIX}/media/file/%E0%A4%A`);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, 'invalid-input');
  });
});

test('serves JPEG thumbnails and caches them', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    const { state, byName, root } = await projectWithFixtures(host, 'thumbnails');
    const video = byName.get('clip.mp4');

    const thumb = await host.request('GET', `${PREFIX}/media/thumb/${video.id}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
    assert.ok(thumb.bytes.length > 100);
    assert.equal(thumb.bytes[0], 0xff);
    assert.equal(thumb.bytes[1], 0xd8);
    const cachedPath = path.join(root, 'thumbnails', `${video.id}.jpg`);
    assert.deepEqual(thumb.bytes, await readFile(cachedPath));

    const again = await host.request('GET', `${PREFIX}/media/thumb/${video.id}`);
    assert.deepEqual(again.bytes, thumb.bytes);

    const image = byName.get('card.png');
    const imageThumb = await host.request('GET', `${PREFIX}/media/thumb/${image.id}`);
    assert.equal(imageThumb.status, 200);
    assert.equal(imageThumb.bytes[0], 0xff);

    const audio = byName.get('sound.m4a');
    const audioThumb = await host.request('GET', `${PREFIX}/media/thumb/${audio.id}`);
    assert.equal(audioThumb.status, 200, 'audio gets a placeholder card');
    assert.equal(audioThumb.bytes[0], 0xff);

    const missing = await host.request('GET', `${PREFIX}/media/thumb/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'media-not-found');
    assert.ok(state.project.media.length >= 4);
  });
});

/* ------------------------------------------------------------------------- */
/* Uploads                                                                   */
/* ------------------------------------------------------------------------- */

test('uploads raw bytes into the project media folder', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'upload');
    const bytes = await readFile(fixtureFiles.video);

    const upload = await host.request(
      'POST',
      `${PREFIX}/media/upload?name=${encodeURIComponent('my clip.mp4')}`,
      { body: bytes, headers: { 'content-type': 'application/octet-stream' } },
    );
    assert.equal(upload.status, 200, upload.text);
    const media = upload.json.project.media.at(-1);
    assert.equal(media.kind, 'video');
    assert.equal(media.name, 'my clip.mp4');
    assert.match(media.fileName, /^[0-9a-f-]{36}-my clip\.mp4$/);
    assert.equal(media.sizeBytes, bytes.byteLength);
    const stored = path.join(root, 'media', media.fileName);
    assert.deepEqual(await readFile(stored), bytes);

    // Path components in the name are reduced to a basename.
    const traversal = await host.request(
      'POST',
      `${PREFIX}/media/upload?name=${encodeURIComponent('../escape.mp4')}`,
      { body: bytes },
    );
    assert.equal(traversal.status, 200, traversal.text);
    assert.equal(traversal.json.project.media.at(-1).name, 'escape.mp4');

    const missingName = await host.request('POST', `${PREFIX}/media/upload`, { body: bytes });
    assert.equal(missingName.status, 400);
    assert.equal(missingName.json.error.code, 'invalid-input');
  });

  // A failed probe leaves the written file behind (orphan) — recorded in
  // review-findings.md; this test pins the current behavior.
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'upload-orphan');
    const upload = await host.request('POST', `${PREFIX}/media/upload?name=notes.bin`, {
      body: Buffer.from('this is not a media file'),
    });
    assert.equal(upload.status, 400);
    assert.equal(upload.json.error.code, 'media-error');
    const entries = await readdir(path.join(root, 'media'));
    assert.equal(entries.length, 1, 'the rejected upload file is not cleaned up');
    assert.match(entries[0], /-notes\.bin$/);
  });
});

/* ------------------------------------------------------------------------- */
/* Browser-rendered text assets                                              */
/* ------------------------------------------------------------------------- */

test('stores browser-rendered text PNGs and rejects malformed renders', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'text-render');
    const withText = await edit(host, [
      { type: 'add-text', content: 'Render me', startFrame: 0, durationFrames: 30 },
    ]);
    const textClip = allClips(withText.json).find((clip) => clip.type === 'text');
    const dataUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;

    const ok = await host.request('POST', `${PREFIX}/text/render`, {
      body: JSON.stringify({ clipId: textClip.id, dataUrl }),
    });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json, { ok: true });
    const rendered = path.join(root, 'renders', `${textClip.id}.png`);
    assert.deepEqual(await readFile(rendered), TINY_PNG);

    for (const [body, status, code] of [
      [{ clipId: textClip.id, dataUrl: 'data:image/jpeg;base64,AAAA' }, 400, 'invalid-input'],
      [{ clipId: textClip.id, dataUrl: 'not-a-data-url' }, 400, 'invalid-input'],
      [{ dataUrl }, 400, 'invalid-input'],
      [{ clipId: 'unknown-clip', dataUrl }, 400, 'invalid-input'],
      [{ clipId: 'not-a-text-clip', dataUrl }, 400, 'invalid-input'],
    ]) {
      const response = await host.request('POST', `${PREFIX}/text/render`, {
        body: JSON.stringify(body),
      });
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.json.error.code, code);
    }

    // A decoded image over 8 MiB is refused (413), under the 16 MiB body cap.
    const oversize = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 3).toString('base64')}`;
    const tooLarge = await host.request('POST', `${PREFIX}/text/render`, {
      body: JSON.stringify({ clipId: textClip.id, dataUrl: oversize }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.json.error.code, 'invalid-input');

    // A clip id from a crafted project file cannot traverse out of renders/:
    // the route validates the id as a safe file identifier before writing.
    const escapeRoot = nextProjectDir('render-traversal');
    await mkdir(escapeRoot, { recursive: true });
    await writeFile(
      path.join(escapeRoot, 'opentake-studio.json'),
      JSON.stringify({
        version: 1,
        name: 'render escape',
        fps: 30,
        width: 320,
        height: 180,
        createdAt: 1,
        updatedAt: 1,
        media: [],
        tracks: [
          {
            id: 'text-track',
            type: 'video',
            name: 'Text',
            muted: false,
            hidden: false,
            clips: [
              {
                id: '../escaped-text',
                type: 'text',
                mediaId: null,
                startFrame: 0,
                durationFrames: 30,
                trimStartFrame: 0,
                speed: 1,
                volume: 1,
                opacity: 1,
                transform: { x: 0.1, y: 0.1, width: 0.8, height: 0.2, rotation: 0 },
                text: { content: 'escape', fontSize: 48, color: '#ffffff', fontWeight: '600', align: 'center' },
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    assert.equal((await openProjectOn(host, escapeRoot)).status, 200);
    const escaped = await host.request('POST', `${PREFIX}/text/render`, {
      body: JSON.stringify({ clipId: '../escaped-text', dataUrl }),
    });
    assert.equal(escaped.status, 400, escaped.text);
    assert.equal(escaped.json.error.code, 'invalid-input');
    assert.match(escaped.json.error.message, /safe file identifier/);
    assert.equal(existsSync(path.join(escapeRoot, 'escaped-text.png')), false);
    assert.equal(existsSync(path.join(escapeRoot, 'renders', 'escaped-text.png')), false);
  });
});

/* ------------------------------------------------------------------------- */
/* Export                                                                    */
/* ------------------------------------------------------------------------- */

test('exports a video-only project to MP4 and verifies it with ffprobe', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    const project = await projectWithFixtures(host, 'export', { width: 320, height: 180 });
    const silent = project.byName.get('silent.mp4');
    const edited = await edit(host, [
      { type: 'add-clip', mediaId: silent.id, startFrame: 0, durationFrames: 60 },
    ]);
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.project.tracks.length, 1);
    assert.equal(edited.json.project.tracks[0].type, 'video');

    const started = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(started.status, 200, started.text);
    assert.ok(['running', 'done'].includes(started.json.export.state));
    const output = started.json.export.output;
    assert.ok(output.startsWith(path.join(project.root, 'exports') + path.sep), output);
    assert.match(output, /\.mp4$/);

    const finished = await waitForExport(host);
    assert.equal(finished.state, 'done', JSON.stringify(finished));
    assert.equal(finished.progress, 1);
    assert.equal(finished.output, output);
    const info = await stat(output);
    assert.ok(info.size > 1_000, `exported MP4 too small: ${info.size}`);

    const parsed = await probeStreams(output);
    const videoStream = parsed.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio');
    assert.ok(videoStream, 'export has a video stream');
    assert.equal(videoStream.codec_name, 'h264');
    assert.equal(videoStream.width, 320);
    assert.equal(videoStream.height, 180);
    assert.equal(audioStream, undefined, 'a silent video-only project exports no audio stream');
    assert.ok(Number(parsed.format.duration) > 1.5 && Number(parsed.format.duration) < 2.6);
  });
});

test('exports browser-rendered text overlays and honors explicit output paths', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    const project = await projectWithFixtures(host, 'export-text', { width: 320, height: 180 });
    const video = project.byName.get('silent.mp4');
    const edited = await edit(host, [
      { type: 'add-clip', mediaId: video.id, startFrame: 0, durationFrames: 30 },
      { type: 'add-text', content: 'Rendered overlay', startFrame: 0, durationFrames: 30 },
    ]);
    assert.equal(edited.status, 200, edited.text);
    const textClip = allClips(edited.json).find((clip) => clip.type === 'text');
    const dataUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
    const rendered = await host.request('POST', `${PREFIX}/text/render`, {
      body: JSON.stringify({ clipId: textClip.id, dataUrl }),
    });
    assert.equal(rendered.status, 200, rendered.text);
    await access(path.join(project.root, 'renders', `${textClip.id}.png`));

    const explicitOutput = path.join(tempRoot, 'explicit-export', 'movie.mp4');
    const started = await host.request('POST', `${PREFIX}/export`, {
      body: JSON.stringify({ path: explicitOutput }),
    });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.export.output, explicitOutput);

    const finished = await waitForExport(host);
    assert.equal(finished.state, 'done', JSON.stringify(finished));
    const info = await stat(explicitOutput);
    assert.ok(info.size > 1_000);
    const parsed = await probeStreams(explicitOutput);
    assert.ok(parsed.streams.some((stream) => stream.codec_type === 'video'));
    assert.equal(parsed.streams.some((stream) => stream.codec_type === 'audio'), false);
  });
});

test('reports export-running, cancels cleanly and surfaces async failures', { skip: FFPEG_SKIP }, async () => {
  await withHost(async (host) => {
    // A 10-second timeline keeps the encode running long enough to observe the
    // exclusive state and a cancellation.
    const project = await projectWithFixtures(host, 'export-state', { width: 320, height: 180 });
    const silent = project.byName.get('silent.mp4');
    const operations = [];
    for (let index = 0; index < 5; index += 1) {
      operations.push({
        type: 'add-clip',
        mediaId: silent.id,
        startFrame: index * 60,
        durationFrames: 60,
      });
    }
    const edited = await edit(host, operations);
    assert.equal(edited.status, 200, edited.text);

    const first = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(first.status, 200, first.text);
    const running = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(running.status, 409, running.text);
    assert.equal(running.json.error.code, 'export-running');

    const cancelled = await host.request('POST', `${PREFIX}/export/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.export.state, 'idle');
    await sleep(400);
    const afterCancel = (await host.request('GET', `${PREFIX}/export/status`)).json;
    assert.equal(afterCancel.export.state, 'idle', 'a cancelled export must not flip to done');
    const output = first.json.export.output;
    const removed = await waitFor(() => !existsSync(output), { timeoutMs: 5_000 });
    assert.ok(removed, 'cancelled export removes its partial output');

    // Starting a new export and switching projects mid-export leaves the export
    // bound to the old project snapshot; /state reports it under the new project.
    const oldProjectRoot = project.root;
    const secondStart = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(secondStart.status, 200, secondStart.text);
    const switchedRoot = await createProjectOn(host, 'export-switch').then((created) => created.root);
    const switchedState = (await host.request('GET', `${PREFIX}/export/status`)).json;
    assert.equal(switchedState.projectRoot, switchedRoot);
    // Switching projects cancels the export bound to the old project.
    assert.equal(switchedState.export.state, 'idle', JSON.stringify(switchedState.export));
    const settled = await waitForExport(host);
    assert.equal(settled.state, 'idle', JSON.stringify(settled));
    void oldProjectRoot;

    // Async export error: the media file referenced by the clip is missing.
    const brokenRoot = nextProjectDir('export-broken');
    const broken = await createProjectOn(host, 'export-broken', { root: brokenRoot });
    void broken;
    const missingMedia = {
      id: 'missing-media',
      name: 'missing.mp4',
      kind: 'video',
      fileName: 'missing.mp4',
      durationFrames: 60,
      sourceDurationSeconds: 2,
      width: 320,
      height: 180,
      hasAudio: false,
      sizeBytes: 10,
      importedAt: Date.now(),
    };
    const addMedia = await edit(host, [{ type: 'add-media', media: missingMedia }]);
    assert.equal(addMedia.status, 200, addMedia.text);
    const prepare = await edit(host, [
      { type: 'add-clip', mediaId: 'missing-media', startFrame: 0, durationFrames: 30 },
    ]);
    assert.equal(prepare.status, 200, prepare.text);
    const failing = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(failing.status, 200, failing.text);
    const failed = await waitForExport(host);
    assert.equal(failed.state, 'error', JSON.stringify(failed));
    assert.match(failed.error, /Export failed|No such file|Invalid data/i);
    assert.equal(failed.output, failing.json.export.output);

    // Empty timeline is rejected synchronously.
    await createProjectOn(host, 'export-empty');
    const empty = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'invalid-input');
  });
});

/* ------------------------------------------------------------------------- */
/* Persistence failures                                                      */
/* ------------------------------------------------------------------------- */

test('surfaces save failures in state without losing in-memory edits', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return; // root ignores directory permissions
  }
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'save-failure');
    const video = await addManualMedia(host, root, { id: 'save-media' });
    const base = await edit(host, [
      { type: 'add-clip', mediaId: video.media.id, startFrame: 0, durationFrames: 60 },
    ]);
    const firstClipId = allClips(base.json)[0].id;

    await chmod(root, 0o555);
    try {
      const editWhileReadOnly = await edit(host, [
        { type: 'split-clip', clipId: firstClipId, atFrame: 30 },
      ]);
      assert.equal(editWhileReadOnly.status, 200, editWhileReadOnly.text);
      assert.ok(editWhileReadOnly.json.saveError, 'save failure is reported in state');
      assert.match(editWhileReadOnly.json.saveError, /EACCES|permission|not permitted|denied/i);
      assert.equal(allClips(editWhileReadOnly.json).length, 2, 'the in-memory edit still applied');

      const saveRoute = await host.request('POST', `${PREFIX}/project/save`);
      assert.equal(saveRoute.status, 200);
      assert.match(saveRoute.json.saveError, /EACCES|permission|not permitted|denied/i);
    } finally {
      await chmod(root, 0o755);
    }

    const saved = await host.request('POST', `${PREFIX}/project/save`);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.saveError, null);
    const onDisk = JSON.parse(await readFile(path.join(root, 'opentake-studio.json'), 'utf8'));
    assert.equal(onDisk.tracks[0].clips.length, 2);
  });
});

/* ------------------------------------------------------------------------- */
/* Limits, batch semantics, disposal and fail-closed guard                   */
/* ------------------------------------------------------------------------- */

test('fails closed when the host cannot provide the browser request fence', async () => {
  const host = createHost({ connectionGuard: false });
  try {
    for (const [method, url] of [
      ['GET', `${PREFIX}/state`],
      ['POST', `${PREFIX}/edit`],
      ['GET', `${PREFIX}/media/file/manual-media`],
    ]) {
      const response = await host.request(method, url, {
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(response.status, 503, `${method} ${url} must fail closed`);
      assert.equal(response.bytes.length, 0);
    }
  } finally {
    host.dispose();
  }
});

test('enforces the JSON body cap and documents same-batch media semantics', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'limits');

    // POST bodies are capped at 1 MiB before parsing.
    const huge = JSON.stringify({ operations: [], padding: 'x'.repeat(1024 * 1024 + 32) });
    assert.ok(Buffer.byteLength(huge) > 1024 * 1024);
    const tooLarge = await host.request('POST', `${PREFIX}/edit`, { body: huge });
    assert.equal(tooLarge.status, 413, tooLarge.text);
    assert.equal(tooLarge.json.error.code, 'invalid-input');

    // Media added with `add-media` in the same request are visible to a later
    // add-clip in that batch: normalization tracks batch-created media.
    const batch = await edit(host, [
      {
        type: 'add-media',
        media: {
          id: 'batch-media',
          name: 'batch.mp4',
          kind: 'video',
          fileName: 'batch.mp4',
          durationFrames: 60,
          sourceDurationSeconds: 2,
          width: 320,
          height: 180,
          hasAudio: false,
          sizeBytes: 10,
          importedAt: Date.now(),
        },
      },
      { type: 'add-clip', mediaId: 'batch-media', startFrame: 0 },
    ]);
    assert.equal(batch.status, 200, batch.text);
    assert.equal(batch.json.project.media.at(-1).id, 'batch-media');
    assert.equal(allClips(batch.json).length, 1);

    // Unsupported project settings are ModelErrors and map to 400.
    const badFps = await host.request('POST', `${PREFIX}/project/new`, {
      body: JSON.stringify({ path: nextProjectDir('bad-fps'), fps: 29.97 }),
    });
    assert.equal(badFps.status, 400, badFps.text);
    assert.equal(badFps.json.error.code, 'unsupported-fps');

    // An image clip default is 5 seconds at the project fps.
    const fps24 = await createProjectOn(host, 'fps-24', { fps: 24 });
    void fps24;
    const imageMedia = await edit(host, [
      {
        type: 'add-media',
        media: {
          id: 'fps24-image',
          name: 'still.png',
          kind: 'image',
          fileName: 'still.png',
          durationFrames: null,
          sourceDurationSeconds: null,
          width: 320,
          height: 180,
          hasAudio: false,
          sizeBytes: 10,
          importedAt: Date.now(),
        },
      },
    ]);
    assert.equal(imageMedia.status, 200, imageMedia.text);
    const placed = await edit(host, [
      { type: 'add-clip', mediaId: 'fps24-image', startFrame: 0 },
    ]);
    assert.equal(placed.status, 200, placed.text);
    assert.equal(allClips(placed.json)[0].durationFrames, 120);
  });
});

test('disposal unregisters every native tool', async () => {
  const host = createHost();
  assert.equal(host.tools.size, EXPECTED_TOOLS.length);
  host.dispose();
  assert.equal(host.tools.size, 0);
  assert.doesNotThrow(() => host.dispose());
});

/* ------------------------------------------------------------------------- */
/* Tool / ffmpeg availability mapping                                        */
/* ------------------------------------------------------------------------- */

test('maps a missing ffmpeg to a 503 ffmpeg-unavailable state and tool error', async () => {
  const saved = {
    PATH: process.env.PATH,
    OPENTAKE_STUDIO_FFMPEG: process.env.OPENTAKE_STUDIO_FFMPEG,
    OPENTAKE_STUDIO_FFPROBE: process.env.OPENTAKE_STUDIO_FFPROBE,
  };
  try {
    await withHost(async (host) => {
      const { root } = await createProjectOn(host, 'no-ffmpeg');
      const video = await addManualMedia(host, root, { id: 'no-ffmpeg-media' });
      const edited = await edit(host, [
        { type: 'add-clip', mediaId: video.media.id, startFrame: 0, durationFrames: 30 },
      ]);
      assert.equal(edited.status, 200, edited.text);

      process.env.PATH = '';
      process.env.OPENTAKE_STUDIO_FFMPEG = '/definitely/not/a/real/ffmpeg';
      process.env.OPENTAKE_STUDIO_FFPROBE = '/definitely/not/a/real/ffprobe';
      resetToolCache();

      const state = (await host.request('GET', `${PREFIX}/state`)).json;
      assert.equal(state.ffmpeg.available, false);
      assert.equal(state.ffmpeg.ffmpeg, null);

      const exportRoute = await host.request('POST', `${PREFIX}/export`, { body: '{}' });
      assert.equal(exportRoute.status, 503, exportRoute.text);
      assert.equal(exportRoute.json.error.code, 'ffmpeg-unavailable');

      await assert.rejects(
        () => callTool(host, 'opentake_studio_export', {}),
        (error) => error.code === 'ffmpeg-unavailable',
      );
    });
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = saved.PATH;
    if (saved.OPENTAKE_STUDIO_FFMPEG === undefined) delete process.env.OPENTAKE_STUDIO_FFMPEG;
    else process.env.OPENTAKE_STUDIO_FFMPEG = saved.OPENTAKE_STUDIO_FFMPEG;
    if (saved.OPENTAKE_STUDIO_FFPROBE === undefined) delete process.env.OPENTAKE_STUDIO_FFPROBE;
    else process.env.OPENTAKE_STUDIO_FFPROBE = saved.OPENTAKE_STUDIO_FFPROBE;
    resetToolCache();
  }
});

test('Phase 1 edit operations, captions and text renders are wired end to end', async () => {
  await withHost(async (host) => {
    const { root } = await createProjectOn(host, 'phase1');
    const media = {
      id: 'phase-media',
      name: 'phase.mp4',
      kind: 'video',
      fileName: 'phase.mp4',
      durationFrames: 60,
      sourceDurationSeconds: 2,
      width: 320,
      height: 180,
      hasAudio: true,
      sizeBytes: 10,
      importedAt: Date.now(),
    };
    const batch = await edit(host, [
      { type: 'add-track', trackId: 'phase-track', trackType: 'video', name: 'Video' },
      { type: 'add-media', media },
      { type: 'add-clip', clipId: 'phase-a', mediaId: media.id, trackId: 'phase-track', startFrame: 0, durationFrames: 60 },
      { type: 'add-clip', clipId: 'phase-b', mediaId: media.id, trackId: 'phase-track', startFrame: 60, durationFrames: 60 },
      { type: 'set-speed', clipId: 'phase-b', speed: 2 },
      { type: 'set-fades', clipId: 'phase-a', fadeInFrames: 5, fadeOutFrames: 5 },
      {
        type: 'set-keyframes',
        clipId: 'phase-a',
        property: 'volume',
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 60, value: 1, easing: 'ease-in' },
        ],
      },
      {
        type: 'add-effect',
        clipId: 'phase-a',
        effect: { type: 'brightness', params: { amount: 1.2 } },
      },
      { type: 'add-marker', marker: { frame: 30, label: 'Beat', color: '#ffcc00' } },
      {
        type: 'add-transition',
        transition: {
          trackId: 'phase-track',
          fromClipId: 'phase-a',
          toClipId: 'phase-b',
          type: 'fadeToBlack',
          durationFrames: 10,
        },
      },
      {
        type: 'add-caption',
        startFrame: 0,
        durationFrames: 60,
        segments: [
          { startFrame: 0, durationFrames: 30, text: 'Hello' },
          { startFrame: 30, durationFrames: 30, text: 'World' },
        ],
        style: { fontSize: 36, color: '#ffff00' },
      },
    ]);
    assert.equal(batch.status, 200, batch.text);
    assert.equal(batch.json.project.markers.length, 1);
    assert.equal(batch.json.project.transitions.length, 1);
    const clips = allClips(batch.json);
    const first = clips.find((clip) => clip.id === 'phase-a');
    assert.equal(first.speed, 1);
    assert.equal(first.fadeInFrames, 5);
    assert.equal(first.effects.length, 1);
    assert.equal(first.keyframes.volume.length, 2);
    const second = clips.find((clip) => clip.id === 'phase-b');
    assert.equal(second.speed, 2);
    const caption = clips.find((clip) => clip.type === 'caption');
    assert.ok(caption, 'caption clip should exist');
    assert.equal(caption.caption.segments.length, 2);
    assert.equal(caption.caption.style.fontSize, 36);
    assert.equal(caption.transform.y, 0.78);
    assert.equal(caption.trackName, 'Captions');

    const imported = await host.request('POST', `${PREFIX}/captions/import`, {
      body: JSON.stringify({
        text: '1\n00:00:01,000 --> 00:00:02,000\nImported\n',
        style: { fontSize: 28 },
      }),
    });
    assert.equal(imported.status, 200, imported.text);
    assert.ok(allClips(imported.json).some((clip) => clip.type === 'caption'));

    const exportedSrt = await host.request('GET', `${PREFIX}/captions/export.srt`);
    assert.equal(exportedSrt.status, 200, exportedSrt.text);
    assert.match(exportedSrt.text, /Hello/);
    assert.match(exportedSrt.text, /Imported/);
    const exportedVtt = await host.request('GET', `${PREFIX}/captions/export.vtt`);
    assert.equal(exportedVtt.status, 200, exportedVtt.text);
    assert.match(exportedVtt.text, /^WEBVTT/);

    // Browser-side caption segment PNGs are stored next to text renders.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ).toString('base64');
    const rendered = await host.request('POST', `${PREFIX}/text/render`, {
      body: JSON.stringify({ clipId: caption.id, segmentIndex: 0, dataUrl: `data:image/png;base64,${png}` }),
    });
    assert.equal(rendered.status, 200, rendered.text);
    assert.ok(existsSync(path.join(root, 'renders', `${caption.id}-seg-0.png`)));

    const editTool = await callTool(host, 'opentake_studio_edit', {
      operations: [{ type: 'add-marker', marker: { frame: 12, label: 'Tool' } }],
    });
    assert.match(editTool.text, /Tool/);
    const captionsTool = await callTool(host, 'opentake_studio_export_captions', { format: 'vtt' });
    assert.match(captionsTool.text, /^WEBVTT/);
  });
});
