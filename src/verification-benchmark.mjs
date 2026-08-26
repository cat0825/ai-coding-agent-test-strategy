import { createHash } from "node:crypto";
import path from "node:path";
import { stableJson } from "./benchmark-preflight.mjs";

export const VERIFICATION_BENCHMARK_SCHEMA_VERSION = 1;
export const PILOT_TASK_COUNT = 6;

const MODES = new Set(["verify_only", "test_decision", "end_to_end"]);
const ORIGINS = new Set(["repository_change", "controlled_fault"]);
const FIXTURE_ORIGINS = new Set(["source_repository", "external_clone"]);
const RISK_CLASSES = new Set(["low", "medium", "high"]);
export const SCENARIO_CLASSES = Object.freeze([
  "cli_tool",
  "web_frontend",
  "service_library",
  "research_script",
]);
export const MINIMUM_GENERALIZED_SCENARIO_CLASSES = 2;
export const MINIMUM_EXTERNAL_REPOSITORIES = 3;
const LANGUAGES = new Set(["javascript", "typescript", "python", "go", "rust"]);
const PHASES = new Set(["fast", "affected", "full"]);
const WORKSPACE_STATUSES = new Set(["passed", "failed", "flaky", "environment_failed"]);
const FULL_SUITE_EXPECTATIONS = new Set(["avoid", "allowed", "required"]);
const EDIT_POLICIES = new Set(["forbidden", "allowed", "required"]);
const DECIDING_EVIDENCE = new Set(["trace_only"]);
const REQUIRED_BEHAVIOR_CLASSES = Object.freeze([
  "local_pass",
  "affected_failure",
  "full_fallback",
  "repeat_stop",
  "flaky_retry",
  "test_required",
]);
const HIDDEN_ORACLE_KEYS = new Set([
  "expected_workspace_status",
  "required_failure_signatures",
  "minimum_evidence_phase",
  "full_suite_expectation",
  "identical_retry_limit",
]);
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_REVISION = /^[a-f0-9]{40}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export class VerificationBenchmarkValidationError extends Error {
  constructor(errors) {
    super(`Invalid verification benchmark: ${errors.map(({ path: field, message }) => `${field} ${message}`).join("; ")}`);
    this.name = "VerificationBenchmarkValidationError";
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addError(errors, field, message) {
  errors.push({ path: field, message });
}

function requiredString(errors, value, field) {
  if (!nonEmptyString(value)) addError(errors, field, "must be a non-empty string");
}

function safeRelativePath(errors, value, field) {
  requiredString(errors, value, field);
  if (!nonEmptyString(value)) return;
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) addError(errors, field, "must stay inside the task workspace");
}

function validateCommand(errors, value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => !nonEmptyString(part))) {
    addError(errors, field, "must be a non-empty argv array");
  }
}

function containsHiddenOracleKey(value) {
  if (Array.isArray(value)) return value.some(containsHiddenOracleKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => HIDDEN_ORACLE_KEYS.has(key) || containsHiddenOracleKey(nested));
}

export function verificationTaskDefinitionDigest(definition) {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}

function validateFixtureOrigin(errors, fixture, field) {
  const origin = fixture.origin;
  if (!isObject(origin)) {
    addError(errors, `${field}.origin`, "must be an object");
    return;
  }
  if (!FIXTURE_ORIGINS.has(origin.kind)) {
    addError(errors, `${field}.origin.kind`, "must be source_repository or external_clone");
    return;
  }
  if (origin.kind === "source_repository") {
    if (origin.clone_url !== undefined) addError(errors, `${field}.origin.clone_url`, "does not apply to the source repository");
    return;
  }
  requiredString(errors, origin.clone_url, `${field}.origin.clone_url`);
  // A fixture may not vouch for itself. It points at a qualification report whose digest the
  // auditor recomputes, so eligibility always comes from observed preflight output.
  if (origin.eligible !== undefined || origin.status !== undefined) {
    addError(errors, `${field}.origin`, "must not declare its own qualification result");
  }
  if (!isObject(origin.qualification)) {
    addError(errors, `${field}.origin.qualification`, "must reference an external qualification report");
    return;
  }
  safeRelativePath(errors, origin.qualification.path, `${field}.origin.qualification.path`);
  if (!SHA256.test(origin.qualification.sha256 ?? "")) addError(errors, `${field}.origin.qualification.sha256`, "must be a SHA-256 digest");
  requiredString(errors, origin.qualification.fixture_id, `${field}.origin.qualification.fixture_id`);
}

