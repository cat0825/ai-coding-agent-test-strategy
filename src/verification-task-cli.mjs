#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { materializeVerificationTask } from "./verification-workspace.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--plan", "--task", "--repo", "--output-parent"].includes(flag) || !value) {
      throw new Error("Usage: verification-task-cli --plan PLAN --task TASK --repo REPOSITORY --output-parent DIRECTORY");
    }
    options[flag.slice(2)] = value;
  }
  if (!options.plan || !options.task || !options.repo || !options["output-parent"]) {
    throw new Error("Usage: verification-task-cli --plan PLAN --task TASK --repo REPOSITORY --output-parent DIRECTORY");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(await readFile(path.resolve(options.plan), "utf8"));
  const task = plan.tasks?.find(({ task_id: taskId }) => taskId === options.task);
  if (!task) throw new Error(`Unknown verification benchmark task: ${options.task}`);
  const materialized = await materializeVerificationTask({
    plan,
    taskId: task.task_id,
    sourceRepository: path.resolve(options.repo),
    outputParent: path.resolve(options["output-parent"]),
  });
  process.stdout.write(`${JSON.stringify({
    task_id: task.task_id,
    mode: task.mode,
    instruction: task.definition.instruction,
    scenario_definition_sha256: task.scenario_definition_sha256,
    workspace: materialized.workspace,
    workspace_revision: materialized.workspace_revision,
    changed_files: materialized.changed_files,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
