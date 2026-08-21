#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return "Usage: prepare-verification-policy-hook --plan PLAN_JSON --task-manifest TASK_JSON --output-dir DIRECTORY\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--plan", "--task-manifest", "--output-dir"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.plan || !options.task_manifest || !options.output_dir) throw new Error(usage().trim());
  const plan = JSON.parse(await readFile(path.resolve(options.plan), "utf8"));
  const manifest = JSON.parse(await readFile(path.resolve(options.task_manifest), "utf8"));
  const task = plan.tasks?.find(({ task_id: taskId }) => taskId === manifest.task_id);
  if (!task) throw new Error(`Task ${manifest.task_id ?? "<missing>"} is not present in the public plan`);
  const commands = task.definition?.command_tiers;
  if (!commands || !Array.isArray(commands.fast) || !Array.isArray(commands.affected) || !Array.isArray(commands.full)) {
    throw new Error("Task manifest requires fast, affected, and full command tiers");
  }
  const outputDir = path.resolve(options.output_dir);
  const stateDir = path.join(outputDir, "state");
  const policyPath = path.join(outputDir, "verification-policy.json");
  const hooksPath = path.join(outputDir, "hooks.json");
  const statePath = path.join(stateDir, "policy-state.json");
  const ledgerPath = path.join(stateDir, "policy-decisions.ndjson");
  const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verification-policy-hook.mjs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const maxVerificationSteps = task.behavior_class === "full_fallback" ? 3 : 2;
  const policy = {
    schema_version: 1,
    policy: { name: "observatory-verification-policy", version: "0.2-enforced" },
    task_id: manifest.task_id,
    mode: manifest.mode,
    behavior_class: task.behavior_class,
    risk_class: task.risk_class,
    allow_full_suite: task.behavior_class === "full_fallback" && task.risk_class === "high",
    commands,
    budget: {
      max_test_executions: maxVerificationSteps,
      max_immediate_duration_ms: 90_000,
      max_verification_turns: maxVerificationSteps,
      max_failed_test_turns: 2,
    },
  };
  const command = [
    process.execPath,
    hookScript,
    "--config", policyPath,
    "--state", statePath,
    "--ledger", ledgerPath,
  ].map((part) => JSON.stringify(part)).join(" ");
  const hook = { type: "command", timeout: 10, command };
  const hooks = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
      PostToolUse: [{ matcher: "Bash", hooks: [hook] }],
    },
  };
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(outputDir, 0o700);
  process.stdout.write(`${JSON.stringify({ policy: policyPath, hooks: hooksPath, state: statePath, ledger: ledgerPath })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