function validateFixture(errors, fixture, index, fixtureIds) {
  const field = `fixtures[${index}]`;
  if (!isObject(fixture)) {
    addError(errors, field, "must be an object");
    return;
  }
  requiredString(errors, fixture.fixture_id, `${field}.fixture_id`);
  if (fixtureIds.has(fixture.fixture_id)) addError(errors, `${field}.fixture_id`, "must be unique");
  fixtureIds.add(fixture.fixture_id);
  requiredString(errors, fixture.repository?.identity, `${field}.repository.identity`);
  if (!GIT_REVISION.test(fixture.repository?.revision ?? "")) addError(errors, `${field}.repository.revision`, "must be a 40-character Git revision");
  validateFixtureOrigin(errors, fixture, field);
  requiredString(errors, fixture.runtime, `${field}.runtime`);
  if (!SCENARIO_CLASSES.includes(fixture.scenario_class)) {
    addError(errors, `${field}.scenario_class`, `must be one of ${SCENARIO_CLASSES.join(", ")}`);
  }
  if (!LANGUAGES.has(fixture.language)) addError(errors, `${field}.language`, "must be a supported task language");
  if (fixture.reset_strategy !== "fresh_isolated_clone") addError(errors, `${field}.reset_strategy`, "must be fresh_isolated_clone");
}

function validateSource(errors, source, field) {
  if (!isObject(source)) {
    addError(errors, field, "must be an object");
    return;
  }
  if (!ORIGINS.has(source.kind)) addError(errors, `${field}.kind`, "must be repository_change or controlled_fault");
  if (!GIT_REVISION.test(source.base_revision ?? "")) addError(errors, `${field}.base_revision`, "must be a 40-character Git revision");
  if (source.kind === "repository_change") {
    if (!GIT_REVISION.test(source.change_revision ?? "")) addError(errors, `${field}.change_revision`, "must be a 40-character Git revision");
    if (source.change_revision === source.base_revision) addError(errors, `${field}.change_revision`, "must differ from base_revision");
  } else {
    requiredString(errors, source.setup_id, `${field}.setup_id`);
  }
}

