#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendLedger,
  collectChangedFiles,
  createVerificationPlan,
  loadPolicy,
  readLedger,
  readRepositoryCommit,
  validatePolicyCommands,
} from "./verifier.mjs";

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: verify.sh <fast|affected|full> --repo <path> --policy <path> [options]

Options:
  --base <ref>            Include committed changes since the base ref.
  --changed-file <path>   Use an explicit changed file; repeat as needed.
  --ledger <path>         JSONL ledger path.
  --task-id <id>          Stable task identifier for repeated observations.
  --mode <mode>           Observation mode: shadow (default) or baseline.
  --execute               Execute the planned commands. Default is plan-only shadow mode.
  --json                  Print the plan as JSON.
  --help                  Show this help.
`;
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help")) return { help: true };
  const phase = argv[0];
  const options = { phase, changedFiles: [], execute: false, json: false, mode: "shadow" };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--repo", "--policy", "--base", "--ledger", "--task-id", "--changed-file", "--mode"].includes(argument)) {
      const value = takeValue(argv, index, argument);
      index += 1;
      if (argument === "--changed-file") options.changedFiles.push(value);
      else options[argument.slice(2).replace("-", "")] = value;
    } else if (argument === "--execute") {
      options.execute = true;
    } else if (argument === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function defaultPolicyPath(repoRoot) {
  const name = path.basename(repoRoot);
  if (name.startsWith("maka-agent")) return path.join(toolRoot, "policies", "maka-agent.json");
  throw new Error("--policy is required for repositories without a bundled policy");
}

function sanitizeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function runCommand(argv, cwd) {
  const startedAt = new Date();
  const start = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      resolve({
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(durationMs),
        exitCode: code ?? 1,
        signal,
      });
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.repo) throw new Error("--repo is required");
  if (!["shadow", "baseline"].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }

  const repoRoot = path.resolve(options.repo);
  const policy = await loadPolicy(path.resolve(options.policy ?? defaultPolicyPath(repoRoot)));
  await validatePolicyCommands({ repoRoot, policy: policy.value });
  const ledgerPath = path.resolve(
    options.ledger ?? path.join(toolRoot, "output", "ledger", `${sanitizeName(path.basename(repoRoot))}.jsonl`),
  );
  const changedFiles =
    options.changedFiles.length > 0
      ? options.changedFiles
      : collectChangedFiles(repoRoot, options.base);
  const plan = await createVerificationPlan({
    repoRoot,
    policy: policy.value,
    requestedPhase: options.phase,
    changedFiles,
  });
  const taskId = options.taskid ?? `shadow-${Date.now()}`;
  const previousEvents = await readLedger(ledgerPath);
  const warnings = [...plan.warnings];

  for (const command of plan.commands) {
    const priorRuns = previousEvents.filter(
      (event) =>
        event.event === "command" &&
        event.task_id === taskId &&
        event.canonical_command_id === command.id,
    ).length;
    if (priorRuns >= 2) warnings.push(`budget_warning:${command.id}:prior_runs=${priorRuns}`);
  }

  const timestamp = new Date().toISOString();
  const common = {
    schema_version: 1,
    task_id: taskId,
    repository: repoRoot,
    repository_commit: readRepositoryCommit(repoRoot),
    policy_name: policy.value.name,
    policy_version: policy.version,
    mode: options.mode,
  };
  const outputPlan = { ...plan, warnings, ledgerPath, taskId };

  await appendLedger(ledgerPath, {
    ...common,
    event: "plan",
    created_at: timestamp,
    requested_phase: plan.requestedPhase,
    selected_phase: plan.selectedPhase,
    risk_level: plan.riskLevel,
    changed_files: plan.changedFiles,
    affected_workspaces: plan.affectedWorkspaces,
    fallback: plan.fallback,
    reasons: plan.reasons,
    warnings,
    commands: plan.commands,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outputPlan, null, 2)}\n`);
  } else {
    process.stdout.write(`mode: ${options.mode}\nphase: ${plan.requestedPhase} -> ${plan.selectedPhase}\n`);
    process.stdout.write(`risk: ${plan.riskLevel}\nfallback: ${plan.fallback}\n`);
    process.stdout.write(`changed files: ${plan.changedFiles.length}\n`);
    for (const reason of plan.reasons) process.stdout.write(`reason: ${reason}\n`);
    for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
    for (const command of plan.commands) process.stdout.write(`plan: ${command.argv.join(" ")}\n`);
    process.stdout.write(`ledger: ${ledgerPath}\n`);
  }

  if (!options.execute) return;

  for (const command of plan.commands) {
    const result = await runCommand(command.argv, repoRoot);
    await appendLedger(ledgerPath, {
      ...common,
      event: "command",
      canonical_command_id: command.id,
      command: command.argv,
      started_at: result.startedAt,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      signal: result.signal,
      failure_class: result.exitCode === 0 ? null : "unclassified",
      override: null,
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    if (result.exitCode !== 0) break;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
