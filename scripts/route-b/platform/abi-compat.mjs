#!/usr/bin/env node
/**
 * Check the N-API ABI contract between the current Node/DSH Host runtime and a
 * Route B addon.
 *
 * Verifies the host N-API level against the addon's `napi8` build, inspects the
 * addon container/architecture, confirms the N-API module-registration symbol,
 * and — only when the addon matches the host platform/arch — loads it and
 * exercises the minimal Engine contract.
 *
 * Cross-architecture addons (for example darwin-x64 on a darwin-arm64 host)
 * are reported as SKIP/WARN, not as failures: they cannot be loaded without an
 * emulator and that is expected for a universal package.
 *
 * Usage:
 *   node scripts/route-b/platform/abi-compat.mjs [--addon <path>] [--min-napi 8]
 *       [--json]
 *
 * With no --addon it resolves plugins/opentake-studio-route-b/native/<platform>-<arch>/*.node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { NATIVE_TARGETS, REPO_ROOT, humanBytes, readBinaryInfo } from './lib.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const jsonOnly = flag('--json');
const noLoad = flag('--no-load');
const minNapi = Number(option('--min-napi') ?? 8);

function defaultAddon(pluginDir = path.join(REPO_ROOT, 'plugins/opentake-studio-route-b')) {
  const dir = path.join(pluginDir, 'native', `${process.platform}-${process.arch}`);
  if (!fs.existsSync(dir)) return null;
  const binaries = fs.readdirSync(dir).filter((name) => name.endsWith('.node'));
  return binaries.length > 0 ? path.join(dir, binaries[0]) : null;
}

const addonPath = path.resolve(option('--addon') ?? defaultAddon() ?? '');
if (!addonPath || !fs.existsSync(addonPath)) {
  console.error(`abi-compat: addon not found (${addonPath || 'no default native/<platform>-<arch>/*.node'})`);
  process.exit(2);
}

const checks = [];
const record = (name, status, detail) => {
  checks.push({ name, status, detail });
  if (!jsonOnly) console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const host = {
  node: process.versions.node,
  napi: Number(process.versions.napi),
  platform: process.platform,
  arch: process.arch,
};
const info = readBinaryInfo(addonPath);
const hostDir = `${host.platform}-${host.arch}`;
const expected = NATIVE_TARGETS[hostDir] ?? null;

if (host.napi >= minNapi) record('host N-API', 'PASS', `N-API ${host.napi} >= ${minNapi}`);
else record('host N-API', 'FAIL', `N-API ${host.napi} < required ${minNapi}`);
record('addon binary', 'INFO', `${path.basename(addonPath)} · ${info.format}/${info.arch} · ${humanBytes(info.size)} · sha256 ${info.sha256.slice(0, 16)}…`);

const architectureMatches = expected
  ? info.format === expected.format && info.arch === expected.arch
  : info.arch === host.arch;
if (architectureMatches) record('addon architecture', 'PASS', `${info.format}/${info.arch} matches ${hostDir}`);
else if (expected === null) record('addon architecture', 'WARN', `unknown host directory ${hostDir}; cannot confirm`);
else record('addon architecture', 'SKIP', `addon is ${info.format}/${info.arch}; host is ${expected.format}/${expected.arch} (load skipped)`);

// Scan the binary bytes directly instead of spawning `strings` on a large
// addon (the v38 binary is ~43 MiB and its strings stream can exhaust Node).
const registration = fs.readFileSync(addonPath).includes(Buffer.from('napi_register_module_v1'));
if (registration) record('N-API registration symbol', 'PASS', 'napi_register_module_v1 present');
else record('N-API registration symbol', 'FAIL', 'napi_register_module_v1 not found');

if (info.installName) record('install name', 'INFO', info.installName);

let loaded = false;
if (noLoad) {
  record('Engine contract', 'SKIP', 'skipped by --no-load (verify-package.mjs covers the load check)');
} else if (architectureMatches) {
  try {
    const addon = require(addonPath);
    if (typeof addon.Engine !== 'function') throw new Error('module does not export Engine');
    const engine = new addon.Engine();
    const created = JSON.parse(engine.newProject());
    if (created?.timeline?.tracks?.length !== 0) throw new Error('newProject is not empty');
    const applied = JSON.parse(engine.apply(JSON.stringify({ type: 'setTimelineSettings', fps: 24, width: 1280, height: 720 })));
    if (applied?.result?.changed !== true) throw new Error('apply(setTimelineSettings) did not change');
    const undone = JSON.parse(engine.undo());
    if (undone?.timeline?.fps !== 30) throw new Error('undo did not restore fps=30');
    const snapshot = JSON.parse(engine.getTimeline());
    if (!Array.isArray(snapshot?.timeline?.tracks)) throw new Error('getTimeline missing tracks');
    loaded = true;
    record('Engine contract', 'PASS', 'newProject/apply/undo/getTimeline OK');
  } catch (error) {
    record('Engine contract', 'FAIL', error instanceof Error ? error.message : String(error));
  }
} else {
  record('Engine contract', 'SKIP', 'not loadable on this host (cross-architecture)');
}

const summary = {
  host,
  addonPath,
  addon: { format: info.format, arch: info.arch, bytes: info.size, sha256: info.sha256 },
  loaded,
  minNapi,
  checks,
  ok: !checks.some((check) => check.status === 'FAIL'),
};
if (jsonOnly) console.log(JSON.stringify(summary, null, 2));
else console.log(`\nabi-compat: ${summary.ok ? 'OK' : 'FAILED'}`);
process.exit(summary.ok ? 0 : 1);