function validateTask(errors, task, index, fixtureById, taskIds, semanticKeys, oracleIds, behaviorClassesByFixture) {
  const field = `tasks[${index}]`;
  if (!isObject(task)) {
    addError(errors, field, "must be an object");
    return;
  }
  requiredString(errors, task.task_id, `${field}.task_id`);
  if (nonEmptyString(task.task_id) && !SAFE_ID.test(task.task_id)) addError(errors, `${field}.task_id`, "must be a safe lowercase identifier");
  requiredString(errors, task.semantic_task_key, `${field}.semantic_task_key`);
  if (taskIds.has(task.task_id)) addError(errors, `${field}.task_id`, "must be unique");
  if (semanticKeys.has(task.semantic_task_key)) addError(errors, `${field}.semantic_task_key`, "must be unique");
  taskIds.add(task.task_id);
  semanticKeys.add(task.semantic_task_key);
  if (!MODES.has(task.mode)) addError(errors, `${field}.mode`, "must be verify_only, test_decision, or end_to_end");
  if (!REQUIRED_BEHAVIOR_CLASSES.includes(task.behavior_class)) addError(errors, `${field}.behavior_class`, "is not a pilot behavior class");
  const fixture = fixtureById.get(task.fixture_id);
  if (!fixture) addError(errors, `${field}.fixture_id`, "must reference a declared fixture");
  // A behavior class is unique per fixture, not per plan, so the same behavior can be
  // re-observed on another repository without colliding with the six-task pilot.
  let seenForFixture = behaviorClassesByFixture.get(task.fixture_id);
  if (!seenForFixture) {
    seenForFixture = new Set();
    behaviorClassesByFixture.set(task.fixture_id, seenForFixture);
  }
  if (seenForFixture.has(task.behavior_class)) addError(errors, `${field}.behavior_class`, "must be unique within its fixture");
  seenForFixture.add(task.behavior_class);
  if (!RISK_CLASSES.has(task.risk_class)) addError(errors, `${field}.risk_class`, "must be low, medium, or high");
  requiredString(errors, task.oracle_id, `${field}.oracle_id`);
  if (oracleIds.has(task.oracle_id)) addError(errors, `${field}.oracle_id`, "must be unique");
  oracleIds.add(task.oracle_id);
  if (!isObject(task.definition)) {
    addError(errors, `${field}.definition`, "must be an object");
    return;
  }
  if (containsHiddenOracleKey(task.definition)) addError(errors, `${field}.definition`, "must not expose hidden oracle expectations");
  requiredString(errors, task.definition.instruction, `${field}.definition.instruction`);
  validateSource(errors, task.definition.source, `${field}.definition.source`);
  // Qualification was observed at one revision of the external repository, so a task on that
  // fixture has to be built at exactly that revision for the qualification to transfer.
  if (fixture?.origin?.kind === "external_clone" && isObject(task.definition.source)
    && task.definition.source.base_revision !== fixture.repository?.revision) {
    addError(errors, `${field}.definition.source.base_revision`, "must be the pinned fixture revision");
  }
  if (!Array.isArray(task.definition.changed_files) || task.definition.changed_files.length === 0) {
    addError(errors, `${field}.definition.changed_files`, "must contain at least one path");
  } else {
    task.definition.changed_files.forEach((value, changedIndex) => safeRelativePath(errors, value, `${field}.definition.changed_files[${changedIndex}]`));
  }
  if (!isObject(task.definition.command_tiers)) {
    addError(errors, `${field}.definition.command_tiers`, "must be an object");
  } else {
    const seenCommands = new Set();
    for (const phase of PHASES) {
      const command = task.definition.command_tiers[phase];
      validateCommand(errors, command, `${field}.definition.command_tiers.${phase}`);
      const serialized = JSON.stringify(command);
      if (seenCommands.has(serialized)) addError(errors, `${field}.definition.command_tiers.${phase}`, "must differ from the other command tiers");
      seenCommands.add(serialized);
    }
  }
  if (!SHA256.test(task.scenario_definition_sha256 ?? "")) {
    addError(errors, `${field}.scenario_definition_sha256`, "must be a SHA-256 digest");
  } else if (verificationTaskDefinitionDigest(task.definition) !== task.scenario_definition_sha256) {
    addError(errors, `${field}.scenario_definition_sha256`, "does not match the public task definition");
  }
  if (task.quality_claim_eligible !== undefined || task.status !== undefined) {
    addError(errors, field, "must not declare collection status or quality eligibility");
  }
}

