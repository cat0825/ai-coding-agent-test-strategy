import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditVerificationBenchmarkDesign,
  MINIMUM_GENERALIZED_SCENARIO_CLASSES,
  SCENARIO_CLASSES,
  validateVerificationBenchmark,
  verificationTaskDefinitionDigest,
} from "../src/verification-benchmark.mjs";

async function checkedInputs() {
  const [plan, oracles] = await Promise.all([
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-plan.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-oracles.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  return { plan, oracles };
}

function copy(value) {
  return structuredClone(value);
}

test("checked-in pilot defines six distinct verification behaviors with hidden oracles", async () => {
  const { plan, oracles } = await checkedInputs();
  assert.deepEqual(validateVerificationBenchmark(plan, oracles), []);
  assert.equal(plan.tasks.length, 6);
  assert.equal(oracles.oracles.length, 6);
  assert.deepEqual(
    [...new Set(plan.tasks.map(({ behavior_class: behaviorClass }) => behaviorClass))].sort(),
    ["affected_failure", "flaky_retry", "full_fallback", "local_pass", "repeat_stop", "test_required"],
  );
  assert.equal(plan.tasks.filter(({ mode }) => mode === "verify_only").length, 5);
  assert.equal(plan.tasks.filter(({ mode }) => mode === "test_decision").length, 1);
  for (const task of plan.tasks) {
    assert.equal(task.scenario_definition_sha256, verificationTaskDefinitionDigest(task.definition));
    assert.equal(JSON.stringify(task).includes("expected_workspace_status"), false);
    assert.equal(JSON.stringify(task).includes("required_failure_signatures"), false);
  }
});
test("rejects public oracle leakage, stale definitions, duplicate semantics, and forged eligibility", async () => {
  const { plan, oracles } = await checkedInputs();
  const leaked = copy(plan);
  leaked.tasks[0].definition.expected_workspace_status = "passed";
  leaked.tasks[0].scenario_definition_sha256 = verificationTaskDefinitionDigest(leaked.tasks[0].definition);
  assert.ok(validateVerificationBenchmark(leaked, oracles).some(({ message }) => message.includes("hidden oracle")));

  const stale = copy(plan);
  stale.tasks[0].definition.instruction = "changed";
  assert.ok(validateVerificationBenchmark(stale, oracles).some(({ path: field }) => field.endsWith("scenario_definition_sha256")));

  const duplicate = copy(plan);
  duplicate.tasks[1].semantic_task_key = duplicate.tasks[0].semantic_task_key;
  assert.ok(validateVerificationBenchmark(duplicate, oracles).some(({ path: field, message }) => field.endsWith("semantic_task_key") && message === "must be unique"));

  const forged = copy(plan);
  forged.quality_claim_eligible = true;
  assert.ok(validateVerificationBenchmark(forged, oracles).some(({ path: field }) => field === "quality_claim_eligible"));
});

test("rejects oracle rules that would reward unsafe or excessive verification", async () => {
  const { plan, oracles } = await checkedInputs();
  const unsafe = copy(oracles);
  const failed = unsafe.oracles.find(({ task_id: taskId }) => taskId === "vp_affected_failure");
  failed.required_failure_signatures = [];
  assert.ok(validateVerificationBenchmark(plan, unsafe).some(({ path: field }) => field.includes("required_failure_signatures")));

  const repeat = copy(oracles);
  repeat.oracles.find(({ task_id: taskId }) => taskId === "vp_repeat_pass_stop").identical_retry_limit = 1;
  assert.ok(validateVerificationBenchmark(plan, repeat).some(({ message }) => message.includes("repeat_stop")));

  const noTest = copy(oracles);
  noTest.oracles.find(({ task_id: taskId }) => taskId === "vp_public_behavior_test_required").test_edits = "allowed";
  assert.ok(validateVerificationBenchmark(plan, noTest).some(({ message }) => message.includes("test_required")));
});

test("design audit is explicit about missing execution evidence", async () => {
  const { plan, oracles } = await checkedInputs();
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  assert.equal(report.conclusion.status, "design_ready");
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.deepEqual(report.conclusion.blockers, [
    "task_workspaces_not_materialized",
    "independent_oracles_not_executed",
    "paired_traces_not_collected",
    "scenario_classes_not_generalized",
  ]);
});

test("fixtures must declare a supported usage scenario and language", async () => {
  const { plan, oracles } = await checkedInputs();
  for (const fixture of plan.fixtures) {
    assert.ok(SCENARIO_CLASSES.includes(fixture.scenario_class));
    assert.equal(typeof fixture.language, "string");
  }

  const missing = copy(plan);
  delete missing.fixtures[0].scenario_class;
  assert.ok(validateVerificationBenchmark(missing, oracles).some(({ path: field }) => field.endsWith("scenario_class")));

  const invented = copy(plan);
  invented.fixtures[0].scenario_class = "data_science";
  assert.ok(validateVerificationBenchmark(invented, oracles).some(({ path: field }) => field.endsWith("scenario_class")));

  const unsupportedLanguage = copy(plan);
  unsupportedLanguage.fixtures[0].language = "cobol";
  assert.ok(validateVerificationBenchmark(unsupportedLanguage, oracles).some(({ path: field }) => field.endsWith("language")));
});

test("single-scenario pilots are reported as not generalized", async () => {
  const { plan, oracles } = await checkedInputs();
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  assert.deepEqual(report.counts.scenario_classes, { cli_tool: 6 });
  assert.deepEqual(report.counts.languages, ["javascript"]);
  assert.equal(report.scenario_coverage.generalized, false);
  assert.deepEqual(report.scenario_coverage.covered, ["cli_tool"]);
  assert.deepEqual(report.scenario_coverage.missing, ["web_frontend", "service_library", "research_script"]);
  assert.ok(report.conclusion.blockers.includes("scenario_classes_not_generalized"));

  const generalized = copy(plan);
  generalized.fixtures.push({
    ...copy(plan.fixtures[0]),
    fixture_id: "observatory-web",
    scenario_class: "web_frontend",
    language: "typescript",
  });
  generalized.tasks[0].fixture_id = "observatory-web";
  const widened = auditVerificationBenchmarkDesign(generalized, oracles);
  assert.equal(widened.scenario_coverage.covered.length, MINIMUM_GENERALIZED_SCENARIO_CLASSES);
  assert.equal(widened.scenario_coverage.generalized, true);
  assert.equal(widened.conclusion.blockers.includes("scenario_classes_not_generalized"), false);
});

test("CLI writes a deterministic design audit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verification-benchmark-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "report.json");
  const arguments_ = [
    "src/verification-benchmark-cli.mjs",
    "--plan", "fixtures/benchmark/verification-policy-pilot-plan.json",
    "--oracles", "fixtures/benchmark/verification-policy-pilot-oracles.json",
    "--output", output,
  ];
  execFileSync(process.execPath, arguments_, { cwd: path.resolve("."), encoding: "utf8" });
  const first = await readFile(output, "utf8");
  await writeFile(output, "replaced\n");
  execFileSync(process.execPath, arguments_, { cwd: path.resolve("."), encoding: "utf8" });
  const second = await readFile(output, "utf8");
  assert.equal(second, first);
  assert.equal(JSON.parse(second).conclusion.status, "design_ready");
});
