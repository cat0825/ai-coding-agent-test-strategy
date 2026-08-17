#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCohort } from "./evaluation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node src/evaluate-cli.mjs [options]

Options:
  --cohort <path>   Evaluation cohort JSON (default: fixtures/evaluation/cohort-v1.json).
  --output <path>   Report path (default: output/evaluation/mvp-evaluation-v1.json).
  --help            Show this help.
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv) {
  const options = {
    cohort: "fixtures/evaluation/cohort-v1.json",
    output: "output/evaluation/mvp-evaluation-v1.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--cohort" || argument === "--output") {
      options[argument.slice(2)] = takeValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const cohortPath = path.resolve(projectRoot, options.cohort);
  const cohort = await readJson(cohortPath);
  const traces = new Map();
  for (const descriptor of cohort.traces ?? []) {
    traces.set(descriptor.id, await readJson(path.resolve(projectRoot, descriptor.path)));
  }
  const report = evaluateCohort(cohort, traces);
  const outputPath = path.resolve(projectRoot, options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, status: report.conclusion.status, efficiency_claim: report.conclusion.efficiency_claim })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
