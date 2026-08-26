import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditVerificationBenchmarkDesign,
  MINIMUM_EXTERNAL_REPOSITORIES,
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

const EXTERNAL_WEB_FIXTURE = "external-zustand";

// Authors one task, and the oracle that goes with it, against a declared external fixture. A
// repository that carries no task contributes no observation, so widening the plan has to add the
// task rather than just the fixture.
function withTaskOnFixture({ plan, oracles }, fixtureId) {
  const widenedPlan = copy(plan);
  const widenedOracles = copy(oracles);
  const fixture = widenedPlan.fixtures.find(({ fixture_id: id }) => id === fixtureId);
  assert.ok(fixture, `plan declares fixture ${fixtureId}`);
  const slug = fixtureId.replaceAll("-", "_");
  const task = copy(widenedPlan.tasks[0]);
  task.task_id = `${slug}_local_pass`;
  task.semantic_task_key = `verification-policy:${fixtureId}-local-pass`;
  task.oracle_id = `vp-oracle-${fixtureId}-local-pass-v1`;
  task.fixture_id = fixtureId;
  task.definition.source.base_revision = fixture.repository.revision;
  task.definition.source.change_revision = "c".repeat(40);
  task.scenario_definition_sha256 = verificationTaskDefinitionDigest(task.definition);
  widenedPlan.tasks.push(task);
  const oracle = copy(widenedOracles.oracles.find(({ task_id: taskId }) => taskId === widenedPlan.tasks[0].task_id));
  oracle.oracle_id = task.oracle_id;
  oracle.task_id = task.task_id;
  oracle.independent_oracle_id = `${oracle.independent_oracle_id}-${slug}`;
  widenedOracles.oracles.push(oracle);
  return { plan: widenedPlan, oracles: widenedOracles, fixture, task };
}

// Strips every external fixture, leaving the plan as it stood before any repository was qualified.
function withoutExternalFixtures({ plan, oracles }) {
  const reduced = copy(plan);
  const keptIds = new Set(reduced.fixtures
    .filter(({ origin }) => origin.kind === "source_repository")
    .map(({ fixture_id: id }) => id));
  reduced.fixtures = reduced.fixtures.filter(({ fixture_id: id }) => keptIds.has(id));
  reduced.tasks = reduced.tasks.filter(({ fixture_id: id }) => keptIds.has(id));
  const reducedOracles = copy(oracles);
  const keptTasks = new Set(reduced.tasks.map(({ task_id: id }) => id));
  reducedOracles.oracles = reducedOracles.oracles.filter(({ task_id: id }) => keptTasks.has(id));
  return { plan: reduced, oracles: reducedOracles };
}

