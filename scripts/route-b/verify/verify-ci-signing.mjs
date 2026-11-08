#!/usr/bin/env node
/**
 * Route B CI / signing claim verifier.
 *
 * Separates what can be checked on this Mac from what needs external runners or
 * credentials:
 *   - workflow YAML + pinned action SHAs + script syntax (static, local);
 *   - wgpu platform readiness (source features, local);
 *   - macOS signing dry-run (SKIP without Apple secrets) and local identities;
 *   - Windows Authenticode script presence (PowerShell is not installed here);
 *   - local platform build preflights (expected exit 78 without SDKs);
 *   - actual CI runs, Windows/Linux builds and signing are NOT claimed.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-ci-signing.mjs [--json]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/route-b-platform.yml');
const args = { json: process.argv.includes('--json') };

const checks = [];
function check(name, fn, statusOnError = 'FAIL') {
  try {
    checks.push({ name, status: 'PASS', detail: fn() });
  } catch (error) {
    checks.push({ name, status: statusOnError, detail: error.message });
  }
}

check('CI workflow file exists', () => {
  if (!fs.existsSync(WORKFLOW)) throw new Error('missing .github/workflows/route-b-platform.yml');
  return path.relative(ROOT, WORKFLOW);
});

const workflow = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';
check('workflow defines macOS arm64/x64/universal, Windows x64, Linux x64 jobs', () => {
  for (const needle of ['name: macOS arm64', 'macOS x64 (runtime)', 'macOS universal package', 'name: Windows x64', 'name: Linux x64']) {
    if (!workflow.includes(needle)) throw new Error(`missing job marker: ${needle}`);
  }
  return '5 platform jobs present';
});
check('signing is opt-in and conditional on repository secrets', () => {
  if (!/APPLE_CERTIFICATE_P12_BASE64:\s*\$\{\{\s*secrets\./.test(workflow)) throw new Error('Apple certificate secret not wired');
  if (!/github\.event_name == 'workflow_dispatch'.*inputs\.sign == true/.test(workflow)) throw new Error('signing is not gated on workflow_dispatch + sign input');
  if (!/WINDOWS_CERTIFICATE|signtool/i.test(workflow + fs.readFileSync(path.join(ROOT, 'scripts/route-b/platform/sign-windows.ps1'), 'utf8'))) throw new Error('no Windows signing material found');
  return 'Apple secrets wired; signing gated on workflow_dispatch sign=true';
});
check('workflow YAML, pinned actions and platform scripts validate', () => {
  const out = spawnSync('bash', [path.join(ROOT, 'scripts/route-b/platform/validate-workflows.sh')], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stdout + out.stderr);
  return out.stdout.trim().split('\n').slice(-2).join(' | ');
});
check('wgpu platform features are declared for all CI platforms', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts/route-b/platform/check-wgpu-features.mjs')], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stdout + out.stderr);
  return out.stdout.trim().split('\n').filter((line) => /macos|windows|linux/.test(line)).join('; ');
});
check('local platform build preflights still block without SDKs (honest)', () => {
  const results = {};
  for (const name of ['build-linux.sh', 'build-windows.sh']) {
    const out = spawnSync('bash', [path.join(ROOT, 'scripts/route-b/platform', name)], { encoding: 'utf8' });
    results[name] = { exit: out.status, blocked: /BLOCKED/.test(out.stdout) };
    if (out.status !== 78) throw new Error(`${name} exited ${out.status}, expected 78`);
  }
  return JSON.stringify(results);
});
check('macOS signing dry-run skips without Apple credentials', () => {
  const out = spawnSync('bash', [path.join(ROOT, 'scripts/route-b/platform/sign-macos.sh')], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stdout + out.stderr);
  if (!/SKIP/.test(out.stdout)) throw new Error(out.stdout);
  return out.stdout.trim().split('\n').find((line) => /SKIP/.test(line)) ?? 'SKIP';
});
check('has no local codesigning identity (signing not executed here)', () => {
  const out = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identities = (out.stdout.match(/\d+ valid identities found/) ?? [''])[0];
  if (!/0 valid identities/.test(out.stdout)) throw new Error(`unexpected identities: ${identities}`);
  return identities;
});
check('Windows Authenticode script cannot be executed on this host', () => {
  if (!fs.existsSync(path.join(ROOT, 'scripts/route-b/platform/sign-windows.ps1'))) throw new Error('sign-windows.ps1 missing');
  const pwsh = spawnSync('bash', ['-lc', 'command -v pwsh'], { encoding: 'utf8' });
  if (pwsh.status === 0) return `pwsh present at ${pwsh.stdout.trim()} — script not executed to avoid requiring a certificate`;
  throw new Error('pwsh is not installed; Windows signing remains unexecuted (Unknown)');
}, 'WARN');

const pending = [
  'GitHub Actions run of route-b-platform.yml (needs repository/CI)',
  'Windows x64 and Linux x64 native builds (needs Windows/Linux runners + SDKs; local preflights exit 78)',
  'Apple Developer ID signing/notarization (0 identities, no notary credentials)',
  'Windows Authenticode signing (PowerShell + certificate absent)',
  'x64 runtime smoke (no Rosetta on this host)',
];
const result = { checks, pending, failed: checks.some((entry) => entry.status === 'FAIL') };
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  for (const entry of checks) console.log(`${entry.status} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  console.log('pending external resources:'); for (const item of pending) console.log(`  - ${item}`);
}
process.exit(result.failed ? 1 : 0);
