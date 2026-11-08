#!/usr/bin/env node
/**
 * Route B native UI verification.
 *
 * Verifies the shipped client entry, the DSH-native shell tests and the bounded
 * native-editor prototype harness. The live DSH Client mount cannot be observed
 * from this script (no CDP/slot access here); the report marks it Unknown unless
 * a browser/CDP probe is supplied separately.
 *
 * Usage:
 *   node scripts/route-b/verify/verify-native-ui.mjs [--chrome] [--json]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PLUGIN = path.join(ROOT, 'plugins/opentake-studio-route-b');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = { chrome: false, json: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--chrome') args.chrome = true;
  else if (arg === '--json') args.json = true;
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: verify-native-ui.mjs [--chrome] [--json]');
    process.exit(0);
  } else throw new Error(`unknown argument: ${arg}`);
}

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, status: 'PASS', detail });
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
const clientPath = path.join(PLUGIN, pkg.exports?.['./client'] ?? 'client.js');
const uiSource = fs.readFileSync(path.join(PLUGIN, 'ui/client.js'), 'utf8');
const nativeEditorDir = path.join(PLUGIN, 'native-editor');

check('client entry points at the DSH-native shell', () => {
  if (pkg.exports?.['./client'] !== './ui/client.js') throw new Error(`exports["./client"] = ${pkg.exports?.['./client']}`);
  if (!fs.existsSync(clientPath)) throw new Error(`missing ${clientPath}`);
  return pkg.exports['./client'];
});
check('package ships ui/** and lib modules', () => {
  for (const entry of ['ui/**', 'lib/motion-templates.js', 'lib/providers.js']) {
    if (!pkg.files?.includes(entry)) throw new Error(`files is missing ${entry}`);
  }
  return pkg.files.join(', ');
});
check('native shell registers main + sidebar slots and token-only CSS', () => {
  if (!/__ModuleLoader__/.test(uiSource)) throw new Error('not a DSH client module');
  if (!/name:\s*['"]main['"]/.test(uiSource) || !/sidebar\.panellist/.test(uiSource)) throw new Error('slot registration missing');
  if (!/--dsw-alias-/.test(uiSource)) throw new Error('no DSH theme alias token usage');
  if (!/iframe/.test(uiSource)) throw new Error('expected the iframe body fallback to remain in the native shell');
  return 'main + sidebar.panellist registered; iframe body fallback present';
});
check('native editor is wired as an optional preview with iframe fallback', () => {
  if (!fs.existsSync(path.join(nativeEditorDir, 'README.md'))) throw new Error('native-editor/README.md missing');
  const readme = fs.readFileSync(path.join(nativeEditorDir, 'README.md'), 'utf8');
  if (!/wired as an optional native preview/i.test(readme)) throw new Error('native-editor README no longer states the optional-preview integration');
  if (!/NATIVE_BUNDLE_URL/.test(uiSource) || !/native-editor\.js/.test(uiSource)) throw new Error('client shell does not reference the native bundle');
  if (!/data-otn-action/.test(uiSource) && !/toggle/i.test(uiSource)) throw new Error('client shell has no native/iframe toggle');
  const bundle = path.join(PLUGIN, 'web/native-editor/native-editor.js');
  if (!fs.existsSync(bundle) || fs.statSync(bundle).size < 100_000) throw new Error(`native bundle missing/too small: ${bundle}`);
  return `optional native preview wired; bundle ${fs.statSync(bundle).size} bytes; iframe remains default`;
});
check('package ships web/native-editor and search installer modules', () => {
  if (!pkg.files?.includes('web/native-editor/**')) throw new Error('files is missing web/native-editor/**');
  if (!pkg.files?.includes('lib/search/install-model.mjs')) throw new Error('files is missing lib/search/install-model.mjs');
  return pkg.files.join(', ');
});
check('DSH-native shell stub tests pass', () => {
  const out = spawnSync(process.execPath, ['--test', path.join(PLUGIN, 'test/ui-mount.test.mjs')], { encoding: 'utf8' });
  const pass = (out.stdout.match(/^ℹ pass (\d+)/m) ?? [])[1];
  const fail = (out.stdout.match(/^ℹ fail (\d+)/m) ?? [])[1];
  if (out.status !== 0 || Number(fail) !== 0) throw new Error(`ui-mount tests failed (status ${out.status})`);
  return `${pass} passed, 0 failed`;
});
check('native-editor prototype tests pass', () => {
  const out = spawnSync(process.execPath, ['--test', path.join(nativeEditorDir, 'test/native-editor.test.mjs')], { encoding: 'utf8' });
  const pass = (out.stdout.match(/^ℹ pass (\d+)/m) ?? [])[1];
  const fail = (out.stdout.match(/^ℹ fail (\d+)/m) ?? [])[1];
  if (out.status !== 0 || Number(fail) !== 0) throw new Error(`native-editor tests failed (status ${out.status})`);
  return `${pass} passed, 0 failed`;
});

let browser = null;
if (args.chrome && fs.existsSync(CHROME)) {
  try {
    const png = '/tmp/route-b-native-editor-verify.png';
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--allow-file-access-from-files', '--window-size=1280,800', '--virtual-time-budget=3000',
      `--screenshot=${png}`, `file://${path.join(nativeEditorDir, 'preview.html')}`,
    ], { stdio: 'ignore', timeout: 60000 });
    const bytes = fs.statSync(png).size;
    // A blank body is ~10 KiB; the mounted editor body is >40 KiB.
    if (bytes < 30000) throw new Error(`preview screenshot only ${bytes} bytes (mount likely failed)`);
    browser = { png, bytes, mounted: true };
    checks.push({ name: 'native-editor browser harness mounts in Chrome', status: 'PASS', detail: `${bytes} byte screenshot` });
  } catch (error) {
    browser = { mounted: false, error: error.message };
    checks.push({ name: 'native-editor browser harness mounts in Chrome', status: 'FAIL', detail: error.message });
  }
} else {
  checks.push({ name: 'native-editor browser harness', status: 'SKIP', detail: args.chrome ? 'Chrome not found' : 'pass --chrome to render preview.html' });
}

const failed = checks.some((entry) => entry.status === 'FAIL');
const result = {
  checks,
  browser,
  liveDshMount: 'Unknown — requires a DSH Client inspect/CDP probe; the shell still hosts the iframe body and the DSH Host module is loaded by the running app',
  failed,
};
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  for (const entry of checks) console.log(`${entry.status} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  console.log(`live DSH client mount: ${result.liveDshMount}`);
}
process.exit(failed ? 1 : 0);
