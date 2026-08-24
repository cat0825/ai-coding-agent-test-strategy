#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stableJson } from "./benchmark-preflight.mjs";
import { parseFixtureRepositoryOption, qualifyVerificationPilot } from "./verification-workspace.mjs";

const USAGE = "Usage: verification-workspace-cli --plan PLAN --oracles ORACLES --repo REPOSITORY --output OUTPUT [--fixture-repo FIXTURE_ID=PATH]";

function parseArguments(argv) {
  const options = { "fixture-repo": [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plan", "--oracles", "--repo", "--output", "--fixture-repo"].includes(flag) || !value) {
      throw new Error(USAGE);
    }
    if (flag === "--fixture-repo") options["fixture-repo"].push(value);
    else options[flag.slice(2)] = value;
  }
  if (!options.plan || !options.oracles || !options.repo || !options.output) {
    throw new Error(USAGE);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [plan, oracles] = await Promise.all([
    readFile(path.resolve(options.plan), "utf8").then(JSON.parse),
    readFile(path.resolve(options.oracles), "utf8").then(JSON.parse),
  ]);
  const report = await qualifyVerificationPilot({
    plan,
    oracles,
    sourceRepository: path.resolve(options.repo),
    fixtureRepositories: parseFixtureRepositoryOption(options["fixture-repo"]),
  });
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${stableJson(report)}\n`);
  process.stdout.write(`${report.conclusion.status}: ${report.counts.qualified_tasks}/${report.counts.tasks} tasks\n`);
  if (report.conclusion.status !== "fixture_ready") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
