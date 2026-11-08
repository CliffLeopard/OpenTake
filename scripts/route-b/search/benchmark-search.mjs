#!/usr/bin/env node
/**
 * Route B search fallback benchmark. Runs the dependency-free Rust probe's
 * in-process synthetic benchmark (2,000 assets/cues, no model, no network):
 *
 *   node scripts/route-b/search/benchmark-search.mjs [--iterations N]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { ensureProbeBuilt } from "./probe-search.mjs";

function parseArgs(argv) {
  let iterations = 500;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--iterations") {
      iterations = Number.parseInt(argv[++index] ?? "", 10);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  return { iterations };
}

function main() {
  const { iterations } = parseArgs(process.argv.slice(2));
  const binary = ensureProbeBuilt();
  const result = spawnSync(binary, ["--benchmark", String(iterations)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`benchmark failed: ${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout.trim());
  const bench = payload.benchmark;
  console.log(`assets=${bench.assets} cues=${bench.cues} iterations=${bench.iterations}`);
  console.log(
    `total=${bench.totalMicros.toFixed(1)}µs  avg=${bench.avgMicrosPerQuery.toFixed(2)}µs/query  hits=${bench.hits}`,
  );
  if (!(bench.avgMicrosPerQuery >= 0)) throw new Error("benchmark produced no timing");
  console.log(`binary=${path.relative(process.cwd(), binary)}`);
}

try {
  main();
} catch (error) {
  console.error(`FAIL ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
