#!/usr/bin/env node
/**
 * Route B SigLIP2 staging/verification (NO download).
 *
 * The approved download lands raw Hugging Face files:
 *   <dir>/onnx/vision_model.onnx
 *   <dir>/onnx/text_model.onnx
 *   <dir>/tokenizer/tokenizer.json
 *
 * The desktop engine (and the Route B search addon) expects the canonical
 * install layout with a receipt:
 *   <dir>/image_encoder.onnx
 *   <dir>/text_encoder.onnx
 *   <dir>/tokenizer/tokenizer.json
 *   <dir>/manifest.json
 *   <dir>/spec.json
 *
 * This script waits for exact pinned sizes, verifies the pinned SHA-256 digests,
 * then renames (never copies) the raw encoders into the canonical layout and
 * writes the receipts. It never downloads anything.
 *
 * Usage:
 *   node scripts/route-b/search/install-model.mjs [--models-dir DIR] [--wait]
 *        [--timeout-seconds N] [--check-only] [--json]
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { MANIFEST, TOTAL_BYTES } from "./model-assets.mjs";

const REMOTE_BASE = MANIFEST.baseUrl;

export const DEFAULT_INSTALL_DIR = path.join(
  os.homedir(),
  ".dsh",
  "opentake",
  "models",
  `${MANIFEST.model}-v${MANIFEST.version}`,
);

const RAW_PATHS = {
  "onnx/vision_model.onnx": "onnx/vision_model.onnx",
  "onnx/text_model.onnx": "onnx/text_model.onnx",
  "tokenizer.json": "tokenizer/tokenizer.json",
};

/** Desktop `Manifest` receipt (download names, not installed names). */
export const MANIFEST_RECEIPT = {
  model: MANIFEST.model,
  version: MANIFEST.version,
  embeddingDim: MANIFEST.embeddingDim,
  imageSize: MANIFEST.imageSize,
  contextLength: MANIFEST.contextLength,
  imageEncoder: {
    name: MANIFEST.files[0].downloadName,
    sha256: MANIFEST.files[0].sha256,
    bytes: MANIFEST.files[0].bytes,
  },
  textEncoder: {
    name: MANIFEST.files[1].downloadName,
    sha256: MANIFEST.files[1].sha256,
    bytes: MANIFEST.files[1].bytes,
  },
  tokenizer: {
    name: MANIFEST.files[2].downloadName,
    sha256: MANIFEST.files[2].sha256,
    bytes: MANIFEST.files[2].bytes,
  },
};

export const SPEC_RECEIPT = {
  model: MANIFEST.model,
  version: MANIFEST.version,
  embeddingDim: MANIFEST.embeddingDim,
  imageSize: MANIFEST.imageSize,
  contextLength: MANIFEST.contextLength,
  normalized: false,
};

function sha256File(filePath) {
  const hash = createHash("sha256");
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function pendingSize(filePath) {
  return sizeOf(filePath) ?? 0;
}

function sizeOf(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

/** Resolve each pinned asset from canonical or raw layout with size state. */
export function locateAssets(installDir) {
  return MANIFEST.files.map((file) => {
    const canonical = path.join(installDir, file.installedPath);
    const raw = path.join(installDir, RAW_PATHS[file.downloadName]);
    const chosen = existsSync(canonical) ? { kind: "canonical", path: canonical } : existsSync(raw) ? { kind: "raw", path: raw } : { kind: "missing", path: raw };
    const bytes = sizeOf(chosen.path);
    return {
      downloadName: file.downloadName,
      installedPath: file.installedPath,
      expectedBytes: file.bytes,
      expectedSha256: file.sha256,
      source: chosen.kind,
      sourcePath: chosen.path,
      bytes,
      complete: bytes === file.bytes,
    };
  });
}

function receiptsMatch(installDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(installDir, "manifest.json"), "utf8"));
    const spec = JSON.parse(readFileSync(path.join(installDir, "spec.json"), "utf8"));
    return JSON.stringify(manifest) === JSON.stringify(MANIFEST_RECEIPT) && JSON.stringify(spec) === JSON.stringify(SPEC_RECEIPT);
  } catch {
    return false;
  }
}

