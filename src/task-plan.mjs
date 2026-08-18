import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stableJson } from "./benchmark-preflight.mjs";

export const TASK_PLAN_SCHEMA_VERSION = 1;
export const EXPECTED_EXPERIENCE_SCENARIOS = 41;
export const MINIMUM_PLANNED_TASKS = 30;

const execFileAsync = promisify(execFile);
const DECISIONS = new Set(["selected", "rejected"]);
const ORIGINS = new Set(["agent-belt-experience", "controlled"]);
const RISK_CLASSES = new Set(["low", "medium", "high"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_REVISION = /^[a-f0-9]{40}$/i;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class TaskPlanValidationError extends Error {
  constructor(errors) {
    super(`Invalid task plan: ${errors.map(({ path: field, message }) => `${field} ${message}`).join("; ")}`);
    this.name = "TaskPlanValidationError";
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

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function definitionDigest(definition) {
  return hash(stableJson(definition));
}

function safeRelativePath(errors, value, field) {
  requiredString(errors, value, field);
  if (!nonEmptyString(value)) return;
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) addError(errors, field, "must stay inside the declared root");
}

function validateCommand(errors, command, field) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => !nonEmptyString(part))) {
    addError(errors, field, "must be a non-empty argv array");
  }
}

export function validateTaskPlan(plan) {
  const errors = [];
  if (!isObject(plan)) return [{ path: "plan", message: "must be an object" }];
  if (plan.schema_version !== TASK_PLAN_SCHEMA_VERSION) addError(errors, "schema_version", `must be ${TASK_PLAN_SCHEMA_VERSION}`);
  requiredString(errors, plan.plan_id, "plan_id");
  if (plan.evidence_class !== "planning") addError(errors, "evidence_class", "must be planning");
  if (plan.quality_claim_eligible !== undefined) addError(errors, "quality_claim_eligible", "is auditor-derived and must not be declared");
  if (!isObject(plan.source_repository)) {
    addError(errors, "source_repository", "must be an object");
  } else {
    requiredString(errors, plan.source_repository.identity, "source_repository.identity");
    if (!GIT_REVISION.test(plan.source_repository.revision ?? "")) addError(errors, "source_repository.revision", "must be a 40-character Git revision");
  }
  if (plan.expected_experience_scenarios !== EXPECTED_EXPERIENCE_SCENARIOS) {
    addError(errors, "expected_experience_scenarios", `must be ${EXPECTED_EXPERIENCE_SCENARIOS}`);
  }
  if (plan.minimum_planned_tasks !== MINIMUM_PLANNED_TASKS) addError(errors, "minimum_planned_tasks", `must be ${MINIMUM_PLANNED_TASKS}`);

  if (!Array.isArray(plan.fixtures) || plan.fixtures.length < 2) {
    addError(errors, "fixtures", "must include at least two fixtures");
  }
  const fixtureIds = new Set();
  for (const [index, fixture] of (plan.fixtures ?? []).entries()) {
    const field = `fixtures[${index}]`;
    if (!isObject(fixture)) {
      addError(errors, field, "must be an object");
      continue;
    }
    requiredString(errors, fixture.fixture_id, `${field}.fixture_id`);
    if (fixtureIds.has(fixture.fixture_id)) addError(errors, `${field}.fixture_id`, "must be unique");
    fixtureIds.add(fixture.fixture_id);
    safeRelativePath(errors, fixture.source_path, `${field}.source_path`);
    if (fixture.repository_scope !== "fixture" && fixture.repository_scope !== "source_repository") {
      addError(errors, `${field}.repository_scope`, "must be fixture or source_repository");
    }
    if (!GIT_REVISION.test(fixture.revision ?? "")) addError(errors, `${field}.revision`, "must be a 40-character Git revision");
    if (!Array.isArray(fixture.reset_commands) || fixture.reset_commands.length === 0) {
      addError(errors, `${field}.reset_commands`, "must contain at least one command");
    } else {
      fixture.reset_commands.forEach((command, commandIndex) => validateCommand(errors, command, `${field}.reset_commands[${commandIndex}]`));
    }
    validateCommand(errors, fixture.test_command, `${field}.test_command`);
    if (fixture.environment !== undefined) {
      if (!isObject(fixture.environment)) {
        addError(errors, `${field}.environment`, "must be an object");
      } else {
        for (const [name, value] of Object.entries(fixture.environment)) {
          if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /(KEY|TOKEN|SECRET|PASSWORD)/.test(name)) addError(errors, `${field}.environment.${name}`, "must be a non-sensitive environment name");
          requiredString(errors, value, `${field}.environment.${name}`);
        }
      }
    }
  }

  if (!Array.isArray(plan.audited_scenarios) || plan.audited_scenarios.length !== EXPECTED_EXPERIENCE_SCENARIOS) {
    addError(errors, "audited_scenarios", `must contain exactly ${EXPECTED_EXPERIENCE_SCENARIOS} entries`);
  }
  const sourceIds = new Set();
  const sourcePaths = new Set();
  const selectedSourceIds = new Set();
  const selectedSourceDigests = new Map();
  for (const [index, scenario] of (plan.audited_scenarios ?? []).entries()) {
    const field = `audited_scenarios[${index}]`;
    if (!isObject(scenario)) {
      addError(errors, field, "must be an object");
      continue;
    }
    requiredString(errors, scenario.source_id, `${field}.source_id`);
    safeRelativePath(errors, scenario.path, `${field}.path`);
    if (!SHA256.test(scenario.scenario_definition_sha256 ?? "")) addError(errors, `${field}.scenario_definition_sha256`, "must be a SHA-256 digest");
    if (!DECISIONS.has(scenario.decision)) addError(errors, `${field}.decision`, "must be selected or rejected");
    requiredString(errors, scenario.reason_code, `${field}.reason_code`);
    requiredString(errors, scenario.rationale, `${field}.rationale`);
    if (sourceIds.has(scenario.source_id)) addError(errors, `${field}.source_id`, "must be unique");
    if (sourcePaths.has(scenario.path)) addError(errors, `${field}.path`, "must be unique");
    sourceIds.add(scenario.source_id);
    sourcePaths.add(scenario.path);
    if (scenario.decision === "selected") {
      selectedSourceIds.add(scenario.source_id);
      selectedSourceDigests.set(scenario.source_id, scenario.scenario_definition_sha256);
    }
  }

  if (!Array.isArray(plan.tasks) || plan.tasks.length < MINIMUM_PLANNED_TASKS) {
    addError(errors, "tasks", `must contain at least ${MINIMUM_PLANNED_TASKS} tasks`);
  }
  const taskIds = new Set();
  const semanticKeys = new Set();
  const representedFixtures = new Set();
  const representedSources = new Set();
  for (const [index, task] of (plan.tasks ?? []).entries()) {
    const field = `tasks[${index}]`;
    if (!isObject(task)) {
      addError(errors, field, "must be an object");
      continue;
    }
    requiredString(errors, task.task_id, `${field}.task_id`);
    requiredString(errors, task.semantic_task_key, `${field}.semantic_task_key`);
    if (taskIds.has(task.task_id)) addError(errors, `${field}.task_id`, "must be unique");
    if (semanticKeys.has(task.semantic_task_key)) addError(errors, `${field}.semantic_task_key`, "must be unique; trials and agent variants do not create distinct tasks");
    taskIds.add(task.task_id);
    semanticKeys.add(task.semantic_task_key);
    if (!ORIGINS.has(task.origin)) addError(errors, `${field}.origin`, "must be agent-belt-experience or controlled");
    if (!fixtureIds.has(task.fixture_id)) addError(errors, `${field}.fixture_id`, "must reference a declared fixture");
    representedFixtures.add(task.fixture_id);
    if (!RISK_CLASSES.has(task.risk_class)) addError(errors, `${field}.risk_class`, "must be low, medium, or high");
    requiredString(errors, task.inclusion_rationale, `${field}.inclusion_rationale`);
    requiredString(errors, task.explicit_test_requirement, `${field}.explicit_test_requirement`);
    requiredString(errors, task.oracle_id, `${field}.oracle_id`);
    if (!SHA256.test(task.scenario_definition_sha256 ?? "")) addError(errors, `${field}.scenario_definition_sha256`, "must be a SHA-256 digest");
    if (task.status !== undefined) addError(errors, `${field}.status`, "is collection evidence and must not be declared in a planning manifest");
    if (task.quality_claim_eligible !== undefined) addError(errors, `${field}.quality_claim_eligible`, "is auditor-derived and must not be declared");
    if (task.origin === "agent-belt-experience") {
      requiredString(errors, task.source_scenario_id, `${field}.source_scenario_id`);
      if (!selectedSourceIds.has(task.source_scenario_id)) addError(errors, `${field}.source_scenario_id`, "must reference a selected audited scenario");
      if (selectedSourceDigests.get(task.source_scenario_id) !== task.scenario_definition_sha256) {
        addError(errors, `${field}.scenario_definition_sha256`, "must match the selected audited scenario");
      }
      representedSources.add(task.source_scenario_id);
    } else {
      if (!isObject(task.definition)) addError(errors, `${field}.definition`, "must be an object for a controlled task");
      else if (definitionDigest(task.definition) !== task.scenario_definition_sha256) addError(errors, `${field}.scenario_definition_sha256`, "does not match the controlled definition");
    }
  }
  for (const sourceId of selectedSourceIds) {
    if (!representedSources.has(sourceId)) addError(errors, "tasks", `selected source scenario ${sourceId} is not represented`);
  }
  if (representedFixtures.size < 2) addError(errors, "tasks", "must represent at least two fixtures");
  return errors;
}

