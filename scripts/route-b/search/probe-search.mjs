#!/usr/bin/env node
/**
 * Route B search-slice probe: builds and runs the dependency-free Rust probe
 * (`crates/opentake-search`) against a deterministic fixture and asserts the
 * capability-gated fallback contract. No model download, no network.
 *
 * Run: node scripts/route-b/search/probe-search.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeModelAssets } from "./model-assets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
export const CRATE_MANIFEST = path.join(REPO_ROOT, "crates/opentake-search/Cargo.toml");
const BINARY = path.join(REPO_ROOT, "crates/opentake-search/target/debug/search-probe");

/** Resolve a cargo executable even when ~/.cargo/bin is not on PATH. */
export function resolveCargo() {
  const candidates = [
    process.env.CARGO,
    path.join(os.homedir(), ".cargo/bin/cargo"),
    "/opt/homebrew/bin/cargo",
    "/usr/local/bin/cargo",
    "cargo",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("cargo was not found (set CARGO or add ~/.cargo/bin to PATH)");
}

function cargoEnv() {
  return {
    ...process.env,
    PATH: `${path.join(os.homedir(), ".cargo/bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

export function runCargo(args, { timeout = 180_000 } = {}) {
  return spawnSync(resolveCargo(), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout,
    env: cargoEnv(),
  });
}

/** `cargo test --offline` for the isolated crate. */
export function runCrateTests() {
  const result = runCargo([
    "test",
    "--offline",
    "--manifest-path",
    CRATE_MANIFEST,
  ]);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function ensureProbeBuilt() {
  const result = runCargo(["build", "--offline", "--manifest-path", CRATE_MANIFEST]);
  if (result.status !== 0) {
    throw new Error(`cargo build failed:\n${result.stderr || result.stdout}`);
  }
  return BINARY;
}

export function runProbe(args, { timeout = 60_000 } = {}) {
  const binary = ensureProbeBuilt();
  const result = spawnSync(binary, args, { encoding: "utf8", timeout });
  if (result.status !== 0) {
    throw new Error(`search-probe ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

export function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opentake-search-probe-"));
  const modelsDir = path.join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  const assetsPath = path.join(root, "assets.tsv");
  writeFileSync(
    assetsPath,
    [
      "asset\ta1\tBeach Sunrise.mp4\tvisual",
      "cue\ta1\t1\t2\tsunset over water",
      "asset\ta2\tCity Night.mov\tvisual",
      "cue\ta2\t3\t4\tneon lights",
      "asset\ta3\tSunset Song.wav\taudio",
      "",
    ].join("\n"),
  );
  const imagePath = path.join(root, "query-image.bin");
  writeFileSync(imagePath, Buffer.from("deterministic-image-bytes"));
  return { root, modelsDir, assetsPath, imagePath };
}

export function probeText(assetsPath, query, modelsDir) {
  return runProbe([
    "--assets",
    assetsPath,
    "--query",
    query,
    "--models-dir",
    modelsDir,
  ]);
}

export function probeImage(assetsPath, imagePath, modelsDir) {
  return runProbe([
    "--assets",
    assetsPath,
    "--image",
    imagePath,
    "--models-dir",
    modelsDir,
  ]);
}

export function probeStatus(modelsDir) {
  return runProbe(["--status", "--models-dir", modelsDir]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFallbackContract(payload, { queryKind }) {
  const { capability, results } = payload;
  assert(capability.model === "siglip2-base-patch16-256", "model id");
  assert(capability.version === 2, "model version");
  assert(capability.expectedBytes === 1_535_824_768, "expected bytes");
  assert(capability.installed === false, "uninstalled assets must report installed:false");
  assert(capability.visualAvailable === false, "unavailable must report visualAvailable:false");
  assert(capability.reason === "visual_unavailable", "stable reason code");
  assert(capability.detail === "model_not_installed", "stable detail code");
  assert(Array.isArray(results.moments) && results.moments.length === 0, "no fake moments");
  assert(results.visualAvailable === false, "results visualAvailable:false");
  assert(results.visualError === "visual_unavailable", "results visualError");
  assert(results.queryKind === queryKind, "query kind");
}

export function runProbeSuite() {
  const fixture = makeFixture();
  try {
    const status = probeStatus(fixture.modelsDir);
    assert(status.probe.state === "missing", "fixture models dir must be empty");
    assert(status.probe.expectedTotalBytes === 1_535_824_768, "status total bytes");

    const text = probeText(fixture.assetsPath, "SUN", fixture.modelsDir);
    assertFallbackContract(text, { queryKind: "text" });
    const files = text.results.files.map((hit) => hit.mediaId);
    assert(files.join(",") === "a1,a3", `text files (${files.join(",")})`);
    const spoken = text.results.spoken.map((hit) => `${hit.mediaId}:${hit.text}`);
    assert(spoken.join("|") === "a1:sunset over water", `text spoken (${spoken.join("|")})`);

    const again = probeText(fixture.assetsPath, "SUN", fixture.modelsDir);
    assert(JSON.stringify(again) === JSON.stringify(text), "text query must be deterministic");

    const image = probeImage(fixture.assetsPath, fixture.imagePath, fixture.modelsDir);
    assertFallbackContract(image, { queryKind: "image" });
    assert(image.results.files.length === 0, "image query has no lexical files");
    assert(image.results.spoken.length === 0, "image query has no lexical spoken");
    const imageAgain = probeImage(fixture.assetsPath, fixture.imagePath, fixture.modelsDir);
    assert(JSON.stringify(imageAgain) === JSON.stringify(image), "image query must be deterministic");

    return { status, text, image };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  const tests = runCrateTests();
  assert(tests.status === 0, `cargo test failed:\n${tests.stderr || tests.stdout}`);
  const ran = /test result: ok\. (\d+) passed/.exec(tests.stdout);
  console.log(`PASS cargo test --offline (${ran ? ran[1] : "?"} unit tests in lib)`);

  const { status, text, image } = runProbeSuite();
  const nodeAssets = await probeModelAssets(path.join(path.dirname(status.capability.modelsDir), "missing-models"));
  assert(nodeAssets.capability.expectedBytes === status.capability.expectedBytes, "node/rust expectedBytes mismatch");
  assert(nodeAssets.capability.visualAvailable === false, "node probe visualAvailable:false");
  console.log("PASS node model-assets probe is consistent with the Rust capability");
  console.log(`PASS text query fallback: files=${text.results.files.length} spoken=${text.results.spoken.length} moments=0`);
  console.log(`PASS image query fallback: ${image.results.visualError}, moments=0`);
  console.log("PASS deterministic fallback (repeated queries byte-identical)");
  console.log("PASS visual_unavailable is explicit: no fabricated Moments without assets + backend");
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}
