#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditAgentBeltPilot, scenarioOutputRelativePath } from "./pilot-audit.mjs";

function usage() {
  return "Usage: node src/pilot-audit-cli.mjs --run <agent-belt-run> --environment <manifest> --output <report>\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--run", "--environment", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function readJsonWithDigest(filePath) {
  const contents = await readFile(filePath);
  return {
    value: JSON.parse(contents.toString("utf8")),
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["run", "environment", "output"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }

  const runPath = path.resolve(options.run);
  const environmentPath = path.resolve(options.environment);
  const outputPath = path.resolve(options.output);
  const benchmarkCard = await readJsonWithDigest(path.join(runPath, "benchmark-card.json"));
  const results = await readJsonWithDigest(path.join(runPath, "results.json"));
  const environment = await readJsonWithDigest(environmentPath);
  const outcomes = new Map();
  const scenarioDigests = {};
  for (const scenario of results.value.scenarios ?? []) {
    const relativePath = scenarioOutputRelativePath(scenario.scenario_name);
    const outcome = await readJsonWithDigest(path.join(runPath, relativePath));
    outcomes.set(scenario.scenario_name, outcome.value);
    scenarioDigests[scenario.scenario_name] = outcome.digest;
  }
  const report = auditAgentBeltPilot({
    benchmarkCard: benchmarkCard.value,
    results: results.value,
    outcomes,
    environment: environment.value,
    sourceDigests: {
      benchmark_card: benchmarkCard.digest,
      results: results.digest,
      environment: environment.digest,
      scenario_outputs: scenarioDigests,
    },
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, pilot_decision: report.conclusion.pilot_decision, quality_claim_status: report.conclusion.quality_claim_status, counts: report.counts })}\n`);
  if (report.conclusion.pilot_decision !== "go") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