function validateOracle(errors, oracle, index, taskById, seenOracleIds, seenTaskIds) {
  const field = `oracles[${index}]`;
  if (!isObject(oracle)) {
    addError(errors, field, "must be an object");
    return;
  }
  requiredString(errors, oracle.oracle_id, `${field}.oracle_id`);
  requiredString(errors, oracle.task_id, `${field}.task_id`);
  if (seenOracleIds.has(oracle.oracle_id)) addError(errors, `${field}.oracle_id`, "must be unique");
  if (seenTaskIds.has(oracle.task_id)) addError(errors, `${field}.task_id`, "must be unique");
  seenOracleIds.add(oracle.oracle_id);
  seenTaskIds.add(oracle.task_id);
  const task = taskById.get(oracle.task_id);
  if (!task) addError(errors, `${field}.task_id`, "must reference a public pilot task");
  if (task && task.oracle_id !== oracle.oracle_id) addError(errors, `${field}.oracle_id`, "must match the task oracle_id");
  if (!WORKSPACE_STATUSES.has(oracle.expected_workspace_status)) addError(errors, `${field}.expected_workspace_status`, "is unsupported");
  if (!Array.isArray(oracle.required_failure_signatures) || oracle.required_failure_signatures.some((value) => !nonEmptyString(value))) {
    addError(errors, `${field}.required_failure_signatures`, "must be an array of non-empty strings");
  }
  if (oracle.expected_workspace_status === "passed" && oracle.required_failure_signatures?.length !== 0) {
    addError(errors, `${field}.required_failure_signatures`, "must be empty for a passing workspace");
  }
  if (["failed", "flaky", "environment_failed"].includes(oracle.expected_workspace_status)
    && oracle.required_failure_signatures?.length === 0) {
    addError(errors, `${field}.required_failure_signatures`, "must identify the expected failure");
  }
  // A hidden oracle re-runs commands on a post-run copy. When the behaviour it must observe was already
  // consumed by the agent's own run, re-execution cannot reproduce it, so the oracle would report `failed`
  // for a structural reason rather than because the agent did anything wrong. Such an oracle must say so
  // explicitly and name the evidence that decides the task instead.
  if (typeof oracle.post_run_decidable !== "boolean") {
    addError(errors, `${field}.post_run_decidable`, "must be a boolean");
  }
  if (oracle.post_run_decidable === false) {
    if (!nonEmptyString(oracle.undecidable_reason)) {
      addError(errors, `${field}.undecidable_reason`, "must explain why re-execution cannot reproduce the behaviour");
    }
    if (!DECIDING_EVIDENCE.has(oracle.deciding_evidence)) {
      addError(errors, `${field}.deciding_evidence`, "must be trace_only when the oracle cannot decide");
    }
  } else if (oracle.post_run_decidable === true) {
    if (oracle.undecidable_reason !== undefined) {
      addError(errors, `${field}.undecidable_reason`, "must be absent for a decidable oracle");
    }
    if (oracle.deciding_evidence !== "independent_oracle") {
      addError(errors, `${field}.deciding_evidence`, "must be independent_oracle for a decidable oracle");
    }
  }
  if (!PHASES.has(oracle.minimum_evidence_phase)) addError(errors, `${field}.minimum_evidence_phase`, "must be fast, affected, or full");
  if (!FULL_SUITE_EXPECTATIONS.has(oracle.full_suite_expectation)) addError(errors, `${field}.full_suite_expectation`, "must be avoid, allowed, or required");
  if (!Number.isInteger(oracle.identical_retry_limit) || oracle.identical_retry_limit < 0 || oracle.identical_retry_limit > 1) {
    addError(errors, `${field}.identical_retry_limit`, "must be 0 or 1");
  }
  if (!EDIT_POLICIES.has(oracle.production_edits)) addError(errors, `${field}.production_edits`, "must be forbidden, allowed, or required");
  if (!EDIT_POLICIES.has(oracle.test_edits)) addError(errors, `${field}.test_edits`, "must be forbidden, allowed, or required");
  requiredString(errors, oracle.independent_oracle_id, `${field}.independent_oracle_id`);
  if (!Array.isArray(oracle.reference_test_paths)) {
    addError(errors, `${field}.reference_test_paths`, "must be an array");
  } else {
    oracle.reference_test_paths.forEach((value, pathIndex) => safeRelativePath(errors, value, `${field}.reference_test_paths[${pathIndex}]`));
  }
  if (task?.mode === "verify_only" && oracle.production_edits !== "forbidden") addError(errors, `${field}.production_edits`, "must be forbidden for verify_only tasks");
  if (task?.behavior_class === "test_required" && oracle.test_edits !== "required") addError(errors, `${field}.test_edits`, "must be required for test_required");
  if (task?.behavior_class === "test_required" && oracle.reference_test_paths?.length === 0) addError(errors, `${field}.reference_test_paths`, "must provide a hidden developer test for test_required");
  if (task?.behavior_class === "flaky_retry" && oracle.identical_retry_limit !== 1) addError(errors, `${field}.identical_retry_limit`, "must allow exactly one retry for flaky_retry");
  // The flaky marker is consumed by the agent's first run, so a post-run re-execution always passes twice and
  // can never reproduce the fail-then-pass pattern this class is defined by.
  if (task?.behavior_class === "flaky_retry" && oracle.post_run_decidable !== false) {
    addError(errors, `${field}.post_run_decidable`, "must be false for flaky_retry: the marker is consumed before the oracle runs");
  }
  if (task?.behavior_class === "repeat_stop" && oracle.identical_retry_limit !== 0) addError(errors, `${field}.identical_retry_limit`, "must forbid an identical retry for repeat_stop");
  if (task?.behavior_class === "full_fallback" && oracle.full_suite_expectation !== "required") addError(errors, `${field}.full_suite_expectation`, "must be required for full_fallback");
  // Qualification checks a repair task by materializing the workspace both with and without the change and
  // requiring the unchanged tree to be green -- that tree only stands in for a correctly repaired workspace
  // when the change is the defect being repaired. Under `repository_change` the change is the subject under
  // test rather than a defect, so the unchanged tree would be a different task, and a passing qualification
  // would mean nothing about the task actually posed.
  if (oracle.production_edits === "required" && task?.definition?.source?.kind !== "controlled_fault") {
    addError(errors, `${field}.production_edits`, "may only be required for a controlled_fault task");
  }
  // Hidden reference tests drive their own qualification pattern, which expects the changed tree to be the
  // green one. That is the exact inverse of a repair task. Rejected rather than ordered, so neither pattern
  // can silently qualify a task the other was meant to check.
  if (oracle.production_edits === "required" && oracle.reference_test_paths?.length > 0) {
    addError(errors, `${field}.reference_test_paths`, "must be empty when production_edits is required");
  }
}

