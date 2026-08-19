import { createHash } from "node:crypto";
import path from "node:path";
import { stableJson } from "./benchmark-preflight.mjs";
import { isTestRunnerCommand } from "./test-command.mjs";

export const PILOT_AUDIT_SCHEMA_VERSION = 1;
export const PILOT_TEST_FILE_BUDGET = 1;
export const PILOT_TEST_INVOCATION_BUDGET = 2;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid agent-belt pilot evidence: ${message}`);
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!isObject(value)) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => containsKey(entry, key));
}

function assertNoDeclaredEligibility(value, label) {
  assert(!containsKey(value, "quality_claim_eligible"), `${label} must not declare quality_claim_eligible`);
}

function assertDigest(value, label) {
  assert(/^[a-f0-9]{64}$/i.test(value ?? ""), `${label} must be a SHA-256 digest`);
}

function normalizedRelativePath(value, label) {
  assert(nonEmptyString(value), `${label} must be a non-empty string`);
  const portable = value.replaceAll("\\", "/");
  assert(!path.posix.isAbsolute(portable) && !path.win32.isAbsolute(value), `${label} must be relative`);
  const normalized = path.posix.normalize(portable);
  assert(normalized !== ".." && !normalized.startsWith("../"), `${label} must not escape the workspace`);
  return normalized;
}

export function scenarioOutputRelativePath(scenarioName) {
  assert(nonEmptyString(scenarioName), "scenario_name must be a non-empty string");
  assert(/^[a-zA-Z0-9._-]+$/.test(scenarioName) && scenarioName !== "." && scenarioName !== "..", "scenario_name must be a safe path segment");
  return path.posix.join(scenarioName, "turn_0_output.json");
}

function isTestFile(filePath) {
  const segments = filePath.split("/");
  const basename = segments.at(-1).toLowerCase();
  return segments.some((segment) => ["test", "tests", "__tests__"].includes(segment.toLowerCase()))
    || basename.startsWith("test_")
    || /_test\.[^.]+$/.test(basename)
    || /\.(?:test|spec)\.[^.]+$/.test(basename);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function digestObject(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function validateSourceDigests(sourceDigests, scenarioNames) {
  assert(isObject(sourceDigests), "source_digests must be an object");
  for (const key of ["benchmark_card", "results", "environment"]) assertDigest(sourceDigests[key], `source_digests.${key}`);
  assert(isObject(sourceDigests.scenario_outputs), "source_digests.scenario_outputs must be an object");
  for (const name of scenarioNames) assertDigest(sourceDigests.scenario_outputs[name], `source_digests.scenario_outputs.${name}`);
}

function validateEnvironment(environment, benchmarkCard) {
  assert(isObject(environment), "environment must be an object");
  assert(environment.schema_version === 1 && environment.evidence_class === "benchmark_environment", "environment must be benchmark_environment schema v1");
  assert(environment.conclusion?.status === "eligible", "environment must be eligible");
  assert(environment.repository?.clean === true, "environment repository must be clean");
  assert(/^[a-f0-9]{40}$/i.test(environment.repository?.observed_revision ?? ""), "environment observed revision must be a Git SHA");
  assert(environment.repository.expected_revision === environment.repository.observed_revision, "environment expected and observed revisions must match");
  assert(benchmarkCard.belt?.git_sha === environment.repository.observed_revision, "benchmark card revision must match the environment manifest");
  assert(benchmarkCard.belt?.git_dirty === null || benchmarkCard.belt?.git_dirty === false, "benchmark card must identify a clean harness revision");
}

function validateRunSummary(benchmarkCard, results) {
  assert(isObject(benchmarkCard) && nonEmptyString(benchmarkCard.run_id), "benchmark card must include run_id");
  assert(nonEmptyString(benchmarkCard.belt?.version), "benchmark card must include belt version");
  assert(Array.isArray(benchmarkCard.agents) && benchmarkCard.agents.length > 0, "benchmark card must include at least one agent");
  assert(isObject(results) && String(results.schema_version) === "1", "results must use schema version 1");
  assert(Array.isArray(results.scenarios) && results.scenarios.length > 0, "results must include scenarios");
  for (const key of ["total", "passed", "failed"]) assert(Number.isInteger(results[key]) && results[key] >= 0, `results.${key} must be a non-negative integer`);
  assert(results.total === results.scenarios.length, "results.total must match the scenario list");
  assert(results.passed + results.failed === results.total, "results passed and failed counts must match total");
  assert(typeof results.overall_pass === "boolean", "results.overall_pass must be a boolean");
  assert(results.overall_pass === (results.failed === 0), "results.overall_pass must agree with failed count");
  for (const key of ["total", "passed", "failed", "overall_pass"]) {
    assert(benchmarkCard.summary?.[key] === results[key], `benchmark card summary ${key} must match results`);
  }
  assert(results.agent_errors === null, "results must not contain agent errors");
  assert(results.judge_errors === null, "results must not contain judge errors");
  assert(Array.isArray(results.setup_errors) && results.setup_errors.length === 0, "results must not contain setup errors");
}

function scenarioDefinitions(benchmarkCard, scenarioNames) {
  const files = benchmarkCard.scenarios?.scenario_files;
  assert(Array.isArray(files) && files.length === scenarioNames.length, "benchmark card scenario file count must match results");
  const definitions = new Map();
  for (const file of files) {
    assert(nonEmptyString(file?.relpath), "benchmark card scenario file must include relpath");
    assertDigest(file.sha256, `benchmark card scenario file ${file.relpath}`);
    const name = path.posix.basename(file.relpath, ".json");
    assert(!definitions.has(name), `duplicate benchmark card scenario definition ${name}`);
    definitions.set(name, file.sha256);
  }
  for (const name of scenarioNames) assert(definitions.has(name), `benchmark card is missing scenario definition ${name}`);
  return definitions;
}

function timingByScenario(results) {
  assert(Array.isArray(results.cost_timing?.scenarios), "results must include per-scenario timing");
  const timings = new Map();
  for (const timing of results.cost_timing.scenarios) {
    assert(nonEmptyString(timing?.scenario) && Number.isFinite(timing.total_seconds) && timing.total_seconds >= 0, "scenario timing must include a name and non-negative duration");
    const name = timing.scenario.replace(/^\.\//, "");
    assert(!timings.has(name), `duplicate timing for scenario ${name}`);
    timings.set(name, timing);
  }
  return timings;
}

function auditScenario(scenario, output, timing) {
  assert(isObject(scenario) && nonEmptyString(scenario.scenario_name), "scenario must include scenario_name");
  scenarioOutputRelativePath(scenario.scenario_name);
  assert(Array.isArray(scenario.tags) && scenario.tags.every(nonEmptyString), `scenario ${scenario.scenario_name} tags must be strings`);
  assert(typeof scenario.overall_pass === "boolean", `scenario ${scenario.scenario_name} overall_pass must be a boolean`);
  assert(isObject(output) && String(output.schema_version) === "1", `scenario ${scenario.scenario_name} output must use schema version 1`);
  assert(typeof output.has_error === "boolean", `scenario ${scenario.scenario_name} output must include has_error`);
  assert(!(scenario.overall_pass && output.has_error), `scenario ${scenario.scenario_name} cannot pass with an agent error`);
  assert(Array.isArray(output.files_modified), `scenario ${scenario.scenario_name} files_modified must be an array`);
  assert(Array.isArray(output.tool_calls), `scenario ${scenario.scenario_name} tool_calls must be an array`);
  assert(Number.isFinite(output.timing?.total) && output.timing.total >= 0, `scenario ${scenario.scenario_name} must include non-negative timing`);
  assert(Math.abs(output.timing.total - timing.total_seconds) < 0.02, `scenario ${scenario.scenario_name} timing must match results`);

  const filesModified = [...new Set(output.files_modified.map((file, index) => normalizedRelativePath(file, `scenario ${scenario.scenario_name} files_modified[${index}]`)))].sort();
  const testFilesModified = filesModified.filter(isTestFile);
  const shellCalls = output.tool_calls.filter((call) => call?.name === "shell");
  for (const [index, call] of shellCalls.entries()) {
    assert(nonEmptyString(call.args?.command), `scenario ${scenario.scenario_name} shell call ${index} must include command`);
    assert(Number.isInteger(call.args?.exit_code), `scenario ${scenario.scenario_name} shell call ${index} must include integer exit_code`);
  }
  const testRunnerCalls = shellCalls.filter((call) => isTestRunnerCommand(call.args.command));
  const failedTestRunnerCalls = testRunnerCalls.filter((call) => call.args.exit_code !== 0);
  const explicitlyRequired = scenario.tags.includes("test-required");
  const testChange = explicitlyRequired
    ? (testFilesModified.length > 0 ? "required" : "missing")
    : (testFilesModified.length > 0 ? "unspecified" : "none");

  return {
    scenario_name: scenario.scenario_name,
    tags: [...scenario.tags].sort(),
    passed: scenario.overall_pass,
    duration_seconds: round(output.timing.total),
    files_modified: filesModified,
    test_files_modified: testFilesModified,
    test_change: testChange,
    shell_invocations: shellCalls.length,
    test_runner_invocations: testRunnerCalls.length,
    failed_test_runner_invocations: failedTestRunnerCalls.length,
    budgets: {
      test_file_limit: PILOT_TEST_FILE_BUDGET,
      test_file_exceeded: testFilesModified.length > PILOT_TEST_FILE_BUDGET,
      test_invocation_limit: PILOT_TEST_INVOCATION_BUDGET,
      test_invocation_exceeded: testRunnerCalls.length > PILOT_TEST_INVOCATION_BUDGET,
    },
  };
}

export function auditAgentBeltPilot({ benchmarkCard, results, outcomes, environment, sourceDigests }) {
  for (const [label, value] of Object.entries({ benchmark_card: benchmarkCard, results, environment })) assertNoDeclaredEligibility(value, label);
  const outcomeMap = outcomes instanceof Map ? outcomes : new Map(Object.entries(outcomes ?? {}));
  for (const [name, output] of outcomeMap) assertNoDeclaredEligibility(output, `scenario output ${name}`);
  validateRunSummary(benchmarkCard, results);
  validateEnvironment(environment, benchmarkCard);

  const names = results.scenarios.map((scenario) => scenario.scenario_name);
  assert(new Set(names).size === names.length, "scenario names must be unique");
  for (const name of names) scenarioOutputRelativePath(name);
  const definitions = scenarioDefinitions(benchmarkCard, names);
  validateSourceDigests(sourceDigests, names);
  const timings = timingByScenario(results);
  assert(timings.size === names.length, "scenario timing count must match scenario count");
  for (const name of names) assert(outcomeMap.has(name), `missing output for scenario ${name}`);
  assert(outcomeMap.size === names.length, "scenario output count must match scenario count");

  const scenarios = results.scenarios.map((scenario) => {
    assert(timings.has(scenario.scenario_name), `missing timing for scenario ${scenario.scenario_name}`);
    return {
      ...auditScenario(scenario, outcomeMap.get(scenario.scenario_name), timings.get(scenario.scenario_name)),
      definition_sha256: definitions.get(scenario.scenario_name),
    };
  });
  const sum = (selector) => scenarios.reduce((total, scenario) => total + selector(scenario), 0);
  const rawDurationTotal = names.reduce((total, name) => total + outcomeMap.get(name).timing.total, 0);
  assert(Number.isFinite(results.cost_timing.total_seconds) && Math.abs(results.cost_timing.total_seconds - rawDurationTotal) < 0.02, "total timing must match per-scenario timing");
  const missingRequired = scenarios.filter((scenario) => scenario.test_change === "missing").length;
  const pilotGo = results.overall_pass && missingRequired === 0;

  return {
    schema_version: PILOT_AUDIT_SCHEMA_VERSION,
    evidence_class: "exploratory_pilot",
    pilot: {
      run_id: benchmarkCard.run_id,
      harness: {
        name: "agent-belt",
        version: benchmarkCard.belt.version,
        revision: benchmarkCard.belt.git_sha,
      },
      agents: benchmarkCard.agents.map((entry) => ({
        name: entry.agent?.name ?? "unknown",
        adapter: entry.agent?.adapter_class ?? "unknown",
        cli_version: entry.cli?.version ?? "unknown",
      })),
      environment: {
        benchmark_id: environment.benchmark_id,
        repository_identity: environment.repository.identity,
        repository_revision: environment.repository.observed_revision,
        manifest_digest: digestObject(environment),
      },
    },
    sources: {
      benchmark_card_sha256: sourceDigests.benchmark_card,
      results_sha256: sourceDigests.results,
      environment_sha256: sourceDigests.environment,
      scenario_outputs: [...names].sort().map((scenarioName) => ({
        scenario_name: scenarioName,
        sha256: sourceDigests.scenario_outputs[scenarioName],
      })),
    },
    counts: {
      scenarios: scenarios.length,
      passed_scenarios: scenarios.filter((scenario) => scenario.passed).length,
      failed_scenarios: scenarios.filter((scenario) => !scenario.passed).length,
      scenarios_with_explicit_test_requirement: scenarios.filter((scenario) => scenario.test_change === "required" || scenario.test_change === "missing").length,
      scenarios_with_test_file_changes: scenarios.filter((scenario) => scenario.test_files_modified.length > 0).length,
      scenarios_with_unspecified_test_changes: scenarios.filter((scenario) => scenario.test_change === "unspecified").length,
      scenarios_missing_required_tests: missingRequired,
      test_files_modified: sum((scenario) => scenario.test_files_modified.length),
      shell_invocations: sum((scenario) => scenario.shell_invocations),
      test_runner_invocations: sum((scenario) => scenario.test_runner_invocations),
      failed_test_runner_invocations: sum((scenario) => scenario.failed_test_runner_invocations),
      scenarios_exceeding_test_file_budget: scenarios.filter((scenario) => scenario.budgets.test_file_exceeded).length,
      scenarios_exceeding_test_invocation_budget: scenarios.filter((scenario) => scenario.budgets.test_invocation_exceeded).length,
      baseline_quality_claim_eligible_tasks: 0,
      required_baseline_tasks: 30,
      baseline_evidence_deficit: 30,
    },
    timing: {
      total_seconds: round(rawDurationTotal),
      mean_seconds: round(rawDurationTotal / scenarios.length),
    },
    scenarios,
    conclusion: {
      pilot_decision: pilotGo ? "go" : "stop",
      quality_claim_status: "evidence_insufficient",
      quality_claim_eligible: false,
      efficiency_claim: "blocked",
      reasons: [
        "complete_baseline_verifytrace_missing",
        "independent_oracle_missing",
        "paired_candidate_run_missing",
        "minimum_baseline_tasks_not_met",
      ],
    },
  };
}
