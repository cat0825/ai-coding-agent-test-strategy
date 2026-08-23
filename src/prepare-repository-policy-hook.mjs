#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TIERS = ["fast", "affected", "full"];

function usage() {
  return "Usage: prepare-repository-policy-hook --repo REPOSITORY --output-dir DIRECTORY [--fast SCRIPT] [--affected SCRIPT] [--full SCRIPT]\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--repo", "--output-dir", "--fast", "--affected", "--full"].includes(argument)) {
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

function scriptArgv(script) {
  return ["npm", "run", script];
}

function findScript(scripts, candidates) {
  return candidates.find((name) => typeof scripts[name] === "string") ?? null;
}

function inferTiers(scripts, overrides) {
  const full = overrides.full ?? findScript(scripts, ["check", "test", "test:all"]);
  const affected = overrides.affected ?? findScript(scripts, ["test:affected", "test:unit", "test"]);
  const fast = overrides.fast ?? findScript(scripts, ["test:unit", "test", "check"]);
  const selected = { fast, affected, full };
  for (const tier of TIERS) {
    if (!selected[tier]) throw new Error(`Cannot infer ${tier} verification script; provide --${tier} SCRIPT`);
  }
  return Object.fromEntries(TIERS.map((tier) => [tier, scriptArgv(selected[tier])]));
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return void process.stdout.write(usage());
  if (!options.repo || !options.output_dir) throw new Error(usage().trim());
  const repo = path.resolve(options.repo);
  const packageJson = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  const scripts = packageJson.scripts ?? {};
  const commands = inferTiers(scripts, options);
  const outputDir = path.resolve(options.output_dir);
  const stateDir = path.join(outputDir, "state");
  const policyPath = path.join(outputDir, "verification-policy.json");
  const hooksPath = path.join(outputDir, "hooks.json");
  const statePath = path.join(stateDir, "policy-state.json");
  const ledgerPath = path.join(stateDir, "policy-decisions.ndjson");
  const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verification-policy-hook.mjs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const policy = {
    schema_version: 1,
    policy: { name: "observatory-verification-policy", version: "0.3-rewrite" },
    task_id: `repository:${packageJson.name ?? "unknown"}`,
    mode: "shadow",
    behavior_class: "repository_general",
    risk_class: "medium",
    allow_full_suite: false,
    commands,
    budget: { max_test_executions: 2, max_immediate_duration_ms: 90_000, max_verification_turns: 2, max_failed_test_turns: 2 },
  };
  const command = [process.execPath, hookScript, "--config", policyPath, "--state", statePath, "--ledger", ledgerPath].map(JSON.stringify).join(" ");
  const hook = { type: "command", timeout: 10, command };
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(hooksPath, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }], PostToolUse: [{ matcher: "Bash", hooks: [hook] }] } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(outputDir, 0o700);
  process.stdout.write(`${JSON.stringify({ policy: policyPath, hooks: hooksPath, commands, inference: Object.fromEntries(TIERS.map((tier) => [tier, options[tier] ? "override" : "package_script"])) })}\n`);
}
main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