export function validateVerificationBenchmark(plan, oracleCatalog) {
  const errors = [];
  if (!isObject(plan)) return [{ path: "plan", message: "must be an object" }];
  if (!isObject(oracleCatalog)) return [{ path: "oracle_catalog", message: "must be an object" }];
  if (plan.schema_version !== VERIFICATION_BENCHMARK_SCHEMA_VERSION) addError(errors, "schema_version", `must be ${VERIFICATION_BENCHMARK_SCHEMA_VERSION}`);
  if (oracleCatalog.schema_version !== VERIFICATION_BENCHMARK_SCHEMA_VERSION) addError(errors, "oracle_catalog.schema_version", `must be ${VERIFICATION_BENCHMARK_SCHEMA_VERSION}`);
  requiredString(errors, plan.benchmark_id, "benchmark_id");
  if (oracleCatalog.benchmark_id !== plan.benchmark_id) addError(errors, "oracle_catalog.benchmark_id", "must match the public plan");
  if (plan.evidence_class !== "pilot_design") addError(errors, "evidence_class", "must be pilot_design");
  if (oracleCatalog.evidence_class !== "hidden_oracle_design") addError(errors, "oracle_catalog.evidence_class", "must be hidden_oracle_design");
  if (plan.minimum_pilot_tasks !== PILOT_TASK_COUNT) addError(errors, "minimum_pilot_tasks", `must be ${PILOT_TASK_COUNT}`);
  if (plan.quality_claim_eligible !== undefined || oracleCatalog.quality_claim_eligible !== undefined) {
    addError(errors, "quality_claim_eligible", "is auditor-derived and must not be declared");
  }
  requiredString(errors, plan.target_claim, "target_claim");

  if (!Array.isArray(plan.fixtures) || plan.fixtures.length === 0) addError(errors, "fixtures", "must be a non-empty array");
  const fixtureIds = new Set();
  (plan.fixtures ?? []).forEach((fixture, index) => validateFixture(errors, fixture, index, fixtureIds));
  const fixtureById = new Map((plan.fixtures ?? []).filter(isObject).map((fixture) => [fixture.fixture_id, fixture]));
  const sourceFixtures = (plan.fixtures ?? []).filter((fixture) => fixture?.origin?.kind === "source_repository");
  if (sourceFixtures.length !== 1) addError(errors, "fixtures", "must declare exactly one source_repository fixture");

  if (!Array.isArray(plan.tasks) || plan.tasks.length < PILOT_TASK_COUNT) addError(errors, "tasks", `must contain at least ${PILOT_TASK_COUNT} tasks`);
  const taskIds = new Set();
  const semanticKeys = new Set();
  const oracleIds = new Set();
  const behaviorClassesByFixture = new Map();
  (plan.tasks ?? []).forEach((task, index) => validateTask(errors, task, index, fixtureById, taskIds, semanticKeys, oracleIds, behaviorClassesByFixture));
  // The six-task pilot lives on the source repository. External fixtures add tasks on top of
  // it, so the pilot contract is checked against that fixture instead of the whole plan.
  const pilotFixtureId = sourceFixtures[0]?.fixture_id;
  const pilotTasks = (plan.tasks ?? []).filter((task) => task?.fixture_id === pilotFixtureId);
  if (pilotFixtureId !== undefined && pilotTasks.length !== PILOT_TASK_COUNT) {
    addError(errors, "tasks", `must contain exactly ${PILOT_TASK_COUNT} tasks on the source_repository fixture`);
  }
  const pilotBehaviorClasses = behaviorClassesByFixture.get(pilotFixtureId) ?? new Set();
  for (const behaviorClass of REQUIRED_BEHAVIOR_CLASSES) {
    if (!pilotBehaviorClasses.has(behaviorClass)) addError(errors, "tasks", `must include behavior_class ${behaviorClass}`);
  }

  if (!Array.isArray(oracleCatalog.oracles) || oracleCatalog.oracles.length !== (plan.tasks?.length ?? 0)) {
    addError(errors, "oracle_catalog.oracles", "must contain exactly one oracle per task");
  }
  const taskById = new Map((plan.tasks ?? []).map((task) => [task.task_id, task]));
  const seenOracleIds = new Set();
  const seenOracleTaskIds = new Set();
  (oracleCatalog.oracles ?? []).forEach((oracle, index) => validateOracle(errors, oracle, index, taskById, seenOracleIds, seenOracleTaskIds));
  for (const taskId of taskIds) {
    if (!seenOracleTaskIds.has(taskId)) addError(errors, "oracle_catalog.oracles", `missing oracle for ${taskId}`);
  }
  return errors;
}

