/**
 * Node test for the isolated Route B search slice.
 *
 * Run: node --test scripts/route-b/search/search.test.mjs
 *
 * Proves: the Rust slice's unit/integration tests pass; the deterministic text
 * fallback and explicit `visual_unavailable` image path work end-to-end through
 * the probe binary; and the Node asset probe agrees on the pinned model facts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MANIFEST, probeModelAssets, TOTAL_BYTES, installDir } from "./model-assets.mjs";
import {
  ensureProbeBuilt,
  makeFixture,
  probeImage,
  probeText,
  runCrateTests,
  runProbeSuite,
} from "./probe-search.mjs";

test("the isolated Rust crate's unit and integration tests pass offline", () => {
  const result = runCrateTests();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /test result: ok\./);
  assert.doesNotMatch(result.stderr, /error\[E/);
});

test("text fallback returns deterministic Files/Spoken and no fabricated Moments", () => {
  const fixture = makeFixture();
  try {
    const first = probeText(fixture.assetsPath, "sun", fixture.modelsDir);
    assert.equal(first.capability.installed, false);
    assert.equal(first.capability.visualAvailable, false);
    assert.equal(first.capability.reason, "visual_unavailable");
    assert.equal(first.capability.detail, "model_not_installed");
    assert.deepEqual(first.results.moments, []);
    assert.deepEqual(
      first.results.files.map((hit) => hit.mediaId),
      ["a1", "a3"],
    );
    assert.deepEqual(
      first.results.spoken.map((hit) => [hit.mediaId, hit.text]),
      [["a1", "sunset over water"]],
    );
    assert.equal(first.results.visualError, "visual_unavailable");
    assert.equal(first.results.visualErrorDetail, "model_not_installed");
    assert.equal(first.results.queryKind, "text");

    const second = probeText(fixture.assetsPath, "sun", fixture.modelsDir);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("image query without assets/backends reports visual_unavailable and never fakes Moments", () => {
  const fixture = makeFixture();
  try {
    const result = probeImage(fixture.assetsPath, fixture.imagePath, fixture.modelsDir);
    assert.equal(result.results.queryKind, "image");
    assert.deepEqual(result.results.moments, []);
    assert.deepEqual(result.results.files, []);
    assert.deepEqual(result.results.spoken, []);
    assert.equal(result.results.visualAvailable, false);
    assert.equal(result.results.visualError, "visual_unavailable");
    assert.equal(probeImage(fixture.assetsPath, fixture.imagePath, fixture.modelsDir).results.visualError, "visual_unavailable");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("probe suite contract passes (status, text, image, determinism)", () => {
  const result = runProbeSuite();
  assert.equal(result.status.probe.expectedTotalBytes, TOTAL_BYTES);
  assert.equal(result.text.results.visualError, "visual_unavailable");
  assert.equal(result.image.results.visualError, "visual_unavailable");
});

test("pinned manifest facts match the desktop engine", () => {
  assert.equal(MANIFEST.model, "siglip2-base-patch16-256");
  assert.equal(MANIFEST.version, 2);
  assert.equal(MANIFEST.embeddingDim, 768);
  assert.equal(MANIFEST.imageSize, 256);
  assert.equal(MANIFEST.contextLength, 64);
  assert.equal(MANIFEST.revision.length, 40);
  assert.equal(TOTAL_BYTES, 1_535_824_768);
  assert.deepEqual(
    MANIFEST.files.map((file) => [file.installedPath, file.bytes]),
    [
      ["image_encoder.onnx", 371_992_072],
      ["text_encoder.onnx", 1_129_469_657],
      ["tokenizer/tokenizer.json", 34_363_039],
    ],
  );
  for (const file of MANIFEST.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test("missing models dir is a capability result, not a fake install", async () => {
  const unset = await probeModelAssets(null);
  assert.equal(unset.capability.installed, false);
  assert.equal(unset.capability.visualAvailable, false);
  assert.equal(unset.capability.reason, "visual_unavailable");
  assert.equal(unset.capability.detail, "models_dir_not_configured");
  assert.equal(unset.capability.expectedBytes, TOTAL_BYTES);

  const emptyDir = mkdtempSync(path.join(os.tmpdir(), "opentake-search-assets-"));
  try {
    const empty = await probeModelAssets(emptyDir);
    assert.equal(empty.probe.state, "missing");
    assert.equal(empty.capability.installed, false);
    assert.equal(empty.capability.detail, "model_not_installed");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("wrong-sized assets report model_incomplete instead of installed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opentake-search-incomplete-"));
  try {
    const dir = installDir(root);
    mkdirSync(path.join(dir, "tokenizer"), { recursive: true });
    for (const file of MANIFEST.files) {
      writeFileSync(path.join(dir, file.installedPath), "x");
    }
    const result = await probeModelAssets(root);
    assert.equal(result.probe.state, "incomplete");
    assert.equal(result.capability.installed, false);
    assert.equal(result.capability.visualAvailable, false);
    assert.equal(result.capability.detail, "model_incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the probe binary exists after the suite builds it", () => {
  assert.ok(ensureProbeBuilt().endsWith("search-probe"));
});
