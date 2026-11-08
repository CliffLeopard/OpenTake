#!/usr/bin/env node
/**
 * Route B SigLIP2 model-asset probe (read-only, offline, never downloads).
 *
 * This mirrors `crates/opentake-search/src/model.rs`:
 *   <models_dir>/siglip2-base-patch16-256-v2/{image_encoder.onnx,
 *   text_encoder.onnx,tokenizer/tokenizer.json}
 *
 * Run:
 *   node scripts/route-b/search/model-assets.mjs --models-dir DIR [--hash]
 *
 * Exit codes: 0 = probe completed (regardless of availability), 2 = bad args.
 * A missing model is a capability result, not an error.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Pinned SigLIP2 manifest — keep byte-identical with model.rs. */
export const MANIFEST = Object.freeze({
  model: "siglip2-base-patch16-256",
  version: 2,
  embeddingDim: 768,
  imageSize: 256,
  contextLength: 64,
  revision: "d1114256522a37ffa257a0a58017348ab0058db2",
  baseUrl:
    "https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX/resolve/d1114256522a37ffa257a0a58017348ab0058db2",
  files: Object.freeze([
    {
      downloadName: "onnx/vision_model.onnx",
      installedPath: "image_encoder.onnx",
      sha256: "f5cb16728a704703f05516ded628397e11dbca4de2eb5db04b0c0bcee988aa7a",
      bytes: 371_992_072,
    },
    {
      downloadName: "onnx/text_model.onnx",
      installedPath: "text_encoder.onnx",
      sha256: "d3de4a6bbbfcb429b6615ac496790353cf4a4fc0f19fbbe7179e523ae60daaef",
      bytes: 1_129_469_657,
    },
    {
      downloadName: "tokenizer.json",
      installedPath: "tokenizer/tokenizer.json",
      sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
      bytes: 34_363_039,
    },
  ]),
});

export const TOTAL_BYTES = MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0);
export const BACKEND_NONE = "none";

/** `<models_dir>/<model>-v<version>` (same install layout as the desktop engine). */
export function installDir(modelsDir) {
  return path.join(modelsDir, `${MANIFEST.model}-v${MANIFEST.version}`);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.on("data", (chunk) => hash.update(chunk));
  });
  return hash.digest("hex");
}

/**
 * Probe the pinned assets. Never downloads or mutates anything.
 *
 * @param {string|null} modelsDir
 * @param {{verifyHashes?: boolean}} [options]
 * @returns {Promise<{capability: object, probe: object}>}
 */
export async function probeModelAssets(modelsDir, options = {}) {
  const verifyHashes = options.verifyHashes === true;
  const dir = modelsDir === null || modelsDir === undefined ? null : installDir(modelsDir);
  const files = [];
  for (const file of MANIFEST.files) {
    const target = dir === null ? null : path.join(dir, file.installedPath);
    let present = false;
    let actualBytes = null;
    if (target !== null) {
      try {
        const info = await stat(target);
        present = info.isFile();
        if (present) actualBytes = info.size;
      } catch {
        present = false;
      }
    }
    const sizeOk = actualBytes === file.bytes;
    let sha256Ok = null;
    if (verifyHashes && present && sizeOk) {
      try {
        sha256Ok = (await sha256File(target)) === file.sha256;
      } catch {
        sha256Ok = false;
      }
    }
    files.push({
      path: file.installedPath,
      expectedBytes: file.bytes,
      present,
      actualBytes,
      sizeOk,
      sha256Ok,
    });
  }
  const anyPresent = files.some((file) => file.present);
  const allOk = files.every((file) => file.present && file.sizeOk && file.sha256Ok !== false);
  const state = allOk ? "complete" : anyPresent ? "incomplete" : "missing";
  let receiptPresent = false;
  if (dir !== null) {
    try {
      await access(path.join(dir, "manifest.json"));
      receiptPresent = true;
    } catch {
      receiptPresent = false;
    }
  }

  const installed = state === "complete";
  let detail = null;
  if (modelsDir === null || modelsDir === undefined) detail = "models_dir_not_configured";
  else if (!installed) {
    if (files.some((file) => file.sha256Ok === false)) detail = "checksum_mismatch";
    else if (files.some((file) => file.present && !file.sizeOk)) detail = "model_incomplete";
    else detail = "model_not_installed";
  } else {
    // This probe cannot infer a linked backend; the standalone slice reports
    // `none`, so a complete asset set is still capability-gated.
    detail = "backend_not_linked";
  }
  const visualAvailable = installed && BACKEND_NONE !== "none";
  const capability = {
    model: MANIFEST.model,
    version: MANIFEST.version,
    expectedBytes: TOTAL_BYTES,
    modelsDir: modelsDir ?? null,
    installed,
    backend: BACKEND_NONE,
    visualAvailable,
    reason: visualAvailable ? null : "visual_unavailable",
    detail,
  };
  return {
    capability,
    probe: {
      state,
      receiptPresent,
      expectedTotalBytes: TOTAL_BYTES,
      files,
    },
  };
}

function defaultModelsDir() {
  const env = process.env.OPENTAKE_SEARCH_MODELS_DIR;
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}

function parseArgs(argv) {
  const args = { modelsDir: defaultModelsDir(), hash: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--models-dir") {
      args.modelsDir = argv[++index] ?? "";
    } else if (flag === "--hash") {
      args.hash = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(
      "usage: model-assets.mjs [--models-dir DIR] [--hash]\n" +
        "  read-only probe; never downloads. --hash streams the 1.53 GB assets through SHA-256.",
    );
    return;
  }
  const result = await probeModelAssets(args.modelsDir === "" ? null : args.modelsDir, {
    verifyHashes: args.hash,
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
