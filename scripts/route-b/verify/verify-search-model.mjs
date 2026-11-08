#!/usr/bin/env node
/**
 * Independent SigLIP2 model verification for Route B.
 *
 * - Reads the pinned manifest from the Rust sources and from the workstream
 *   manifest helper, and requires them to agree (no trusting one copy).
 * - Hashes every expected file itself; file size alone is never proof.
 * - Accepts the canonical installed layout
 *     <dir>/image_encoder.onnx, text_encoder.onnx, tokenizer/tokenizer.json,
 *     manifest.json, spec.json
 *   and reports the raw download layout separately (onnx/vision_model.onnx,
 *   onnx/text_model.onnx, tokenizer/tokenizer.json).
 *
 * Exit codes: 0 = canonical install complete and every hash matches;
 *             2 = incomplete/not installed (partial downloads are NOT installed);
 *             1 = a file has the pinned size but a different SHA-256 (corrupt).
 *
 * Usage:
 *   node scripts/route-b/verify/verify-search-model.mjs [--models-dir DIR] [--json]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_DIR = path.join(os.homedir(), '.dsh', 'opentake', 'models', 'siglip2-base-patch16-256-v2');

function parseArgs(argv) {
  const args = { dir: DEFAULT_DIR, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--models-dir') args.dir = path.resolve(argv[++index]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: verify-search-model.mjs [--models-dir DIR] [--json]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Pin list from the Rust source (`ModelFile` consts). */
function pinsFromRust() {
  const source = fs.readFileSync(path.join(ROOT, 'crates/opentake-media/src/search/config.rs'), 'utf8');
  const pattern = /name:\s*"([^"]+)"[\s\S]*?sha256:\s*"([0-9a-f]{64})"[\s\S]*?bytes:\s*([0-9_]+)/g;
  const pins = [];
  for (const match of source.matchAll(pattern)) {
    pins.push({ name: match[1], sha256: match[2], bytes: Number(match[3].replaceAll('_', '')) });
  }
  if (pins.length !== 3) throw new Error(`expected 3 pinned files in config.rs, got ${pins.length}`);
  return pins;
}

// Pin `name` values are download names (e.g. `onnx/vision_model.onnx`); the
// canonical install renames them to the desktop layout.
function installedPathFor(pin) {
  if (/vision/i.test(pin.name)) return 'image_encoder.onnx';
  if (/text_model/i.test(pin.name)) return 'text_encoder.onnx';
  return 'tokenizer/tokenizer.json';
}

// Raw download layout used by the approved downloader: encoder graphs keep their
// `onnx/...` download names; the tokenizer lands under tokenizer/.
function rawPathFor(pin) {
  if (/tokenizer/i.test(pin.name)) return 'tokenizer/tokenizer.json';
  return pin.name;
}

function inspectFile(dir, relativePath, pin) {
  const absolute = path.join(dir, relativePath);
  if (!fs.existsSync(absolute)) return { path: relativePath, present: false, expectedBytes: pin.bytes, sizeOk: false, sha256Ok: null };
  const actualBytes = fs.statSync(absolute).size;
  const sizeOk = actualBytes === pin.bytes;
  const sha256 = sha256File(absolute);
  return { path: relativePath, present: true, actualBytes, expectedBytes: pin.bytes, sizeOk, sha256, expectedSha256: pin.sha256, sha256Ok: sha256 === pin.sha256 };
}

function receipts(dir) {
  const out = {};
  for (const name of ['manifest.json', 'spec.json']) {
    const file = path.join(dir, name);
    out[name] = fs.existsSync(file) ? { present: true, parse: (() => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; } })() } : { present: false };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const pins = pinsFromRust();
  const byName = Object.fromEntries(pins.map((pin) => [pin.name, pin]));

  // Cross-check the CLI workstream manifest against the Rust source pins.
  const helper = await import(pathToFileURL(path.join(ROOT, 'scripts/route-b/search/model-assets.mjs')).href);
  const helperPins = helper.MANIFEST.files.map((file) => ({ name: file.downloadName, sha256: file.sha256, bytes: file.bytes }));
  const pinKey = (list) => JSON.stringify(list.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })).sort((a, b) => a.name.localeCompare(b.name)));
  const pinsAgree = pinKey(pins) === pinKey(helperPins);
  if (!pinsAgree) throw new Error('Rust pins and scripts/route-b/search/model-assets.mjs pins disagree');

  const canonical = pins.map((pin) => inspectFile(args.dir, installedPathFor(pin), pin));
  const raw = pins.map((pin) => inspectFile(args.dir, rawPathFor(pin), pin));
  const canonicalComplete = canonical.every((file) => file.present && file.sizeOk && file.sha256Ok === true);
  const corrupt = canonical.some((file) => file.present && file.sizeOk && file.sha256Ok === false);
  const receiptState = receipts(args.dir);

  const result = {
    modelsDir: args.dir,
    pins: pins.map((pin) => ({ name: pin.name, bytes: pin.bytes, sha256: pin.sha256 })),
    pinsAgreeWithWorkstreamManifest: pinsAgree,
    canonical: {
      complete: canonicalComplete,
      files: canonical,
    },
    rawDownloadLayout: {
      files: raw.map((file) => ({ path: file.path, present: file.present, actualBytes: file.actualBytes ?? 0, expectedBytes: file.expectedBytes, sizeOk: file.sizeOk, sha256: file.sha256 ?? null, expectedSha256: file.expectedSha256, sha256Ok: file.sha256Ok })),
    },
    receipts: receiptState,
    status: canonicalComplete ? 'complete' : corrupt ? 'corrupt' : 'incomplete',
    elapsedMs: Date.now() - started,
  };

  // Host/addon capability is intentionally not inferred from files: the caller
  // must run searchConfigure/searchModelStatus against a complete install.
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`models dir: ${args.dir}`);
    console.log(`pins: Rust == workstream manifest: ${pinsAgree ? 'YES' : 'NO'}`);
    for (const [index, file] of canonical.entries()) {
      const rawFile = raw[index];
      const label = file.present ? `${file.actualBytes} B sha256 ${file.sha256.slice(0, 16)}…` : 'missing';
      const rawLabel = rawFile.present ? `raw ${rawFile.actualBytes}/${rawFile.expectedBytes} B` : 'raw missing';
      console.log(`  ${file.sha256Ok === true ? 'PASS' : file.sha256Ok === false ? 'FAIL' : 'MISS'} ${installedPathFor(pins[index])} — ${label}; ${rawLabel}`);
      if (file.present && !file.sizeOk) console.log(`       size mismatch: expected ${file.expectedBytes}`);
    }
    console.log(`receipts: manifest.json=${receiptState['manifest.json'].present} spec.json=${receiptState['spec.json'].present}`);
    console.log(`status: ${result.status}${corrupt ? ' (a pinned-size file has the wrong SHA-256)' : ''} (${result.elapsedMs} ms)`);
    if (!canonicalComplete) console.log('NOTE: raw/partial files do not count as installed; run scripts/route-b/search/install-model.mjs once sizes and hashes match.');
  }
  process.exit(canonicalComplete ? 0 : corrupt ? 1 : 2);
}

main().catch((error) => {
  console.error(`verify-search-model: ${error.message}`);
  process.exit(3);
});