async function waitForSizes(installDir, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const files = locateAssets(installDir);
    const missing = files.filter((file) => file.bytes === null);
    const complete = files.filter((file) => file.complete);
    if (complete.length === files.length) return files;
    if (Date.now() > deadline) {
      return files;
    }
    process.stderr.write(
      `waiting: ${complete.length}/${files.length} complete; missing=${missing
        .map((file) => file.installedPath)
        .join(",") || "none"}\n`,
    );
    await sleep(5000);
  }
}

async function downloadToPinnedUrl(remoteUrl, dest, expectedBytes, label) {
  let existing = sizeOf(dest) ?? 0;
  if (existing === expectedBytes) return;
  if (existing > expectedBytes) {
    rmSync(dest, { force: true });
    existing = 0;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
  const response = await fetch(remoteUrl, { headers, redirect: "follow" });
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`${label}: HTTP ${response.status} for ${remoteUrl}`);
  }
  const append = existing > 0 && response.status === 206;
  if (!append) existing = 0;
  const file = openSync(dest, append ? "a" : "w");
  let written = existing;
  let lastReport = Date.now();
  let lastBytes = written;
  try {
    if (!response.body) throw new Error(`${label}: empty body`);
    for await (const chunk of response.body) {
      writeSync(file, chunk);
      written += chunk.length;
      const now = Date.now();
      if (now - lastReport >= 5000) {
        const seconds = (now - lastReport) / 1000;
        const rate = (written - lastBytes) / seconds / (1024 * 1024);
        process.stderr.write(`${label}: ${(written / (1024 * 1024)).toFixed(1)}/${(expectedBytes / (1024 * 1024)).toFixed(1)} MB (${rate.toFixed(2)} MB/s)\n`);
        lastReport = now;
        lastBytes = written;
      }
      if (written > expectedBytes) throw new Error(`${label}: server sent more bytes than pinned (${written} > ${expectedBytes})`);
    }
  } finally {
    closeSync(file);
  }
  if (written !== expectedBytes) {
    throw new Error(`${label}: incomplete download (${written}/${expectedBytes})`);
  }
}

/** Download any missing/short pinned raw asset (user-approved URL installer). */
async function downloadMissingAssets(installDir, files) {
  for (const [index, file] of files.entries()) {
    const pinned = MANIFEST.files[index];
    if (file.complete) continue;
    const rawRelative = RAW_PATHS[pinned.downloadName];
    const dest = path.join(installDir, rawRelative);
    const remoteUrl = `${REMOTE_BASE}/${pinned.downloadName}`;
    process.stderr.write(`downloading ${pinned.downloadName} -> ${dest}\n`);
    await downloadToPinnedUrl(remoteUrl, dest, pinned.bytes, pinned.downloadName);
  }
}

/**
 * Verify + stage the pinned assets. Returns a JSON-safe report.
 * @param {string} installDir
 * @param {{wait?: boolean, timeoutSeconds?: number, checkOnly?: boolean, download?: boolean}} [options]
 */
