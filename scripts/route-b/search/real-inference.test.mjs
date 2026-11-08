/**
 * Real SigLIP2 inference proof for the Route B search addon.
 *
 * Prereqs (no downloads here):
 *  - pinned assets downloaded and staged with
 *    `node scripts/route-b/search/install-model.mjs --wait`
 *  - `cargo build -p opentake-node` (the addon links ort-backend)
 *
 * Run: node --test --test-timeout=600000 scripts/route-b/search/real-inference.test.mjs
 *
 * The test generates deterministic PNG fixtures, indexes them through the real
 * N-API addon, then proves:
 *  - text query embeds through the real SigLIP2 text encoder and ranks Moments;
 *  - image query embeds a real PNG and the same image is the top self-match;
 *  - capability JSON and missing-model fallback are honest.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { installModel, DEFAULT_INSTALL_DIR, MANIFEST_RECEIPT, SPEC_RECEIPT } from "./install-model.mjs";
import { MANIFEST } from "./model-assets.mjs";
import { REPO_ROOT, resolveCargo, runCargo } from "./probe-search.mjs";

const require = createRequire(import.meta.url);

// --- minimal solid-colour PNG encoder (no dependencies) ---------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function solidPng(width, height, [r, g, b, a = 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- addon loading ----------------------------------------------------------

function addonFileName() {
  if (process.platform === "darwin") return "libopentake_node.dylib";
  if (process.platform === "win32") return "opentake_node.dll";
  return "libopentake_node.so";
}

let addonCache = null;
function loadAddon() {
  if (addonCache) return addonCache;
  const build = runCargo(["build", "-p", "opentake-node", "--offline"]);
  assert.equal(build.status, 0, `addon build failed:\n${build.stderr || build.stdout}`);
  const built = path.join(REPO_ROOT, "target", "debug", addonFileName());
  const dir = mkdtempSync(path.join(os.tmpdir(), "opentake-search-addon-"));
  const addonPath = path.join(dir, "opentake_search_probe.node");
  copyFileSync(built, addonPath);
  addonCache = { addon: require(addonPath), dir };
  return addonCache;
}

function makeFixtures() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opentake-search-images-"));
  const files = {
    red: path.join(root, "red.png"),
    blue: path.join(root, "blue.png"),
    green: path.join(root, "green.png"),
  };
  writeFileSync(files.red, solidPng(96, 96, [230, 20, 20]));
  writeFileSync(files.blue, solidPng(96, 96, [20, 30, 230]));
  writeFileSync(files.green, solidPng(96, 96, [20, 210, 40]));
  return { root, files };
}

function makeVideoFixture(root) {
  const videoPath = path.join(root, "red.mp4");
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=256x256:d=2:r=30", "-pix_fmt", "yuv420p", "-c:v", "mpeg4", videoPath],
    { encoding: "utf8", timeout: 120_000 },
  );
  return { path: videoPath, ok: result.status === 0 && existsSync(videoPath), stderr: result.stderr };
}

function assetsJson(files) {
  return JSON.stringify(
    Object.entries(files).map(([id, filePath]) => ({ id, path: filePath, kind: "image" })),
  );
}

test("addon loads and reports an honest unconfigured capability", () => {
  const { addon } = loadAddon();
  const engine = new addon.Engine();
  const status = JSON.parse(engine.searchModelStatus());
  assert.equal(status.installed, false);
  assert.equal(status.visualAvailable, false);
  assert.equal(status.reason, "visual_unavailable");
  assert.equal(status.detail, "models_dir_not_configured");
  assert.equal(status.expectedBytes, 1_535_824_768);
  assert.equal(status.backend, process.platform === "win32" ? "ort-tract" : "ort-native");
});

test("missing/corrupt model dir is capability-gated (no fake success)", async () => {
  const { addon } = loadAddon();
  const engine = new addon.Engine();
  const empty = mkdtempSync(path.join(os.tmpdir(), "opentake-search-empty-"));
  const cache = mkdtempSync(path.join(os.tmpdir(), "opentake-search-cache-"));
  try {
    const capability = JSON.parse(engine.searchConfigure(empty, cache));
    assert.equal(capability.installed, false);
    assert.equal(capability.visualAvailable, false);
    assert.equal(capability.reason, "visual_unavailable");
    assert.ok(["model_not_installed", "model_incomplete"].includes(capability.detail));
    const status = JSON.parse(engine.searchIndexStatus(JSON.stringify([])));
    assert.equal(status.modelInstalled, false);
    assert.equal(status.visualAvailable, false);
    assert.equal(status.indexed, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("corrupt (wrong-byte, right-size) assets report checksum_mismatch", async () => {
  const { addon } = loadAddon();
  const root = mkdtempSync(path.join(os.tmpdir(), "opentake-search-corrupt-"));
  const installDir = path.join(root, `${MANIFEST.model}-v${MANIFEST.version}`);
  const cache = mkdtempSync(path.join(os.tmpdir(), "opentake-search-cache-"));
  try {
    mkdirSync(path.join(installDir, "tokenizer"), { recursive: true });
    for (const file of MANIFEST.files) {
      const target = path.join(installDir, file.installedPath);
      mkdirSync(path.dirname(target), { recursive: true });
      const handle = openSync(target, "w");
      truncateSync(target, file.bytes);
      closeSync(handle);
    }
    // Correct sizes, so the size gate passes; the receipts make installed()
    // pass too. Verification must then fail on the zero-byte SHA-256 digests.
    writeFileSync(path.join(installDir, "manifest.json"), JSON.stringify(MANIFEST_RECEIPT));
    writeFileSync(path.join(installDir, "spec.json"), JSON.stringify(SPEC_RECEIPT));
    const engine = new addon.Engine();
    const capability = JSON.parse(engine.searchConfigure(installDir, cache));
    assert.equal(capability.installed, false);
    assert.equal(capability.visualAvailable, false);
    assert.equal(capability.reason, "visual_unavailable");
    assert.equal(capability.detail, "checksum_mismatch", JSON.stringify(capability));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

const staged = await installModel(DEFAULT_INSTALL_DIR, { wait: false });
test(
  "real SigLIP2 inference: text + image query into Moments",
  { skip: staged.installed ? false : staged.error ?? "model assets not staged" },
  async () => {
    const { addon, dir: addonDir } = loadAddon();
    const fixtures = makeFixtures();
    const cache = mkdtempSync(path.join(os.tmpdir(), "opentake-search-cache-"));
    try {
      const engine = new addon.Engine();
      const configured = JSON.parse(engine.searchConfigure(DEFAULT_INSTALL_DIR, cache));
      assert.equal(configured.installed, true, JSON.stringify(configured));
      assert.equal(configured.visualAvailable, true, JSON.stringify(configured));
      assert.equal(configured.reason, null);
      assert.equal(configured.expectedBytes, 1_535_824_768);
      assert.equal(configured.backend, process.platform === "win32" ? "ort-tract" : "ort-native");

      const assets = assetsJson(fixtures.files);
      const indexStatus = JSON.parse(engine.searchIndexStart(assets));
      assert.equal(indexStatus.modelInstalled, true);
      assert.equal(indexStatus.visualAvailable, true);
      assert.equal(indexStatus.indexable, 3);
      assert.equal(indexStatus.indexed, 3, JSON.stringify(indexStatus));
      assert.deepEqual(indexStatus.errors, []);

      const text = JSON.parse(engine.searchQuery("a solid red square", assets, 30));
      assert.equal(text.visualAvailable, true);
      assert.equal(text.visualError, null);
      assert.equal(text.queryKind, "text");
      assert.ok(text.moments.length > 0, "real text embedding produced no Moments");
      for (const moment of text.moments) {
        assert.ok(["red", "blue", "green"].includes(moment.mediaId));
        assert.ok(Number.isFinite(moment.score));
      }
      console.log("real text query moments:", JSON.stringify(text.moments));

      const redBase64 = Buffer.from(readFileSync(fixtures.files.red)).toString("base64");
      const image = JSON.parse(engine.searchQueryImage(redBase64, assets, 30));
      assert.equal(image.visualAvailable, true);
      assert.equal(image.visualError, null);
      assert.equal(image.queryKind, "image");
      assert.ok(image.moments.length > 0, "real image embedding produced no Moments");
      assert.equal(image.moments[0].mediaId, "red", JSON.stringify(image.moments));
      assert.ok(image.moments[0].score > 0.9, `self-match score ${image.moments[0].score}`);
      console.log("real image query top moment:", JSON.stringify(image.moments[0]));

      // Real video indexing: sample frames through ffmpeg, embed each, and rank
      // the same red image query against both stills and the video.
      const video = makeVideoFixture(fixtures.root);
      assert.ok(video.ok, `ffmpeg fixture failed: ${video.stderr}`);
      const mixed = JSON.parse(
        JSON.stringify([
          ...Object.entries(fixtures.files).map(([id, filePath]) => ({ id, path: filePath, kind: "image" })),
          { id: "red-video", path: video.path, kind: "video", durationSecs: 2, width: 256, height: 256 },
        ]),
      );
      const mixedAssets = JSON.stringify(mixed);
      const videoIndex = JSON.parse(engine.searchIndexStart(mixedAssets));
      assert.equal(videoIndex.indexable, 4);
      assert.equal(videoIndex.indexed, 4, JSON.stringify(videoIndex));
      assert.deepEqual(videoIndex.errors, []);
      const videoQuery = JSON.parse(engine.searchQueryImage(redBase64, mixedAssets, 30));
      assert.equal(videoQuery.visualError, null);
      assert.ok(videoQuery.moments.some((moment) => moment.mediaId === "red-video"), JSON.stringify(videoQuery.moments));
      console.log("real video index/query moments:", JSON.stringify(videoQuery.moments));
    } finally {
      rmSync(fixtures.root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
      rmSync(addonDir, { recursive: true, force: true });
      addonCache = null;
    }
  },
);
