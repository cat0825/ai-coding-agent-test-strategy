#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTasktrackerOracle } from "./oracle.mjs";

function usage() {
  return "Usage: node src/oracle-cli.mjs --task <id> --repo <post-agent-worktree> --environment <manifest> --output <report> --allow-host [--python <binary>]\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--allow-host") {
      options.allowHost = true;
      continue;
    }
    if (["--task", "--repo", "--environment", "--output", "--python"].includes(argument)) {
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

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["task", "repo", "environment", "output"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }
  const environmentContents = await readFile(path.resolve(options.environment));
  const environment = JSON.parse(environmentContents.toString("utf8"));
  const report = await runTasktrackerOracle({
    taskId: options.task,
    repoRoot: path.resolve(options.repo),
    environment,
    environmentSourceDigest: createHash("sha256").update(environmentContents).digest("hex"),
    pythonBinary: options.python ?? "python3",
    allowHost: options.allowHost === true,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, task_id: report.task_id, oracle_status: report.result.status, baseline_quality_claim_eligible: false })}\n`);
  if (report.result.status !== "passed") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