export async function installModel(installDir = DEFAULT_INSTALL_DIR, options = {}) {
  const report = {
    modelsDir: installDir,
    expectedTotalBytes: TOTAL_BYTES,
    files: [],
    installed: false,
    staged: false,
    verified: false,
    error: null,
  };
  if (options.wait) {
    await waitForSizes(installDir, options.timeoutSeconds ?? 1800);
  }
  let files = locateAssets(installDir);
  if (options.download) {
    await downloadMissingAssets(installDir, files);
    files = locateAssets(installDir);
  }
  if (!files.every((file) => file.complete)) {
    report.files = files;
    report.error = `incomplete assets: ${files.filter((f) => !f.complete).map((f) => `${f.installedPath} ${f.bytes ?? 0}/${f.expectedBytes}`).join(", ")}`;
    return report;
  }
  if (options.checkOnly) {
    // Check-only must not read 1.5 GB unless the caller asks; sizes are enough
    // for a quick progress report.
    report.files = files;
    report.verified = false;
    return report;
  }
  let retriedDownload = false;
  for (const file of files) {
    let actual = await sha256File(file.sourcePath);
    if (actual !== file.expectedSha256 && options.download && !retriedDownload) {
      // Partial legacy downloads can be corrupt; re-fetch the offending file
      // from the pinned URL once, then re-verify.
      retriedDownload = true;
      rmSync(file.sourcePath, { force: true });
      const pinned = MANIFEST.files.find((entry) => entry.installedPath === file.installedPath);
      const rawRelative = RAW_PATHS[pinned.downloadName];
      const dest = path.join(installDir, rawRelative);
      await downloadToPinnedUrl(`${REMOTE_BASE}/${pinned.downloadName}`, dest, pinned.bytes, pinned.downloadName);
      file.sourcePath = dest;
      file.bytes = pendingSize(dest);
      actual = await sha256File(dest);
    }
    if (actual !== file.expectedSha256) {
      report.files = files.map((entry) => ({ ...entry, actualSha256: entry === file ? actual : undefined }));
      report.error = `checksum mismatch: ${file.installedPath} expected ${file.expectedSha256} got ${actual}`;
      return report;
    }
    file.actualSha256 = actual;
  }
  report.verified = true;

  mkdirSync(installDir, { recursive: true });
  for (const file of files) {
    const canonical = path.join(installDir, file.installedPath);
    if (path.resolve(file.sourcePath) !== path.resolve(canonical)) {
      mkdirSync(path.dirname(canonical), { recursive: true });
      renameSync(file.sourcePath, canonical);
      report.staged = true;
    }
    file.sourcePath = canonical;
    file.source = "canonical";
  }
  writeFileSync(path.join(installDir, "manifest.json"), `${JSON.stringify(MANIFEST_RECEIPT, null, 2)}\n`);
  writeFileSync(path.join(installDir, "spec.json"), `${JSON.stringify(SPEC_RECEIPT, null, 2)}\n`);
  const verifiedHashes = new Map(files.map((file) => [file.installedPath, file.actualSha256]));
  files = locateAssets(installDir);
  report.files = files.map((file) => ({ ...file, actualSha256: verifiedHashes.get(file.installedPath) }));
  report.installed = files.every((file) => file.complete) && receiptsMatch(installDir);
  return report;
}

function parseArgs(argv) {
  const args = { modelsDir: DEFAULT_INSTALL_DIR, wait: false, timeoutSeconds: 1800, checkOnly: false, json: false, download: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--models-dir") args.modelsDir = argv[++index] ?? "";
    else if (flag === "--wait") args.wait = true;
    else if (flag === "--timeout-seconds") args.timeoutSeconds = Number.parseInt(argv[++index] ?? "", 10);
    else if (flag === "--check-only") args.checkOnly = true;
    else if (flag === "--download") args.download = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(
      "usage: install-model.mjs [--models-dir DIR] [--wait] [--timeout-seconds N] [--check-only] [--json]\n" +
        "  verifies pinned sizes/SHA-256 and stages the raw HF files into the canonical install layout; never downloads.",
    );
    return;
  }
  if (!args.modelsDir) {
    console.error("--models-dir must not be empty");
    process.exitCode = 2;
    return;
  }
  const report = await installModel(args.modelsDir, {
    wait: args.wait,
    timeoutSeconds: args.timeoutSeconds,
    checkOnly: args.checkOnly,
    download: args.download,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.error) {
    console.error(`NOT READY: ${report.error}`);
    for (const file of report.files) {
      console.error(`  ${file.installedPath}: ${file.bytes ?? 0}/${file.expectedBytes} (${file.source})`);
    }
  } else {
    console.log(`verified=${report.verified} installed=${report.installed} staged=${report.staged} dir=${report.modelsDir}`);
    for (const file of report.files) {
      console.log(`  ${file.installedPath}: ${file.bytes}/${file.expectedBytes} sha256=${file.actualSha256 ? "ok" : "unchecked"}`);
    }
  }
  if (report.error) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
