#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditBaselineCohort } from "./cohort.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node src/cohort-cli.mjs --cohort <path> --environment <path> --output <path>\n\n` +
    "The cohort file declares task ids and relative trace paths. Eligibility is derived from the\n" +
    "environment manifest and validated VerifyTrace evidence; it cannot be declared by input.\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--cohort", "--environment", "--output"].includes(argument)) {
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function tracePath(cohortPath, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error("Task trace_path must be relative to the cohort file");
  const base = path.dirname(cohortPath);
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Task trace_path escapes the cohort directory");
  return resolved;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["cohort", "environment", "output"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }
  const cohortPath = path.resolve(projectRoot, options.cohort);
  const environmentPath = path.resolve(projectRoot, options.environment);
  const outputPath = path.resolve(projectRoot, options.output);
  const cohort = await readJson(cohortPath);
  const environment = await readJson(environmentPath);
  const traces = new Map();
  for (const task of cohort.tasks ?? []) {
    if (task.status !== "collected") continue;
    traces.set(task.task_id, await readJson(tracePath(cohortPath, task.trace_path)));
  }
  const report = auditBaselineCohort({ cohort, environment, traces });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, status: report.conclusion.status, counts: report.counts })}\n`);
  if (report.conclusion.status !== "ready") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
