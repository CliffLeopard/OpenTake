#!/usr/bin/env node
/**
 * Check whether `opentake-render` enables the wgpu backend features required
 * for each Route B build platform.
 *
 * The target-specific change in `crates/opentake-render/Cargo.toml` is owned by
 * media-dev (it was applied on 2026-11-08 while the render crate was being
 * edited for HDR10). This script is the CI preflight and the documentation
 * source of truth for the applied form:
 *
 *   [dependencies]
 *   wgpu = { ..., features = ["wgsl"] }
 *   [target.'cfg(target_os = "macos")'.dependencies]
 *   wgpu = { ..., features = ["wgsl", "metal"] }
 *   [target.'cfg(target_os = "windows")'.dependencies]
 *   wgpu = { ..., features = ["wgsl", "dx12"] }
 *   [target.'cfg(any(target_os = "linux", target_os = "android"))'.dependencies]
 *   wgpu = { ..., features = ["wgsl", "vulkan-portability", "angle"] }
 *
 * wgpu 23 names its Linux backends `vulkan-portability` (Vulkan) and `angle`
 * (the wgpu-core `gles` feature); both are required. Older/alternative names
 * (`vulkan`, `gles`) are accepted as aliases so a small future rename does not
 * break the preflight.
 *
 * Usage:
 *   node scripts/route-b/platform/check-wgpu-features.mjs [--platform macos|windows|linux]
 *       [--cargo <path>] [--json] [--github-output] [--strict]
 *
 * `--github-output` writes `<platform>_ready=<true|false>` and `pending=<csv>`
 * to $GITHUB_OUTPUT and exits 0 (CI preflight); otherwise the exit code is 1
 * when a required backend is missing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const jsonOnly = flag('--json');
const githubOutput = flag('--github-output');
const onlyPlatform = option('--platform');
const cargoToml = option('--cargo')
  ? path.resolve(option('--cargo'))
  : path.join(REPO_ROOT, 'crates/opentake-render/Cargo.toml');

/** Required backend feature groups per platform; any alias in a group satisfies it. */
const REQUIRED = {
  macos: { groups: [['metal']], label: 'Metal' },
  windows: { groups: [['dx12']], label: 'DX12' },
  linux: {
    groups: [
      ['vulkan-portability', 'vulkan'],
      ['angle', 'gles'],
    ],
    label: 'Vulkan (vulkan-portability) + GLES (angle)',
  },
};
const PLATFORMS = ['macos', 'windows', 'linux'];

function parseFeatures(line) {
  const match = /features\s*=\s*\[([^\]]*)\]/.exec(line);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function platformsInSection(section) {
  const found = [];
  for (const match of section.matchAll(/target_os\s*=\s*(?:"|')(macos|windows|linux|android)(?:"|')/g)) {
    found.push(match[1]);
  }
  return [...new Set(found)];
}

function readWgpuConfig() {
  const text = fs.readFileSync(cargoToml, 'utf8');
  const base = { features: [] };
  const targets = Object.fromEntries(PLATFORMS.map((platform) => [platform, []]));
  let section = null;
  let sectionPlatforms = [];
  for (const rawLine of text.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(rawLine);
    if (header) {
      section = header[1].trim();
      const targetLike = /^target\./.test(section) && /\.dependencies$/.test(section);
      sectionPlatforms = targetLike ? platformsInSection(section) : [];
      continue;
    }
    if (!/^\s*wgpu\s*=\s*\{/.test(rawLine)) continue;
    if (section === 'dependencies') {
      base.features = parseFeatures(rawLine);
    } else if (sectionPlatforms.length > 0) {
      for (const platform of sectionPlatforms) {
        if (PLATFORMS.includes(platform)) targets[platform].push(...parseFeatures(rawLine));
      }
    }
  }
  return { base, targets };
}

const config = readWgpuConfig();
const platforms = onlyPlatform ? [onlyPlatform] : PLATFORMS;
for (const platform of platforms) {
  if (!REQUIRED[platform]) {
    console.error(`check-wgpu-features: unknown platform ${platform} (expected ${PLATFORMS.join('|')})`);
    process.exit(2);
  }
}

const results = {};
for (const platform of platforms) {
  const enabled = new Set([...config.base.features, ...(config.targets[platform] ?? [])]);
  const missingGroups = REQUIRED[platform].groups.filter((aliases) => !aliases.some((alias) => enabled.has(alias)));
  results[platform] = {
    ready: missingGroups.length === 0,
    required: REQUIRED[platform].label,
    enabled: [...enabled].sort(),
    missing: missingGroups.map((aliases) => aliases.join('|')),
  };
}

const pending = platforms.filter((platform) => !results[platform].ready);
const allReady = pending.length === 0;

function appliedFormExample() {
  return [
    'Applied form (media-dev owns this file; do not edit here):',
    '',
    '  [target.\'cfg(target_os = "macos")\'.dependencies]',
    '  wgpu = { version = "23", default-features = false, features = ["wgsl", "metal"] }',
    '  [target.\'cfg(target_os = "windows")\'.dependencies]',
    '  wgpu = { version = "23", default-features = false, features = ["wgsl", "dx12"] }',
    '  [target.\'cfg(any(target_os = "linux", target_os = "android"))\'.dependencies]',
    '  wgpu = { version = "23", default-features = false, features = ["wgsl", "vulkan-portability", "angle"] }',
  ].join('\n');
}

if (jsonOnly) {
  console.log(
    JSON.stringify(
      {
        cargoToml: path.relative(REPO_ROOT, cargoToml),
        baseFeatures: config.base.features,
        targetFeatures: config.targets,
        results,
        pending,
        allReady,
        appliedFormExample: allReady ? null : appliedFormExample(),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`check-wgpu-features — ${path.relative(REPO_ROOT, cargoToml)}`);
  console.log(`  base wgpu features: ${config.base.features.join(', ') || '(none)'}`);
  for (const platform of platforms) {
    const result = results[platform];
    const status = result.ready ? 'READY' : 'PENDING';
    let detail = result.enabled.join(', ') || '(none)';
    if (result.missing.length > 0) detail += ` — missing: ${result.missing.join(', ')}`;
    console.log(`  ${platform.padEnd(7)} ${status.padEnd(8)} ${detail}`);
  }
  if (!allReady) {
    console.log('');
    console.log('PENDING COORDINATION: the platform backend features above are missing.');
    console.log('media-dev owns the render-crate change; see the applied-form example.');
  }
  console.log(`\ncheck-wgpu-features: ${allReady ? 'OK' : `pending (${pending.join(', ')})`}`);
}

if (githubOutput) {
  const lines = PLATFORMS.map((platform) => `${platform}_ready=${results[platform]?.ready === true}`);
  lines.push(`pending=${pending.join(',')}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
  process.exit(0);
}

process.exit(allReady ? 0 : 1);