test("checked-in pilot defines six distinct verification behaviors with hidden oracles", async () => {
  const { plan, oracles } = await checkedInputs();
  assert.deepEqual(validateVerificationBenchmark(plan, oracles), []);
  // Six on the source repository plus one re-observation of affected_failure on an external fixture.
  assert.equal(plan.tasks.length, 7);
  assert.equal(oracles.oracles.length, 7);
  assert.equal(plan.tasks.filter(({ fixture_id: id }) => id === "observatory-node").length, 6);
  assert.deepEqual(
    [...new Set(plan.tasks.map(({ behavior_class: behaviorClass }) => behaviorClass))].sort(),
    ["affected_failure", "flaky_retry", "full_fallback", "local_pass", "repeat_stop", "test_required"],
  );
  assert.equal(plan.tasks.filter(({ mode }) => mode === "verify_only").length, 6);
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

test("an oracle that cannot decide post-run must say so and name what decides instead", async () => {
  const { plan, oracles } = await checkedInputs();
  assert.deepEqual(validateVerificationBenchmark(plan, oracles), []);

  const flakyTask = ({ task_id: taskId }) => taskId === "vp_flaky_retry_once";
  const checkedIn = oracles.oracles.find(flakyTask);
  assert.equal(checkedIn.post_run_decidable, false);
  assert.equal(checkedIn.deciding_evidence, "trace_only");

  // The consumed marker is a property of the behaviour class, not of this one task, so claiming the oracle can
  // decide must be rejected however the rest of the definition is dressed up.
  const claimsDecidable = copy(oracles);
  const forged = claimsDecidable.oracles.find(flakyTask);
  forged.post_run_decidable = true;
  forged.deciding_evidence = "independent_oracle";
  delete forged.undecidable_reason;
  assert.ok(
    validateVerificationBenchmark(plan, claimsDecidable).some(({ message }) => message.includes("consumed before the oracle runs")),
  );

  const noReason = copy(oracles);
  delete noReason.oracles.find(flakyTask).undecidable_reason;
  assert.ok(validateVerificationBenchmark(plan, noReason).some(({ path: field }) => field.includes("undecidable_reason")));

  // An undecidable oracle may not point back at itself as the thing that decides the task.
  const selfDeciding = copy(oracles);
  selfDeciding.oracles.find(flakyTask).deciding_evidence = "independent_oracle";
  assert.ok(validateVerificationBenchmark(plan, selfDeciding).some(({ path: field }) => field.includes("deciding_evidence")));

  // A decidable oracle must not borrow the escape hatch.
  const borrowed = copy(oracles);
  borrowed.oracles.find(({ task_id: taskId }) => taskId === "vp_local_correct_stop").undecidable_reason = "inconvenient";
  assert.ok(validateVerificationBenchmark(plan, borrowed).some(({ message }) => message.includes("absent for a decidable oracle")));
});

test("design audit is explicit about missing execution evidence", async () => {
  const { plan, oracles } = await checkedInputs();
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  assert.equal(report.conclusion.status, "design_ready");
  assert.equal(report.conclusion.quality_claim_eligible, false);
  // `scenario_classes_not_generalized` is absent: the external affected_failure task puts a second
  // scenario class under observation. The remaining three blockers are all execution evidence.
  assert.deepEqual(report.conclusion.blockers, [
    "task_workspaces_not_materialized",
    "independent_oracles_not_executed",
    "paired_traces_not_collected",
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

test("qualifying a repository does not by itself widen scenario coverage", async () => {
  const { plan, oracles } = await checkedInputs();
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  // Three repositories are qualified; only pino carries a task. So service_library is covered and
  // web_frontend is not, even though zustand is qualified and declares it. Coverage counts
  // observations, not declarations -- the two qualified-but-task-free fixtures are the control.
  assert.deepEqual(report.counts.scenario_classes, { cli_tool: 6, service_library: 1 });
  assert.deepEqual(report.counts.languages, ["javascript", "typescript"]);
  assert.equal(report.external_repository_coverage.qualified, MINIMUM_EXTERNAL_REPOSITORIES);
  assert.equal(report.external_repository_coverage.with_tasks, 1);
  assert.deepEqual(report.scenario_coverage.covered, ["cli_tool", "service_library"]);
  assert.deepEqual(report.scenario_coverage.missing, ["web_frontend", "research_script"]);
  assert.equal(report.scenario_coverage.covered.length, MINIMUM_GENERALIZED_SCENARIO_CLASSES);
  assert.equal(report.scenario_coverage.generalized, true);
  assert.equal(report.conclusion.blockers.includes("scenario_classes_not_generalized"), false);

  // Giving the qualified web_frontend fixture a task is what moves it out of `missing`.
  const generalized = withTaskOnFixture({ plan, oracles }, EXTERNAL_WEB_FIXTURE);
  const widened = auditVerificationBenchmarkDesign(generalized.plan, generalized.oracles);
  assert.deepEqual(widened.scenario_coverage.covered, ["cli_tool", "service_library", "web_frontend"]);
  assert.deepEqual(widened.scenario_coverage.missing, ["research_script"]);
  assert.equal(widened.external_repository_coverage.with_tasks, 2);
});

test("the six-task pilot stays bound to the source repository", async () => {
  const { plan, oracles } = await checkedInputs();
  assert.deepEqual(validateVerificationBenchmark(plan, oracles), []);

  // Adding a repository must not silently shrink the pilot: moving one of the six tasks onto an
  // external fixture leaves five behaviors observed on the source repository, and that is an error
  // rather than a widening.
  const moved = copy(plan);
  const target = moved.fixtures.find(({ fixture_id: id }) => id === EXTERNAL_WEB_FIXTURE);
  moved.tasks[0].fixture_id = target.fixture_id;
  moved.tasks[0].definition.source.base_revision = target.repository.revision;
  moved.tasks[0].scenario_definition_sha256 = verificationTaskDefinitionDigest(moved.tasks[0].definition);
  assert.ok(validateVerificationBenchmark(moved, oracles)
    .some(({ path: field, message }) => field === "tasks" && message.includes("on the source_repository fixture")));

  const twoSources = copy(plan);
  twoSources.fixtures.push({ ...copy(plan.fixtures[0]), fixture_id: "observatory-node-2" });
  assert.ok(validateVerificationBenchmark(twoSources, oracles)
    .some(({ path: field, message }) => field === "fixtures" && message.includes("exactly one source_repository")));

  const noSource = copy(plan);
  noSource.fixtures[0].origin = copy(plan.fixtures.find(({ fixture_id: id }) => id === EXTERNAL_WEB_FIXTURE).origin);
  assert.ok(validateVerificationBenchmark(noSource, oracles)
    .some(({ path: field, message }) => field === "fixtures" && message.includes("exactly one source_repository")));

  // A behavior class is scoped to its fixture, so re-observing local_pass on another repository is
  // allowed while repeating it inside one repository is not.
  const reobserved = withTaskOnFixture({ plan, oracles }, EXTERNAL_WEB_FIXTURE);
  assert.deepEqual(validateVerificationBenchmark(reobserved.plan, reobserved.oracles), []);
  assert.equal(reobserved.task.behavior_class, plan.tasks[0].behavior_class);

  const collided = withTaskOnFixture({ plan, oracles }, EXTERNAL_WEB_FIXTURE);
  collided.plan.tasks.at(-1).fixture_id = plan.fixtures[0].fixture_id;
  assert.ok(validateVerificationBenchmark(collided.plan, collided.oracles)
    .some(({ path: field, message }) => field.endsWith("behavior_class") && message === "must be unique within its fixture"));
});

test("external fixtures cannot vouch for their own qualification", async () => {
  const { plan, oracles } = await checkedInputs();
  const externalIndex = plan.fixtures.findIndex(({ fixture_id: id }) => id === EXTERNAL_WEB_FIXTURE);

  function mutated(mutate) {
    const next = copy(plan);
    mutate(next.fixtures[externalIndex]);
    return validateVerificationBenchmark(next, oracles);
  }

  assert.ok(mutated((fixture) => { fixture.origin.eligible = true; })
    .some(({ path: field, message }) => field.endsWith(".origin") && message.includes("must not declare its own qualification")));

  assert.ok(mutated((fixture) => { fixture.origin.status = "qualified"; })
    .some(({ path: field, message }) => field.endsWith(".origin") && message.includes("must not declare its own qualification")));

  assert.ok(mutated((fixture) => { delete fixture.origin.qualification; })
    .some(({ path: field }) => field.endsWith(".origin.qualification")));

  assert.ok(mutated((fixture) => { fixture.origin.qualification.sha256 = "not-a-digest"; })
    .some(({ path: field }) => field.endsWith(".origin.qualification.sha256")));

  assert.ok(mutated((fixture) => { fixture.origin.qualification.path = "../../etc/passwd"; })
    .some(({ path: field, message }) => field.endsWith(".origin.qualification.path") && message.includes("must stay inside")));

  assert.ok(mutated((fixture) => { delete fixture.origin.qualification.fixture_id; })
    .some(({ path: field }) => field.endsWith(".origin.qualification.fixture_id")));

  assert.ok(mutated((fixture) => { delete fixture.origin.clone_url; })
    .some(({ path: field }) => field.endsWith(".origin.clone_url")));

  const misplacedCloneUrl = copy(plan);
  misplacedCloneUrl.fixtures[0].origin.clone_url = "https://github.com/example/web.git";
  assert.ok(validateVerificationBenchmark(misplacedCloneUrl, oracles)
    .some(({ path: field, message }) => field.endsWith(".origin.clone_url") && message.includes("does not apply")));

  const noOrigin = copy(plan);
  delete noOrigin.fixtures[0].origin;
  assert.ok(validateVerificationBenchmark(noOrigin, oracles).some(({ path: field }) => field.endsWith(".origin")));

  const inventedKind = copy(plan);
  inventedKind.fixtures[0].origin = { kind: "vendored_copy" };
  assert.ok(validateVerificationBenchmark(inventedKind, oracles).some(({ path: field }) => field.endsWith(".origin.kind")));
});

test("a task on an external fixture is pinned to the qualified revision", async () => {
  const { plan, oracles } = await checkedInputs();
  const drifted = withTaskOnFixture({ plan, oracles }, EXTERNAL_WEB_FIXTURE);
  const task = drifted.plan.tasks.at(-1);
  task.definition.source.base_revision = "d".repeat(40);
  task.scenario_definition_sha256 = verificationTaskDefinitionDigest(task.definition);
  assert.ok(validateVerificationBenchmark(drifted.plan, drifted.oracles)
    .some(({ path: field, message }) => field.endsWith("definition.source.base_revision") && message === "must be the pinned fixture revision"));
});

test("external repository coverage counts qualified fixtures and the ones carrying tasks", async () => {
  const { plan, oracles } = await checkedInputs();
  const report = auditVerificationBenchmarkDesign(plan, oracles);
  assert.equal(report.counts.external_repositories, MINIMUM_EXTERNAL_REPOSITORIES);
  assert.equal(report.external_repository_coverage.qualified, MINIMUM_EXTERNAL_REPOSITORIES);
  // Three repositories are qualified but only one carries a task, so `qualified` is met while
  // `with_tasks` stays well below it. That gap is the difference the two counters exist to keep visible.
  assert.equal(report.external_repository_coverage.with_tasks, 1);
  assert.equal(report.external_repository_coverage.satisfied, true);
  assert.equal(report.conclusion.blockers.includes("external_repositories_below_minimum"), false);
  assert.deepEqual(
    report.external_repository_coverage.repositories.map(({ fixture_id: fixtureId, identity, tasks }) => [fixtureId, identity, tasks]),
    [
      ["external-pino", "pinojs/pino", 1],
      ["external-yargs", "yargs/yargs", 0],
      ["external-zustand", "pmndrs/zustand", 0],
    ],
  );
  for (const repository of report.external_repository_coverage.repositories) {
    assert.equal(repository.qualification.fixture_id, repository.fixture_id);
    assert.match(repository.qualification.sha256, /^[a-f0-9]{64}$/);
  }

  // Before any repository was qualified the audit had to say so, and it did.
  const reduced = withoutExternalFixtures({ plan, oracles });
  const before = auditVerificationBenchmarkDesign(reduced.plan, reduced.oracles);
  assert.equal(before.counts.external_repositories, 0);
  assert.deepEqual(before.external_repository_coverage.repositories, []);
  assert.equal(before.external_repository_coverage.satisfied, false);
  assert.ok(before.conclusion.blockers.includes("external_repositories_below_minimum"));
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

// The policy arm is only evidence if the policy was in force. codex 0.149.0 silently skips hooks in a
// CODEX_HOME without persisted hook trust and reports nothing about it, so a run whose hook never
// loaded still produces a clean transcript. An absent or empty ledger is already refused downstream,
// which leaves the flag being left off -- the one path that would have published zero decisions as if
// the agent had simply stayed inside every budget.
test("a policy-arm trace cannot be built without the ledger that proves the hook ran", async () => {
  const argumentsFor = (mode, extra = []) => [
    "src/verification-trace-cli.mjs",
    "--plan", "fixtures/benchmark/verification-policy-pilot-plan.json",
    "--oracles", "fixtures/benchmark/verification-policy-pilot-oracles.json",
    "--repo", ".", "--task-manifest", "missing.json",
    "--stream", "missing.ndjson", "--lifecycle", "missing.ndjson", "--collector", "missing.json",
    "--run-id", "r", "--harness", "codex", "--model", "m", "--mode", mode,
    "--policy-name", "observatory-verification-policy", "--policy-version", "0.4-unscoped",
    "--output", "unused.json",
    ...extra,
  ];
  const run = (mode, extra) => spawnSync(process.execPath, argumentsFor(mode, extra), {
    cwd: path.resolve("."),
    encoding: "utf8",
  });

  const withoutLedger = run("shadow");
  assert.equal(withoutLedger.status, 1);
  assert.match(withoutLedger.stderr, /--policy-ledger is required for --mode shadow/);

  // The check has to be about the missing proof, not about the other paths being fake: with the flag
  // supplied this run fails later, on the manifest it cannot read.
  const withLedger = run("shadow", ["--policy-ledger", "missing.ndjson"]);
  assert.equal(withLedger.status, 1);
  assert.doesNotMatch(withLedger.stderr, /--policy-ledger is required/);

  // A baseline arm has no hook by design, so it must not be forced to produce one.
  const baseline = run("baseline");
  assert.equal(baseline.status, 1);
  assert.doesNotMatch(baseline.stderr, /--policy-ledger is required/);
});
