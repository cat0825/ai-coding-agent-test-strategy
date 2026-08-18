#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { auditVerificationBenchmarkDesign } from "./verification-benchmark.mjs";
import { stableJson } from "./benchmark-preflight.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plan", "--oracles", "--output"].includes(flag) || !value) {
      throw new Error("Usage: verification-benchmark-cli --plan PLAN --oracles ORACLES --output OUTPUT");
    }
    options[flag.slice(2)] = value;
  }
  if (!options.plan || !options.oracles || !options.output) {
    throw new Error("Usage: verification-benchmark-cli --plan PLAN --oracles ORACLES --output OUTPUT");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [plan, oracles] = await Promise.all([
    readFile(path.resolve(options.plan), "utf8").then(JSON.parse),
    readFile(path.resolve(options.oracles), "utf8").then(JSON.parse),
  ]);
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${stableJson(report)}\n`);
  process.stdout.write(`${report.conclusion.status}: ${report.counts.tasks} pilot tasks\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