async function gitRevision(directory) {
  const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  return stdout.trim();
}

async function runCommand(command, cwd, timeoutMs, extraEnvironment = {}) {
  try {
    await execFileAsync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      env: {
        ...process.env,
        GOWORK: "off",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHASHSEED: "0",
        ...extraEnvironment,
      },
    });
    return { status: "passed", reason: null };
  } catch (error) {
    const reason = error.killed ? "command_timeout" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output_limit_exceeded" : `exit_${error.code ?? "unknown"}`;
    return { status: "failed", reason };
  }
}

async function preflightFixture({ fixture, agentBeltRoot, timeoutMs }) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `agent-belt-${fixture.fixture_id}-preflight-`));
  const checkout = path.join(temporaryRoot, "checkout");
  const source = path.join(agentBeltRoot, fixture.source_path);
  try {
    const sourceStat = await stat(source);
    if (!sourceStat.isDirectory()) return { fixture_id: fixture.fixture_id, status: "failed", reason: "fixture_source_not_directory" };
    const cloneSource = fixture.repository_scope === "fixture" ? source : agentBeltRoot;
    const clone = await runCommand(["git", "clone", "--quiet", "--no-hardlinks", cloneSource, checkout], temporaryRoot, timeoutMs, fixture.environment);
    if (clone.status !== "passed") return { fixture_id: fixture.fixture_id, status: "failed", reason: `clone_${clone.reason}` };
    const fixtureRoot = fixture.repository_scope === "fixture" ? checkout : path.join(checkout, fixture.source_path);
    for (const command of fixture.reset_commands) {
      const reset = await runCommand(command, fixtureRoot, timeoutMs, fixture.environment);
      if (reset.status !== "passed") return { fixture_id: fixture.fixture_id, status: "failed", reason: `reset_${reset.reason}` };
    }
    const observedRevision = await gitRevision(fixtureRoot);
    if (observedRevision !== fixture.revision) return { fixture_id: fixture.fixture_id, status: "failed", reason: "fixture_revision_mismatch" };
    const test = await runCommand(fixture.test_command, fixtureRoot, timeoutMs, fixture.environment);
    if (test.status !== "passed") return { fixture_id: fixture.fixture_id, status: "failed", reason: `test_${test.reason}` };
    return { fixture_id: fixture.fixture_id, status: "passed", reason: null };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function auditAgentBeltTaskPlan({ plan, agentBeltRoot, runPreflight = false, timeoutMs = 120_000 }) {
  const validationErrors = validateTaskPlan(plan);
  if (validationErrors.length > 0) throw new TaskPlanValidationError(validationErrors);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000");
  const root = await realpath(agentBeltRoot);
  const sourceRevision = await gitRevision(root);
  const sourceChecks = [];
  for (const scenario of plan.audited_scenarios) {
    const contents = await readFile(path.join(root, "examples", "scenarios", "experience", scenario.path));
    const observed = hash(contents);
    sourceChecks.push({
      source_id: scenario.source_id,
      decision: scenario.decision,
      status: observed === scenario.scenario_definition_sha256 ? "passed" : "failed",
      reason: observed === scenario.scenario_definition_sha256 ? null : "scenario_definition_digest_mismatch",
    });
  }
  const fixtureRevisionChecks = [];
  for (const fixture of plan.fixtures) {
    const fixtureRoot = path.join(root, fixture.source_path);
    const observedRevision = await gitRevision(fixture.repository_scope === "fixture" ? fixtureRoot : root);
    fixtureRevisionChecks.push({
      fixture_id: fixture.fixture_id,
      status: observedRevision === fixture.revision ? "passed" : "failed",
      reason: observedRevision === fixture.revision ? null : "fixture_revision_mismatch",
    });
  }
  const fixturePreflights = runPreflight
    ? await Promise.all(plan.fixtures.map((fixture) => preflightFixture({ fixture, agentBeltRoot: root, timeoutMs })))
    : plan.fixtures.map((fixture) => ({ fixture_id: fixture.fixture_id, status: "not_run", reason: "host_preflight_not_requested" }));
  const selectedUpstream = plan.audited_scenarios.filter(({ decision }) => decision === "selected").length;
  const rejectedUpstream = plan.audited_scenarios.length - selectedUpstream;
  const controlledTasks = plan.tasks.filter(({ origin }) => origin === "controlled").length;
  const sourceReady = sourceRevision === plan.source_repository.revision && sourceChecks.every(({ status }) => status === "passed") && fixtureRevisionChecks.every(({ status }) => status === "passed");
  const preflightReady = fixturePreflights.every(({ status }) => status === "passed");
  const ready = sourceReady && preflightReady && plan.tasks.length >= MINIMUM_PLANNED_TASKS;
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION,
    evidence_class: "planning_audit",
    plan: { id: plan.plan_id, source_repository: plan.source_repository.identity, source_revision: plan.source_repository.revision },
    counts: {
      audited_experience_scenarios: plan.audited_scenarios.length,
      selected_experience_scenarios: selectedUpstream,
      rejected_experience_scenarios: rejectedUpstream,
      controlled_tasks: controlledTasks,
      planned_distinct_tasks: plan.tasks.length,
      fixtures_represented: new Set(plan.tasks.map(({ fixture_id }) => fixture_id)).size,
      collection_evidence_evaluated: false,
    },
    source: {
      status: sourceReady ? "passed" : "failed",
      revision_status: sourceRevision === plan.source_repository.revision ? "passed" : "failed",
      scenario_checks: sourceChecks,
      fixture_revision_checks: fixtureRevisionChecks,
    },
    fixture_preflights: fixturePreflights,
    conclusion: {
      status: ready ? "planning_ready" : "blocked",
      quality_claim_eligible: false,
      reasons: ready ? ["controlled_oracles_and_baseline_traces_not_collected"] : [!sourceReady ? "source_preflight_failed" : "fixture_preflight_failed"],
    },
  };
}
