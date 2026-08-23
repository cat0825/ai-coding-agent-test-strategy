#!/usr/bin/env node
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./verifier.mjs";

const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SHELL_OPERATOR = /[&|;<>(){}$`]/;
const PATH_LIKE = /\/|\.[cm]?[jt]sx?$/;

// Walk only from the literal prefix of the pattern, so a `test/*.test.mjs` target never
// descends into node_modules.
async function expandGlob(workspace, pattern) {
  const matcher = globToRegExp(pattern);
  const segments = pattern.split("/");
  const wildcardAt = segments.findIndex((segment) => /[*?[]/.test(segment));
  const base = segments.slice(0, wildcardAt).join("/");
  const recursive = pattern.includes("**") || segments.length - wildcardAt > 1;
  const names = await readdir(path.join(workspace, base || "."), { recursive }).catch(() => []);
  return names
    .map((name) => [base, name.split(path.sep).join("/")].filter(Boolean).join("/"))
    .filter((file) => matcher.test(file));
}

// `npm test` hides its selection inside package.json, so the file set the full tier would
// actually run can only be recovered by expanding the script the runner executes. The hook
// needs that set to recognise an exhaustive file enumeration as the full suite in disguise.
async function resolveFullSuiteTestFiles(workspace, full) {
  if (typeof workspace !== "string" || !workspace) return { files: null, reason: "workspace_not_in_task_manifest" };
  let tokens = full;
  if (SCRIPT_RUNNERS.has(full[0])) {
    const requested = full[1] === "run" ? full[2] : full[1];
    const script = requested === "t" ? "test" : requested;
    if (!script) return { files: null, reason: "script_name_unrecognized" };
    const manifest = await readFile(path.join(workspace, "package.json"), "utf8").then(JSON.parse).catch(() => null);
    const body = manifest?.scripts?.[script];
    if (typeof body !== "string") return { files: null, reason: `script_not_found:${script}` };
    if (SHELL_OPERATOR.test(body)) return { files: null, reason: "script_is_a_shell_pipeline" };
    tokens = body.split(/\s+/).filter(Boolean);
  }
  const targets = tokens.slice(1).filter((token) => !token.startsWith("-") && PATH_LIKE.test(token));
  if (targets.length === 0) return { files: null, reason: "no_test_targets_in_full_tier" };
  const files = new Set();
  for (const target of targets) {
    if (/[*?[]/.test(target)) {
      for (const entry of await expandGlob(workspace, target)) files.add(entry);
    } else {
      files.add(target);
    }
  }
  if (files.size === 0) return { files: null, reason: "full_tier_targets_matched_nothing" };
  return { files: [...files].sort(), reason: null };
}

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
  const fullSuite = await resolveFullSuiteTestFiles(manifest.workspace, commands.full);
  const policy = {
    schema_version: 1,
    policy: { name: "observatory-verification-policy", version: "0.3-rewrite" },
    task_id: manifest.task_id,
    mode: manifest.mode,
    behavior_class: task.behavior_class,
    risk_class: task.risk_class,
    allow_full_suite: task.behavior_class === "full_fallback" && task.risk_class === "high",
    commands,
    full_suite_test_files: fullSuite.files,
    full_suite_resolution: fullSuite.reason ?? "expanded_from_workspace",
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