function scenarioClassCounts(plan) {
  const scenarioClassByFixture = new Map(plan.fixtures.map((fixture) => [fixture.fixture_id, fixture.scenario_class]));
  const counts = {};
  for (const task of plan.tasks) {
    const scenarioClass = scenarioClassByFixture.get(task.fixture_id);
    counts[scenarioClass] = (counts[scenarioClass] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function externalRepositoryCoverage(plan) {
  const taskCountByFixture = new Map();
  for (const task of plan.tasks) {
    taskCountByFixture.set(task.fixture_id, (taskCountByFixture.get(task.fixture_id) ?? 0) + 1);
  }
  const repositories = plan.fixtures
    .filter((fixture) => fixture.origin.kind === "external_clone")
    .map((fixture) => ({
      fixture_id: fixture.fixture_id,
      identity: fixture.repository.identity,
      revision: fixture.repository.revision,
      scenario_class: fixture.scenario_class,
      qualification: fixture.origin.qualification,
      tasks: taskCountByFixture.get(fixture.fixture_id) ?? 0,
    }))
    .sort((left, right) => left.fixture_id.localeCompare(right.fixture_id));
  return {
    minimum: MINIMUM_EXTERNAL_REPOSITORIES,
    qualified: repositories.length,
    // A fixture with no task contributes no observation, so it is counted separately from
    // the repositories that tasks are actually authored against.
    with_tasks: repositories.filter(({ tasks }) => tasks > 0).length,
    repositories,
    satisfied: repositories.length >= MINIMUM_EXTERNAL_REPOSITORIES,
  };
}

export function auditVerificationBenchmarkDesign(plan, oracleCatalog) {
  const errors = validateVerificationBenchmark(plan, oracleCatalog);
  if (errors.length > 0) throw new VerificationBenchmarkValidationError(errors);
  const modeCounts = Object.fromEntries([...MODES].map((mode) => [mode, plan.tasks.filter((task) => task.mode === mode).length]));
  const coveredScenarioClasses = Object.keys(scenarioClassCounts(plan));
  const externalRepositories = externalRepositoryCoverage(plan);
  const blockers = [
    "task_workspaces_not_materialized",
    "independent_oracles_not_executed",
    "paired_traces_not_collected",
  ];
  if (coveredScenarioClasses.length < MINIMUM_GENERALIZED_SCENARIO_CLASSES) blockers.push("scenario_classes_not_generalized");
  if (!externalRepositories.satisfied) blockers.push("external_repositories_below_minimum");
  return {
    schema_version: VERIFICATION_BENCHMARK_SCHEMA_VERSION,
    evidence_class: "pilot_design_audit",
    benchmark_id: plan.benchmark_id,
    target_claim: plan.target_claim,
    counts: {
      tasks: plan.tasks.length,
      fixtures: plan.fixtures.length,
      external_repositories: externalRepositories.qualified,
      hidden_oracles: oracleCatalog.oracles.length,
      modes: modeCounts,
      behavior_classes: [...new Set(plan.tasks.map((task) => task.behavior_class))].sort(),
      scenario_classes: scenarioClassCounts(plan),
      languages: [...new Set(plan.fixtures.map((fixture) => fixture.language))].sort(),
    },
    scenario_coverage: {
      covered: coveredScenarioClasses,
      missing: SCENARIO_CLASSES.filter((scenarioClass) => !coveredScenarioClasses.includes(scenarioClass)),
      generalized: coveredScenarioClasses.length >= MINIMUM_GENERALIZED_SCENARIO_CLASSES,
    },
    external_repository_coverage: externalRepositories,
    conclusion: {
      status: "design_ready",
      quality_claim_eligible: false,
      blockers,
    },
  };
}
