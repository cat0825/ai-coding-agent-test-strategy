#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditAgentBeltTaskPlan } from "./task-plan.mjs";

function usage() {
  return `Usage: node src/task-plan-cli.mjs --plan <json> --agent-belt <checkout> --output <json> [--allow-host]\n`;
}

function parseArguments(argv) {
  const options = { allowHost: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-host") {
      options.allowHost = true;
      continue;
    }
    if (["--plan", "--agent-belt", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  for (const name of ["plan", "agentBelt", "output"]) if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(await readFile(path.resolve(options.plan), "utf8"));
  const report = await auditAgentBeltTaskPlan({ plan, agentBeltRoot: path.resolve(options.agentBelt), runPreflight: options.allowHost });
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, status: report.conclusion.status, quality_claim_eligible: false })}\n`);
  if (report.conclusion.status !== "planning_ready") process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}`);
  process.exitCode = 1;
}
