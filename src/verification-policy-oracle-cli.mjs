#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stableJson } from "./benchmark-preflight.mjs";
import { runVerificationPolicyOracle } from "./verification-policy-oracle.mjs";
import { parseFixtureRepositoryOption } from "./verification-workspace.mjs";

function parseArguments(argv) {
  const options = { fixture_repo: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plan", "--oracles", "--repo", "--task-manifest", "--output", "--fixture-repo"].includes(flag) || !value) {
      throw new Error("Usage: verification-policy-oracle-cli --plan PLAN --oracles ORACLES --repo REPOSITORY --task-manifest TASK_JSON --output OUTPUT [--fixture-repo FIXTURE_ID=PATH]");
    }
    if (flag === "--fixture-repo") options.fixture_repo.push(value);
    else options[flag.slice(2).replaceAll("-", "_")] = value;
  }
  for (const option of ["plan", "oracles", "repo", "task_manifest", "output"]) {
    if (!options[option]) throw new Error(`--${option.replaceAll("_", "-")} is required`);
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const [plan, oracles, taskManifest] = await Promise.all([
    readFile(path.resolve(options.plan), "utf8").then(JSON.parse),
    readFile(path.resolve(options.oracles), "utf8").then(JSON.parse),
    readFile(path.resolve(options.task_manifest), "utf8").then(JSON.parse),
  ]);
  const report = await runVerificationPolicyOracle({
    plan,
    oracles,
    taskManifest,
    sourceRepository: path.resolve(options.repo),
    fixtureRepositories: parseFixtureRepositoryOption(options.fixture_repo),
  });
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${stableJson(report)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, task_id: report.task_id, oracle_status: report.result.status, post_run_workspace_state_sha256: report.workspace.post_run_workspace_state_sha256 })}\n`);
  if (report.result.status !== "passed") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
