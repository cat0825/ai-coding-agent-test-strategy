import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stableJson } from "../src/benchmark-preflight.mjs";
import { auditAgentBeltTaskPlan, validateTaskPlan } from "../src/task-plan.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(commandName, arguments_, cwd) {
  return execFileSync(commandName, arguments_, { cwd, encoding: "utf8" }).trim();
}

async function checkedPlan() {
  return JSON.parse(await readFile(new URL("../fixtures/benchmark/agent-belt-task-plan.json", import.meta.url), "utf8"));
}

test("checked-in plan covers all 41 scenarios with 30 distinct tasks across two fixtures", async () => {
  const plan = await checkedPlan();
  assert.deepEqual(validateTaskPlan(plan), []);
  assert.equal(plan.audited_scenarios.length, 41);
  assert.equal(plan.audited_scenarios.filter(({ decision }) => decision === "selected").length, 4);
  assert.equal(plan.tasks.length, 30);
  assert.equal(new Set(plan.tasks.map(({ semantic_task_key }) => semantic_task_key)).size, 30);
  assert.deepEqual([...new Set(plan.tasks.map(({ fixture_id }) => fixture_id))].sort(), ["calculator", "tasktracker"]);
  assert.equal(plan.tasks.some(({ status }) => status !== undefined), false);
  assert.equal(plan.quality_claim_eligible, undefined);
});

test("rejects duplicate task semantics, changed definitions, and forged eligibility", async () => {
  const plan = await checkedPlan();
  plan.tasks[1].semantic_task_key = plan.tasks[0].semantic_task_key;
  plan.tasks.find(({ origin }) => origin === "controlled").definition.description = "changed";
  plan.tasks[0].quality_claim_eligible = true;
  const errors = validateTaskPlan(plan);
  assert.ok(errors.some(({ path: field, message }) => field.endsWith("semantic_task_key") && message.includes("trials")));
  assert.ok(errors.some(({ path: field, message }) => field.endsWith("scenario_definition_sha256") && message.includes("controlled definition")));
  assert.ok(errors.some(({ path: field }) => field.endsWith("quality_claim_eligible")));
});

async function createAuditFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-plan-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const experienceRoot = path.join(root, "examples", "scenarios", "experience", "group");
  await mkdir(experienceRoot, { recursive: true });
  await mkdir(path.join(root, "fixtures", "one"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "two"), { recursive: true });
  await writeFile(path.join(root, "fixtures", "one", "ready"), "one\n");
  await writeFile(path.join(root, "fixtures", "two", "ready"), "two\n");
  const auditedScenarios = [];
  for (let index = 0; index < 41; index += 1) {
    const contents = `${JSON.stringify({ name: `scenario-${index}` })}\n`;
    const relative = `group/scenario-${index}.json`;
    await writeFile(path.join(root, "examples", "scenarios", "experience", relative), contents);
    auditedScenarios.push({
      source_id: `group/scenario-${index}`,
      path: relative,
      scenario_definition_sha256: sha256(contents),
      decision: index < 2 ? "selected" : "rejected",
      reason_code: index < 2 ? "deterministic" : "not_selected",
      rationale: index < 2 ? "deterministic edit" : "stable exclusion",
    });
  }
  command("git", ["init", "-q"], root);
  command("git", ["config", "user.name", "Task Plan Test"], root);
  command("git", ["config", "user.email", "task-plan@example.invalid"], root);
  command("git", ["add", "."], root);
  command("git", ["commit", "-qm", "fixture"], root);
  const revision = command("git", ["rev-parse", "HEAD"], root);
  const fixtures = ["one", "two"].map((fixtureId) => ({
    fixture_id: fixtureId,
    source_path: `fixtures/${fixtureId}`,
    repository_scope: "source_repository",
    revision,
    reset_commands: [["git", "reset", "--hard", revision], ["git", "clean", "-fdx"]],
    test_command: [process.execPath, "-e", "process.exit(0)"],
  }));
  const tasks = auditedScenarios.slice(0, 2).map((scenario, index) => ({
    task_id: `source-${index}`,
    semantic_task_key: `source:${index}`,
    origin: "agent-belt-experience",
    source_scenario_id: scenario.source_id,
    fixture_id: index === 0 ? "one" : "two",
    scenario_definition_sha256: scenario.scenario_definition_sha256,
    risk_class: "low",
    explicit_test_requirement: "run focused tests",
    oracle_id: `source-oracle-${index}`,
    inclusion_rationale: "deterministic edit",
  }));
  for (let index = 0; index < 28; index += 1) {
    const definition = { description: `controlled ${index}`, turns: [{ message: `task ${index}` }], tags: ["controlled"] };
    tasks.push({
      task_id: `controlled-${index}`,
      semantic_task_key: `controlled:${index}`,
      origin: "controlled",
      fixture_id: index % 2 === 0 ? "one" : "two",
      scenario_definition_sha256: sha256(stableJson(definition)),
      risk_class: "medium",
      explicit_test_requirement: "run focused tests",
      oracle_id: `controlled-oracle-${index}`,
      inclusion_rationale: "distinct behavior",
      definition,
    });
  }
  return {
    root,
    plan: {
      schema_version: 1,
      plan_id: "fixture-plan",
      evidence_class: "planning",
      source_repository: { identity: "fixture/repository", revision },
      expected_experience_scenarios: 41,
      minimum_planned_tasks: 30,
      fixtures,
      audited_scenarios: auditedScenarios,
      tasks,
    },
  };
}

test("derives planning-ready only after source, reset, and fixture tests pass", async (t) => {
  const { root, plan } = await createAuditFixture(t);
  const withoutHost = await auditAgentBeltTaskPlan({ plan, agentBeltRoot: root });
  assert.equal(withoutHost.conclusion.status, "blocked");
  assert.equal(withoutHost.conclusion.quality_claim_eligible, false);
  assert.deepEqual(withoutHost.fixture_preflights.map(({ status }) => status), ["not_run", "not_run"]);

  const report = await auditAgentBeltTaskPlan({ plan, agentBeltRoot: root, runPreflight: true });
  assert.equal(report.conclusion.status, "planning_ready");
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.deepEqual(report.fixture_preflights.map(({ status }) => status), ["passed", "passed"]);
  assert.equal(report.counts.planned_distinct_tasks, 30);
  assert.equal(report.counts.collection_evidence_evaluated, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
