import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditAgentBeltPilot } from "../src/pilot-audit.mjs";

const revision = "9".repeat(40);
const digest = "a".repeat(64);

const definitions = [
  { name: "l1_find_bug", tags: ["L1", "read-only"], duration: 39.29, files: [], commands: [shell("git status --short", 0)] },
  { name: "l2_add_completed_at", tags: ["L2", "feature"], duration: 116.62, files: ["src/models.py", "src/cli.py"], commands: [shell("pytest -q", 2), shell("PYTHONPATH=src pytest -q", 0)] },
  { name: "l2_fix_formatter_bug", tags: ["L2", "bugfix"], duration: 109.55, files: ["src/formatters.py", "tests/test_formatters.py"], commands: [shell("pytest -q", 2), shell("PYTHONPATH=src pytest -q", 1), shell("PYTHONPATH=src pytest -q", 0)] },
  { name: "l3_add_delete_command", tags: ["L3", "feature", "test-required"], duration: 87.88, files: ["src/cli.py", "src/storage.py", "tests/test_storage.py"], commands: [shell("pytest -q", 2), shell("PYTHONPATH=src pytest -q", 0)] },
  { name: "l3_add_json_format", tags: ["L3", "feature"], duration: 136.3, files: ["src/cli.py", "tests/test_cli.py"], commands: [shell("pytest -q", 2), shell("PYTHONPATH=src pytest -q", 1), shell("PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src pytest -q", 0)] },
];

function shell(command, exitCode) {
  return { name: "shell", args: { command: `/bin/zsh -lc '${command}'`, exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed" } };
}

function environment() {
  return {
    schema_version: 1,
    evidence_class: "benchmark_environment",
    benchmark_id: "agent-belt-pilot",
    repository: { identity: "jfrog/agent-belt", expected_revision: revision, observed_revision: revision, clean: true },
    conclusion: { status: "eligible", reasons: [] },
  };
}

function benchmarkCard() {
  return {
    run_id: "fixture-run",
    belt: { version: "0.2.1", git_sha: revision, git_dirty: null },
    scenarios: { scenario_files: definitions.map(({ name }) => ({ relpath: `${name}.json`, sha256: digest })) },
    agents: [{ agent: { name: "codex", adapter_class: "CodexAgentAdapter" }, cli: { version: "codex-cli 0.147.0" } }],
    summary: { total: 5, passed: 5, failed: 0, overall_pass: true },
  };
}

function results() {
  return {
    schema_version: "1",
    total: 5,
    passed: 5,
    failed: 0,
    overall_pass: true,
    agent_errors: null,
    judge_errors: null,
    setup_errors: [],
    cost_timing: {
      scenarios: definitions.map(({ name, duration }) => ({ scenario: `./${name}`, passed: true, total_seconds: duration })),
      total_seconds: 489.64,
    },
    scenarios: definitions.map(({ name, tags }) => ({ scenario_name: name, group: ".", tags, overall_pass: true })),
  };
}

function outcomes() {
  return new Map(definitions.map(({ name, duration, files, commands }) => [name, {
    schema_version: "1",
    has_error: false,
    files_modified: [...files],
    timing: { total: duration },
    tool_calls: structuredClone(commands),
  }]));
}

function sourceDigests() {
  return {
    benchmark_card: digest,
    results: digest,
    environment: digest,
    scenario_outputs: Object.fromEntries(definitions.map(({ name }) => [name, digest])),
  };
}

function input() {
  return { benchmarkCard: benchmarkCard(), results: results(), outcomes: outcomes(), environment: environment(), sourceDigests: sourceDigests() };
}

test("audits the real five-scenario pilot shape without granting a quality claim", () => {
  const report = auditAgentBeltPilot(input());
  assert.equal(report.conclusion.pilot_decision, "go");
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.equal(report.counts.test_runner_invocations, 10);
  assert.equal(report.counts.failed_test_runner_invocations, 6);
  assert.equal(report.counts.scenarios_with_unspecified_test_changes, 2);
  assert.equal(report.counts.scenarios_exceeding_test_invocation_budget, 2);
  assert.equal(report.counts.baseline_quality_claim_eligible_tasks, 0);
  assert.equal(report.timing.total_seconds, 489.64);
  assert.equal(report.scenarios.find(({ scenario_name }) => scenario_name === "l3_add_delete_command").test_change, "required");
  assert.doesNotMatch(JSON.stringify(report), /\/bin\/zsh|PYTHONPATH|auth\.json/);
});

test("generated runtime caches do not inflate changed-test budgets", () => {
  const auditInput = input();
  auditInput.outcomes.get("l2_add_completed_at").files_modified.push(
    "src/__pycache__/models.cpython-312.pyc",
    "tests/__pycache__/test_models.cpython-312-pytest.pyc",
  );
  const report = auditAgentBeltPilot(auditInput);
  const scenario = report.scenarios.find(({ scenario_name }) => scenario_name === "l2_add_completed_at");

  assert.equal(report.counts.ignored_generated_files, 2);
  assert.equal(scenario.ignored_generated_files, 2);
  assert.equal(scenario.test_files_modified.length, 0);
  assert.equal(scenario.budgets.test_file_exceeded, false);
  assert.doesNotMatch(JSON.stringify(report), /__pycache__|\.pyc/);
});

test("fails closed on missing or malformed scenario output", () => {
  const missing = input();
  missing.outcomes.delete("l2_fix_formatter_bug");
  assert.throws(() => auditAgentBeltPilot(missing), /missing output/);

  const malformed = input();
  malformed.outcomes.get("l2_fix_formatter_bug").tool_calls[0].args.exit_code = "2";
  assert.throws(() => auditAgentBeltPilot(malformed), /integer exit_code/);
});

test("rejects a run that does not match the qualified revision", () => {
  const mismatch = input();
  mismatch.benchmarkCard.belt.git_sha = "b".repeat(40);
  assert.throws(() => auditAgentBeltPilot(mismatch), /revision must match/);
});

test("rejects caller-declared quality claim eligibility", () => {
  const forged = input();
  forged.results.quality_claim_eligible = true;
  assert.throws(() => auditAgentBeltPilot(forged), /must not declare quality_claim_eligible/);
});

test("CLI writes a deterministic sanitized report", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-audit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = path.join(directory, "run");
  await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, "benchmark-card.json"), `${JSON.stringify(benchmarkCard(), null, 2)}\n`);
  await writeFile(path.join(runDirectory, "results.json"), `${JSON.stringify(results(), null, 2)}\n`);
  for (const [name, output] of outcomes()) {
    await mkdir(path.join(runDirectory, name));
    await writeFile(path.join(runDirectory, name, "turn_0_output.json"), `${JSON.stringify(output, null, 2)}\n`);
  }
  const environmentPath = path.join(directory, "environment.json");
  const outputPath = path.join(directory, "report.json");
  await writeFile(environmentPath, `${JSON.stringify(environment(), null, 2)}\n`);
  const args = ["src/pilot-audit-cli.mjs", "--run", runDirectory, "--environment", environmentPath, "--output", outputPath];
  execFileSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  const first = await readFile(outputPath, "utf8");
  execFileSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  const second = await readFile(outputPath, "utf8");
  assert.equal(second, first);
  assert.equal(JSON.parse(first).counts.failed_test_runner_invocations, 6);
});
