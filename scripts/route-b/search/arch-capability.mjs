#!/usr/bin/env node
/**
 * Per-arch search-backend capability check for the Route B addon.
 *
 * The addon selects its search backend at compile time:
 *   darwin arm64  -> native ORT (`ort-native`)
 *   everything else (darwin x64, Windows, Linux) -> pure-Rust tract (`tract`)
 *
 * When the addon's architecture matches this process it is loaded and reports
 * its real capability JSON. Otherwise the script performs a static check of the
 * binary: expected backend marker present, and no native ONNX Runtime linkage
 * for tract builds. This is the evidence path for x64/Windows when the host
 * cannot execute those binaries (e.g. no Rosetta).
 *
 * Usage:
 *   node scripts/route-b/search/arch-capability.mjs [--addon PATH]
 *        [--models-dir DIR] [--cache-dir DIR] [--static-only] [--json]
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

export function expectedBackend(platform, arch) {
  return platform === "darwin" && arch === "arm64" ? "ort-native" : "tract";
}

function addonFileName(platform) {
  if (platform === "darwin") return "libopentake_node.dylib";
  if (platform === "win32") return "opentake_node.dll";
  return "libopentake_node.so";
}

export function detectBinaryInfo(addonPath) {
  const file = spawnSync("file", ["-b", addonPath], { encoding: "utf8" });
  const description = file.status === 0 ? (file.stdout ?? "").trim() : "";
  let format = null;
  let arch = null;
  if (/Mach-O/i.test(description)) {
    format = "macho";
    if (/arm64e?/i.test(description)) arch = "arm64";
    else if (/x86_64/i.test(description)) arch = "x64";
    else if (/universal|fat/i.test(description)) arch = "universal";
  } else if (/ELF/i.test(description)) {
    format = "elf";
    if (/aarch64|arm64/i.test(description)) arch = "arm64";
    else if (/x86-64|x86_64/i.test(description)) arch = "x64";
  } else if (/PE32/i.test(description)) {
    format = "pe";
    // `file` output for PE does not always name the machine; parse the header.
    const header = readFileSync(addonPath).subarray(0, 0x40);
    if (header.readUInt16LE(0) === 0x5a4d) {
      const peOffset = header.readUInt32LE(0x3c);
      const read = readFileSync(addonPath);
      if (peOffset + 6 <= read.length) arch = read.readUInt16LE(peOffset + 4) === 0x8664 ? "x64" : "arm64";
    }
    format = "pe";
  }
  return { description, format, arch };
}

export function staticMarkers(addonPath, platform) {
  const bytes = readFileSync(addonPath);
  const text = bytes.toString("latin1");
  const hasOrtNative = text.includes("ort-native");
  const hasTract = text.includes("tract");
  const hasOrtLinkage =
    text.includes("onnxruntime") || text.includes("libonnxruntime") || text.includes("onnxruntime.dll");
  let linkedLibraries = [];
  if (platform === "darwin") {
    const result = spawnSync("otool", ["-L", addonPath], { encoding: "utf8" });
    if (result.status === 0) linkedLibraries = (result.stdout ?? "").split("\n").slice(1).map((line) => line.trim());
  }
  return { hasOrtNative, hasTract, hasOrtLinkage, linkedLibraries };
}

function probeLoadedCapability(addonPath, modelsDir, cacheDir) {
  const require = createRequire(import.meta.url);
  // Node's loader only treats `.node` as a native addon; copy the built dylib
  // (or a packaged `.node`) to a temp `.node` path before requiring it.
  const loadDir = mkdtempSync(path.join(os.tmpdir(), "opentake-search-cap-"));
  const loadPath = path.join(loadDir, "opentake_search_cap.node");
  copyFileSync(addonPath, loadPath);
  const addon = require(loadPath);
  const engine = new addon.Engine();
  let capability = JSON.parse(engine.searchModelStatus());
  if (capability.detail === "models_dir_not_configured" && modelsDir) {
    capability = JSON.parse(engine.searchConfigure(modelsDir, cacheDir));
  }
  return capability;
}

export function checkArchCapability(options = {}) {
  const platform = options.platform ?? process.platform;
  const hostArch = options.arch ?? process.arch;
  const addon = options.addon ?? path.join(REPO_ROOT, "target", "debug", addonFileName(platform));
  if (!existsSync(addon)) {
    const expected = expectedBackend(platform, hostArch);
    return { ok: false, reason: `addon not found: ${addon}`, platform, arch: hostArch, expectedBackend: expected };
  }
  const binary = detectBinaryInfo(addon);
  const targetArch = binary.arch && binary.arch !== "universal" ? binary.arch : hostArch;
  const expected = expectedBackend(platform, targetArch);
  const binaryMatchesHost = (binary.arch === hostArch || binary.arch === "universal") && binary.format !== null;
  const markers = staticMarkers(addon, platform);
  const staticOk = expected === "ort-native" ? markers.hasOrtNative && markers.hasOrtLinkage : markers.hasTract && !markers.hasOrtLinkage;
  const result = {
    platform,
    arch: targetArch,
    hostArch,
    addon,
    binaryFormat: binary.format,
    binaryArch: binary.arch,
    expectedBackend: expected,
    binaryMatchesHost,
    staticMarkers: markers,
    staticOk,
    capability: null,
    capOk: false,
  };
  if (binaryMatchesHost && options.staticOnly !== true) {
    try {
      result.capability = probeLoadedCapability(addon, options.modelsDir, options.cacheDir);
      result.capOk = result.capability.backend === expected;
    } catch (error) {
      result.capabilityError = error instanceof Error ? error.message : String(error);
    }
  }
  result.ok = staticOk && (binaryMatchesHost && options.staticOnly !== true ? result.capOk : true);
  return result;
}

function parseArgs(argv) {
  const args = { staticOnly: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--addon") args.addon = argv[++index];
    else if (flag === "--models-dir") args.modelsDir = argv[++index];
    else if (flag === "--cache-dir") args.cacheDir = argv[++index];
    else if (flag === "--static-only") args.staticOnly = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--out") args.out = argv[++index];
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function main() {
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
      "usage: arch-capability.mjs [--addon PATH] [--models-dir DIR] [--cache-dir DIR] [--static-only] [--json]\n" +
        "  loads the addon when its arch matches; otherwise reports static backend/ORT-linkage evidence.",
    );
    return;
  }
  const cacheDir = args.cacheDir ?? mkdtempSync(path.join(os.tmpdir(), "opentake-search-arch-"));
  const createdCache = args.cacheDir === undefined;
  let result;
  try {
    result = checkArchCapability({
      addon: args.addon,
      arch: args.arch,
      modelsDir: args.modelsDir,
      cacheDir,
      staticOnly: args.staticOnly,
    });
  } finally {
    if (createdCache) rmSync(cacheDir, { recursive: true, force: true });
  }
  if (args.out) writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.platform}/${result.arch}: binary=${result.binaryArch}/${result.binaryFormat} expectedBackend=${result.expectedBackend} ` +
        `staticOk=${result.staticOk} capOk=${result.capOk}`,
    );
    if (result.capability) console.log(`capability=${JSON.stringify(result.capability)}`);
    if (!result.ok) console.error(`FAIL ${result.reason ?? "capability mismatch"}`);
  }
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
