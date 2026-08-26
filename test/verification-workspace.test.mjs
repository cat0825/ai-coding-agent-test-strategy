import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCollectorProvenance } from "../src/collector-provenance.mjs";
import { assessAgentEdits, runVerificationPolicyOracle } from "../src/verification-policy-oracle.mjs";
import {
  matchRequiredFailureSignatures,
  materializeVerificationTask,
  qualifyVerificationPilot,
  verifyFixtureQualification,
  verifyVerificationWorkspaceSource,
  verificationWorkspaceStateSha256,
} from "../src/verification-workspace.mjs";

async function checkedInputs() {
  const [plan, oracles, qualification] = await Promise.all([
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-plan.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-oracles.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-qualification.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  return { plan, oracles, qualification };
}

test("qualification rejects a different failure with the same exit code", () => {
  const required = ["evaluation:quality-claim-regression"];
  assert.equal(matchRequiredFailureSignatures(required, [{ exit_code: 1, stdout: "", stderr: "SyntaxError: unexpected token" }]), false);
  assert.equal(matchRequiredFailureSignatures(required, [{
    exit_code: 1,
    stdout: "ineligible calibration comparisons cannot inflate quality-claim gates",
    stderr: "AssertionError [ERR_ASSERTION]",
  }]), true);
  assert.equal(matchRequiredFailureSignatures(required, [{
    exit_code: 1,
    stdout: "ineligible calibration comparisons cannot inflate quality-claim gates",
    stderr: "SyntaxError: unexpected token",
  }]), false);
});

test("collector provenance rejects a forged digest that is not backed by the wrapper", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verification-collector-binding-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "collector.json");
  const wrapperPath = path.join(directory, "codex");
  const controlledCollectorPath = path.resolve("scripts/codex-lifecycle-wrapper.py");
  await copyFile(controlledCollectorPath, wrapperPath);
  const controlled = await readFile(controlledCollectorPath);
  const collector = {
    schema_version: 1,
    collector_sha256: createHash("sha256").update(controlled).digest("hex"),
  };
  await writeFile(manifestPath, `${JSON.stringify(collector)}\n`);
  await verifyCollectorProvenance({ collector, collectorManifestPath: manifestPath, controlledCollectorPath });

  await writeFile(wrapperPath, "forged wrapper\n");
  await assert.rejects(
    verifyCollectorProvenance({ collector, collectorManifestPath: manifestPath, controlledCollectorPath }),
    /digest does not match/,
  );
});

test("materializer exposes only the base snapshot and declared change", async (t) => {
  const { plan } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-materializer-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => materialized.cleanup());
  const second = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => second.cleanup());
  assert.deepEqual(materialized.changed_files, ["src/trace.mjs"]);
  assert.equal(second.workspace_revision, materialized.workspace_revision);
  assert.match(materialized.workspace_state_sha256, /^[a-f0-9]{64}$/);
  assert.equal(second.workspace_state_sha256, materialized.workspace_state_sha256);
  assert.match(materialized.changed_file_sha256["src/trace.mjs"], /^[a-f0-9]{64}$/);
  assert.deepEqual(second.changed_file_sha256, materialized.changed_file_sha256);
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: materialized.workspace, encoding: "utf8" }).trim(), "1");
  assert.throws(
    () => execFileSync("git", ["cat-file", "-e", "27003e86236ae6a8a57dd621020f7874a67f4e64^{commit}"], { cwd: materialized.workspace, stdio: "ignore" }),
  );
  execFileSync("node", ["--test", "test/trace.test.mjs"], { cwd: materialized.workspace, stdio: "ignore" });
});

test("prepare CLI returns a runnable isolated workspace binding", async (t) => {
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-prepare-cli-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const stdout = execFileSync(process.execPath, [
    "src/verification-task-cli.mjs",
    "--plan", "fixtures/benchmark/verification-policy-pilot-plan.json",
    "--task", "vp_repeat_pass_stop",
    "--repo", ".",
    "--output-parent", outputParent,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  const binding = JSON.parse(stdout);
  assert.equal(binding.task_id, "vp_repeat_pass_stop");
  assert.equal(binding.mode, "verify_only");
  assert.match(binding.workspace_revision, /^[a-f0-9]{40}$/);
  assert.match(binding.workspace_state_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(binding.changed_file_sha256), binding.changed_files);
  assert.deepEqual(
    execFileSync("git", ["diff", "--name-only"], { cwd: binding.workspace, encoding: "utf8" }).trim().split(/\r?\n/).sort(),
    binding.changed_files.sort(),
  );
});

test("workspace state detects untracked files", async (t) => {
  const { plan } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-state-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => materialized.cleanup());
  await writeFile(path.join(materialized.workspace, "agent-created.txt"), "new evidence\n");
  assert.notEqual(await verificationWorkspaceStateSha256(materialized.workspace), materialized.workspace_state_sha256);
});

test("workspace source binding rejects a different base revision with the same manifest shape", async (t) => {
  const { plan } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-source-binding-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => materialized.cleanup());

  const binding = await verifyVerificationWorkspaceSource({
    sourceRepository: path.resolve("."),
    workspace: materialized.workspace,
    sourceBaseRevision: materialized.base_revision,
  });
  assert.equal(binding.workspace_revision, materialized.workspace_revision);
  assert.equal(binding.source_tree, binding.workspace_tree);
  await assert.rejects(
    verifyVerificationWorkspaceSource({
      sourceRepository: path.resolve("."),
      workspace: materialized.workspace,
      sourceBaseRevision: "e9bd535012d4657534cf3cef69f394d2e7145387",
    }),
    /base tree does not match/,
  );
});

test("independent oracle binds the same post-run workspace digest as the trace collector", async (t) => {
  const { plan, oracles } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-oracle-binding-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => materialized.cleanup());
  const task = plan.tasks.find(({ task_id }) => task_id === "vp_local_correct_stop");
  const taskManifest = {
    task_id: task.task_id,
    scenario_definition_sha256: task.scenario_definition_sha256,
    source_base_revision: materialized.base_revision,
    workspace: materialized.workspace,
    workspace_revision: materialized.workspace_revision,
    workspace_state_sha256: materialized.workspace_state_sha256,
    changed_files: materialized.changed_files,
    changed_file_sha256: materialized.changed_file_sha256,
  };
  const report = await runVerificationPolicyOracle({
    plan,
    oracles,
    taskManifest,
    sourceRepository: path.resolve("."),
  });
  assert.equal(report.result.status, "passed");
  assert.equal(report.workspace.post_run_workspace_state_sha256, await verificationWorkspaceStateSha256(materialized.workspace));
  assert.equal(report.workspace.post_run_workspace_state_sha256, materialized.workspace_state_sha256);
  assert.deepEqual(report.workspace.agent_changed_files, []);
});

test("all six pilot states reproduce their declared pass and failure patterns", async (t) => {
  const { plan, oracles, qualification } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-qualification-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const observed = await qualifyVerificationPilot({
    plan,
    oracles,
    sourceRepository: path.resolve("."),
    outputParent,
  });
  assert.deepEqual(observed, qualification);
  assert.equal(observed.conclusion.status, "fixture_ready");
  assert.equal(observed.counts.qualified_tasks, 6);
});

test("checked-in integration smoke report stays bound to its sanitized trace", async () => {
  const report = JSON.parse(await readFile("fixtures/benchmark/verification-policy-smoke-report.json", "utf8"));
  const traceContents = await readFile(report.trace.path);
  const trace = JSON.parse(traceContents.toString("utf8"));
  assert.equal(createHash("sha256").update(traceContents).digest("hex"), report.trace.sha256);
  assert.equal(trace.trace_id, "trace-1ea6741faac78aa281daff8ba7879f5a3eaaa2a91259b60b30c73b6a3c34ed57");
  assert.equal(report.assessment.formal_baseline_eligible, false);
  assert.equal(report.conclusion.status, "integration_smoke_ready");
});

test("checked-in paired dry run stays bound to traces and independent oracles", async () => {
  const root = path.resolve("fixtures/benchmark/verification-policy-dry-run-2026-08-19");
  const report = JSON.parse(await readFile(path.join(root, "run-report.json"), "utf8"));
  for (const task of report.tasks) {
    for (const role of ["baseline", "candidate"]) {
      const evidence = task[role];
      const [traceContents, oracleContents] = await Promise.all([
        readFile(path.join(root, evidence.trace.path)),
        readFile(path.join(root, evidence.oracle.path)),
      ]);
      assert.equal(createHash("sha256").update(traceContents).digest("hex"), evidence.trace.sha256);
      assert.equal(createHash("sha256").update(oracleContents).digest("hex"), evidence.oracle.sha256);
      const trace = JSON.parse(traceContents);
      const oracle = JSON.parse(oracleContents);
      assert.equal(trace.task_id, task.task_id);
      assert.equal(trace.mode, report.treatment[role].mode);
      assert.deepEqual(trace.policy, report.treatment[role].policy);
      assert.equal(trace.completeness, "complete");
      assert.deepEqual(trace.warnings, []);
      assert.equal(oracle.result.status, "passed");
      assert.equal(trace.source.oracle_definition_sha256, oracle.oracle.definition_sha256);
      assert.equal(trace.source.post_run_workspace_sha256, oracle.workspace.post_run_workspace_state_sha256);
      assert.equal(trace.source.post_run_workspace_sha256, evidence.post_run_workspace_state_sha256);
      assert.deepEqual(oracle.workspace.agent_changed_files, []);
    }
  }
  const evaluation = JSON.parse(await readFile(path.join(root, report.evaluation.report_path), "utf8"));
  assert.equal(evaluation.metrics.comparison_integrity.value, 1);
  assert.equal(evaluation.metrics.candidate_failure_recall.value, 1);
  assert.equal(evaluation.conclusion.status, "evidence_insufficient");
  assert.equal(evaluation.conclusion.efficiency_claim, "not_supported");
});

test("re-collected test_decision pair records the agent test write on both sides", async () => {
  const root = path.resolve("fixtures/benchmark/verification-policy-run-2026-08-22");
  const report = JSON.parse(await readFile(path.join(root, "run-report.json"), "utf8"));
  assert.equal(report.tasks.length, 1);
  const [task] = report.tasks;
  assert.equal(task.task_id, "vp_public_behavior_test_required");
  for (const role of ["baseline", "candidate"]) {
    const evidence = task[role];
    const [traceContents, oracleContents] = await Promise.all([
      readFile(path.join(root, evidence.trace.path)),
      readFile(path.join(root, evidence.oracle.path)),
    ]);
    assert.equal(createHash("sha256").update(traceContents).digest("hex"), evidence.trace.sha256);
    assert.equal(createHash("sha256").update(oracleContents).digest("hex"), evidence.oracle.sha256);
    const trace = JSON.parse(traceContents);
    const oracle = JSON.parse(oracleContents);
    assert.equal(trace.task_id, task.task_id);
    assert.equal(trace.mode, report.treatment[role].mode);
    assert.deepEqual(trace.policy, report.treatment[role].policy);
    assert.equal(trace.model, report.model);
    assert.equal(trace.harness, report.harness);
    assert.equal(trace.completeness, "complete");
    assert.deepEqual(trace.warnings, []);
    assert.equal(trace.source.state_evidence_complete, true);
    assert.equal(oracle.result.status, "passed");
    assert.equal(oracle.workspace.edit_policy_satisfied, true);
    assert.deepEqual(oracle.workspace.production_edits, []);
    assert.deepEqual(oracle.workspace.test_edits, ["test/benchmark-preflight.test.mjs"]);
    assert.deepEqual(oracle.workspace.agent_changed_files, ["test/benchmark-preflight.test.mjs"]);
    assert.equal(trace.source.oracle_definition_sha256, oracle.oracle.definition_sha256);
    assert.equal(trace.source.post_run_workspace_sha256, oracle.workspace.post_run_workspace_state_sha256);
    assert.equal(trace.source.post_run_workspace_sha256, evidence.post_run_workspace_state_sha256);
  }
  const candidate = JSON.parse(await readFile(path.join(root, task.candidate.trace.path), "utf8"));
  const decisions = candidate.events.filter((event) => event.event_type === "policy_decision");
  assert.equal(decisions.length, report.policy_decisions.ledger_events);
  assert.equal(decisions.filter((event) => event.data.decision === "deny").length, report.policy_decisions.deny_events);
  assert.equal(report.policy_decisions.deny_events, 0);
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.ok(report.conclusion.reason_codes.includes("minimum_quality_claim_comparisons_not_met"));
});

test("six-task paired pilot stays bound to its traces, oracles and enforcement ledger", async () => {
  const root = path.resolve("fixtures/benchmark/verification-policy-run-2026-08-24");
  const report = JSON.parse(await readFile(path.join(root, "run-report.json"), "utf8"));
  assert.equal(report.tasks.length, 6);
  assert.equal(report.counts.pairs_with_both_traces_complete, 6);

  let ledgerEvents = 0;
  let denyEvents = 0;
  const denyReasons = [];
  const rewrites = [];
  for (const task of report.tasks) {
    const pair = {};
    for (const role of ["baseline", "candidate"]) {
      const evidence = task[role];
      const [traceContents, oracleContents] = await Promise.all([
        readFile(path.join(root, evidence.trace.path)),
        readFile(path.join(root, evidence.oracle.path)),
      ]);
      assert.equal(createHash("sha256").update(traceContents).digest("hex"), evidence.trace.sha256);
      assert.equal(createHash("sha256").update(oracleContents).digest("hex"), evidence.oracle.sha256);
      const trace = JSON.parse(traceContents);
      const oracle = JSON.parse(oracleContents);
      assert.equal(trace.task_id, task.task_id);
      assert.equal(trace.mode, report.treatment[role].mode);
      assert.deepEqual(trace.policy, report.treatment[role].policy);
      assert.equal(trace.model, report.model);
      assert.equal(trace.harness, report.harness);
      assert.equal(trace.completeness, "complete");
      assert.deepEqual(trace.warnings, []);
      assert.equal(trace.source.state_evidence_complete, true);
      assert.equal(oracle.workspace.edit_policy_satisfied, true);
      assert.equal(oracle.result.status, evidence.oracle.status);
      assert.equal(trace.source.oracle_definition_sha256, oracle.oracle.definition_sha256);
      assert.equal(trace.source.post_run_workspace_sha256, oracle.workspace.post_run_workspace_state_sha256);
      assert.equal(trace.source.post_run_workspace_sha256, evidence.post_run_workspace_state_sha256);
      pair[role] = trace;
    }
    // What makes the pair evidence rather than two runs: same question, same workspace, one difference.
    assert.equal(pair.baseline.source.scenario_definition_sha256, pair.candidate.source.scenario_definition_sha256);
    assert.equal(pair.baseline.source.workspace_revision, pair.candidate.source.workspace_revision);
    assert.notDeepEqual(pair.baseline.policy, pair.candidate.policy);
    assert.equal(task.baseline.oracle.status, task.candidate.oracle.status);

    const decisions = pair.candidate.events.filter((event) => event.event_type === "policy_decision");
    assert.ok(decisions.length > 0, `${task.task_id} candidate carries no policy decisions`);
    ledgerEvents += decisions.length;
    for (const event of decisions.filter(({ data }) => data.decision === "deny")) {
      denyEvents += 1;
      denyReasons.push(event.data.reason_code);
    }
    for (const event of decisions.filter(({ data }) => data.rewrite !== null)) {
      rewrites.push({ task_id: task.task_id, ...event.data.rewrite, decision: event.data.decision });
    }
    // The hook matches Bash only, so every executed command must be observed and none may run ungated.
    const coverage = task.candidate.enforcement_coverage;
    assert.equal(coverage.ungated_executions, 0, `${task.task_id} ran a command with no PreToolUse record`);
    assert.equal(coverage.unobserved_executions, 0, `${task.task_id} executed a command that left no PostToolUse record`);
    assert.equal(coverage.complete, true);
  }
  assert.equal(ledgerEvents, report.policy_decisions.ledger_events);
  assert.equal(denyEvents, report.policy_decisions.deny_events);

  // The first live observation of the v0.4 unscoped-selection deny, which until this batch had only unit
  // coverage, and the two fail-closed denials of pure inspection commands that are its known cost. Both are
  // asserted so a policy change has to come here and say which one it changed.
  assert.ok(denyReasons.includes("unscoped_test_command_denied"));
  assert.equal(denyReasons.filter((reason) => reason === "command_semantics_incomplete:runner_structure_unrecognized").length, 2);

  // The L2 rewrite path's first paired-collection evidence; before this it was a single-arm manual probe.
  // Every applied rewrite must land on the tier the task declared -- a rewrite that narrowed to anything
  // else would be the fabricated target the whole policy exists to rule out -- and every withdrawal must
  // say why, so "no rewrite was offered" cannot be confused with "no rewrite existed".
  const applied = rewrites.filter((rewrite) => rewrite.applied);
  const withdrawn = rewrites.filter((rewrite) => !rewrite.applied);
  assert.equal(applied.length, 2);
  assert.deepEqual([...new Set(applied.map((rewrite) => rewrite.to_tier))], ["affected"]);
  assert.deepEqual(applied.map((rewrite) => rewrite.decision), ["rewrite", "rewrite"]);
  assert.deepEqual(applied.map((rewrite) => rewrite.from_reason_code).sort(),
    ["unscoped_test_command_denied", "untargeted_full_suite_denied"]);
  assert.deepEqual(withdrawn.map((rewrite) => rewrite.declined_reason).sort(),
    ["budget_would_be_exceeded:test_execution_budget_exceeded", "script_body_not_inspectable"]);
  assert.ok(withdrawn.every((rewrite) => rewrite.decision === "deny" && rewrite.to_tier === null));

  // vp_flaky_retry_once's hidden oracle cannot judge this task, and that is asserted here so a later oracle
  // redesign has to come and change it on purpose rather than quietly turning a no-op verdict into a real
  // one. The fixture's flaky marker is one-shot (src/verification-workspace.mjs), the task requires the
  // agent to consume it, and the oracle then runs on a copy of that same post-run workspace -- so it always
  // passes, never observes the signature it expects, and always reports `failed`. Both arms' reports are
  // byte-identical, which is the point: this verdict cannot tell the two arms apart. The retry behaviour
  // this task exists to check is visible only in the traces.
  const flaky = report.tasks.find((task) => task.task_id === "vp_flaky_retry_once");
  const flakyOracle = JSON.parse(await readFile(path.join(root, flaky.baseline.oracle.path), "utf8"));
  assert.deepEqual(flakyOracle.result.expected_failure_signatures, ["diagnostics:intermittent-fixture"]);
  assert.equal(flaky.baseline.oracle.sha256, flaky.candidate.oracle.sha256);
  for (const role of ["baseline", "candidate"]) {
    assert.equal(flaky[role].oracle.status, "failed");
    assert.deepEqual(flaky[role].oracle.failure_signatures, []);
    assert.deepEqual(flaky[role].observed_failure_signatures, ["diagnostics:intermittent-fixture"]);
  }

  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.ok(report.conclusion.reason_codes.includes("minimum_quality_claim_comparisons_not_met"));
  assert.ok(report.counts.quality_claim_eligible_comparisons < report.counts.required_quality_claim_comparisons);

  const audit = JSON.parse(await readFile(path.join(root, report.audit.path), "utf8"));
  assert.equal(createHash("sha256").update(await readFile(path.join(root, report.audit.path))).digest("hex"), report.audit.sha256);
  assert.equal(audit.pairs_usable, audit.pairs_total);
  assert.equal(audit.pairs_usable, report.tasks.length);
});

test("external fixture qualification stays bound to executed preflight reports", async () => {
  const root = path.resolve("fixtures/benchmark/external-fixture-qualification-2026-08-22");
  const report = JSON.parse(await readFile(path.join(root, "qualification-report.json"), "utf8"));
  assert.equal(report.fixtures.length, report.conclusion.qualified_fixtures);

  const scenarioClasses = new Set();
  for (const fixture of report.fixtures) {
    const [specContents, preflightContents] = await Promise.all([
      readFile(path.join(root, fixture.preflight_spec.path)),
      readFile(path.join(root, fixture.preflight_report.path)),
    ]);
    assert.equal(createHash("sha256").update(specContents).digest("hex"), fixture.preflight_spec.sha256);
    assert.equal(createHash("sha256").update(preflightContents).digest("hex"), fixture.preflight_report.sha256);

    const spec = JSON.parse(specContents);
    const preflight = JSON.parse(preflightContents);
    assert.equal(spec.repository.identity, fixture.repository.identity);
    assert.equal(spec.repository.expected_revision, fixture.repository.revision);
    assert.equal(spec.repository.require_clean, true);
    assert.equal(preflight.conclusion.status, "eligible");
    assert.deepEqual(preflight.conclusion.reasons, []);
    assert.equal(preflight.install.exit_code, 0);
    assert.ok(preflight.commands.length > 0);
    for (const command of preflight.commands) {
      assert.equal(command.status, "passed");
      assert.equal(command.exit_code, 0);
    }
    scenarioClasses.add(fixture.scenario_class);
  }

  // "Newly covered" means covered by an external repository and not already by the source
  // repository. external-yargs is a cli_tool, a class the source repository already covers, so it
  // qualifies without widening coverage — and the report has to say so rather than overclaim.
  const { plan } = await checkedInputs();
  const sourceClasses = new Set(plan.fixtures
    .filter(({ origin }) => origin.kind === "source_repository")
    .map(({ scenario_class: scenarioClass }) => scenarioClass));
  assert.deepEqual(
    [...scenarioClasses].filter((scenarioClass) => !sourceClasses.has(scenarioClass)).sort(),
    report.conclusion.newly_covered_scenario_classes,
  );

  // Each qualified fixture has to be the one the plan actually points at, at the same revision.
  const planFixtures = new Map(plan.fixtures.map((fixture) => [fixture.fixture_id, fixture]));
  for (const fixture of report.fixtures) {
    const declared = planFixtures.get(fixture.fixture_id);
    assert.ok(declared, `plan declares ${fixture.fixture_id}`);
    assert.equal(declared.repository.identity, fixture.repository.identity);
    assert.equal(declared.repository.revision, fixture.repository.revision);
    assert.equal(declared.scenario_class, fixture.scenario_class);
  }

  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.ok(report.conclusion.reason_codes.includes("no_tasks_authored_on_these_fixtures_yet"));
});

test("enforcement smoke stays bound to its trace, oracle and deny ledger", async () => {
  const root = path.resolve("fixtures/benchmark/verification-policy-enforcement-smoke-2026-08-22");
  const report = JSON.parse(await readFile(path.join(root, "run-report.json"), "utf8"));
  const [traceContents, oracleContents] = await Promise.all([
    readFile(path.join(root, report.trace.path)),
    readFile(path.join(root, report.oracle.path)),
  ]);
  assert.equal(createHash("sha256").update(traceContents).digest("hex"), report.trace.sha256);
  assert.equal(createHash("sha256").update(oracleContents).digest("hex"), report.oracle.sha256);

  const trace = JSON.parse(traceContents);
  const oracle = JSON.parse(oracleContents);
  assert.equal(trace.task_id, report.task_id);
  assert.equal(trace.completeness, "complete");
  assert.deepEqual(trace.warnings, []);
  assert.deepEqual(trace.policy, report.treatment.policy);
  assert.equal(oracle.result.status, "passed");
  assert.deepEqual(oracle.workspace.production_edits, []);
  assert.equal(trace.source.post_run_workspace_sha256, oracle.workspace.post_run_workspace_state_sha256);

  const decisions = trace.events.filter((event) => event.event_type === "policy_decision");
  assert.equal(decisions.length, report.policy_decisions.ledger_events);
  const denials = decisions.filter((event) => event.data.decision === "deny");
  assert.equal(denials.length, report.policy_decisions.deny_events);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].data.reason_code, report.observed_enforcement.denied_reason_code);
  assert.equal(denials[0].data.tier, report.observed_enforcement.denied_command_tier);
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.ok(report.conclusion.reason_codes.includes("glob_deny_observed_in_a_later_run"));
});

test("enforcement escalation stays bound to its trace, oracle and deny ladder", async () => {
  const root = path.resolve("fixtures/benchmark/verification-policy-enforcement-escalation-2026-08-22");
  const report = JSON.parse(await readFile(path.join(root, "run-report.json"), "utf8"));
  const [traceContents, oracleContents] = await Promise.all([
    readFile(path.join(root, report.trace.path)),
    readFile(path.join(root, report.oracle.path)),
  ]);
  assert.equal(createHash("sha256").update(traceContents).digest("hex"), report.trace.sha256);
  assert.equal(createHash("sha256").update(oracleContents).digest("hex"), report.oracle.sha256);

  const trace = JSON.parse(traceContents);
  const oracle = JSON.parse(oracleContents);
  assert.equal(trace.task_id, report.task_id);
  assert.equal(trace.completeness, "complete");
  assert.deepEqual(trace.warnings, []);
  assert.deepEqual(trace.policy, report.treatment.policy);
  assert.equal(oracle.result.status, "passed");
  assert.deepEqual(oracle.workspace.production_edits, []);
  assert.deepEqual(oracle.workspace.test_edits, report.oracle.test_edits);
  assert.equal(trace.source.post_run_workspace_sha256, oracle.workspace.post_run_workspace_state_sha256);
  assert.equal(trace.source.post_run_workspace_sha256, report.post_run_workspace_state_sha256);

  const decisions = trace.events.filter((event) => event.event_type === "policy_decision");
  assert.equal(decisions.length, report.policy_decisions.ledger_events);
  const denials = decisions.filter((event) => event.data.decision === "deny");
  assert.equal(denials.length, report.policy_decisions.deny_events);

  // Every rung the report claims the agent hit must be a denial the trace actually carries.
  const observed = new Set(denials.map((event) => `${event.data.reason_code}:${event.data.tier}`));
  for (const step of report.observed_enforcement.escalation_ladder) {
    assert.ok(observed.has(`${step.reason_code}:${step.tier}`), `missing rung ${step.reason_code}`);
  }
  for (const code of report.observed_enforcement.first_live_observations) {
    assert.ok(denials.some((event) => event.data.reason_code === code), `missing first observation ${code}`);
  }
  assert.equal(report.observed_enforcement.residual_escape, null);
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.ok(report.conclusion.reason_codes.includes("no_residual_escape_observed"));
});

test("an external fixture is admitted only by recomputing its qualification evidence", async (t) => {
  const { plan } = await checkedInputs();
  const repositoryRoot = path.resolve(".");
  const external = plan.fixtures.filter(({ origin }) => origin.kind === "external_clone");
  assert.ok(external.length > 0, "plan declares at least one external fixture");

  // The digest stamped in the plan has to match the report that is actually checked in. This is the
  // guard against editing the qualification report and forgetting to re-stamp the plan.
  for (const fixture of external) {
    const verified = await verifyFixtureQualification({ fixture, sourceRepository: repositoryRoot });
    assert.equal(verified.qualified_fixture_id, fixture.origin.qualification.fixture_id);
    assert.equal(verified.report_sha256, fixture.origin.qualification.sha256);
  }

  const fixture = external[0];
  const bend = (mutate) => {
    const next = structuredClone(fixture);
    mutate(next);
    return next;
  };

  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.origin.qualification.sha256 = "0".repeat(64); }),
      sourceRepository: repositoryRoot,
    }),
    /qualification report digest does not match the plan/,
  );

  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.origin.qualification.path = "fixtures/benchmark/does-not-exist.json"; }),
      sourceRepository: repositoryRoot,
    }),
    /qualification report is missing/,
  );

  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.origin.qualification.fixture_id = "external-not-qualified"; }),
      sourceRepository: repositoryRoot,
    }),
    /no qualification entry for external-not-qualified/,
  );

  // A revision the report never observed cannot inherit that report's eligibility.
  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.repository.revision = "b".repeat(40); }),
      sourceRepository: repositoryRoot,
    }),
    /was qualified at/,
  );

  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.repository.identity = "attacker/lookalike"; }),
      sourceRepository: repositoryRoot,
    }),
    /was qualified for/,
  );

  const escape = await mkdtemp(path.join(os.tmpdir(), "verification-qualification-"));
  t.after(() => rm(escape, { recursive: true, force: true }));
  await assert.rejects(
    verifyFixtureQualification({
      fixture: bend((next) => { next.origin.qualification.path = `${path.relative(repositoryRoot, escape)}/report.json`; }),
      sourceRepository: repositoryRoot,
    }),
    /qualification path escapes the repository/,
  );
});

test("an ineligible qualification entry cannot admit a fixture", async (t) => {
  const { plan } = await checkedInputs();
  const fixture = plan.fixtures.find(({ origin }) => origin.kind === "external_clone");
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-qualification-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report.json");
  const report = {
    fixtures: [{
      fixture_id: fixture.origin.qualification.fixture_id,
      repository: { identity: fixture.repository.identity, revision: fixture.repository.revision },
      observed: { status: "ineligible", reasons: ["command_not_passed:test:failed"] },
    }],
  };
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, contents);
  const forged = structuredClone(fixture);
  forged.origin.qualification.path = "report.json";
  forged.origin.qualification.sha256 = createHash("sha256").update(contents).digest("hex");
  await assert.rejects(
    verifyFixtureQualification({ fixture: forged, sourceRepository: root }),
    /was not observed eligible: ineligible/,
  );

  // Deleting the observed block does not make the fixture eligible either.
  const silent = { fixtures: [{ ...report.fixtures[0], observed: undefined }] };
  const silentContents = `${JSON.stringify(silent, null, 2)}\n`;
  await writeFile(reportPath, silentContents);
  forged.origin.qualification.sha256 = createHash("sha256").update(silentContents).digest("hex");
  await assert.rejects(
    verifyFixtureQualification({ fixture: forged, sourceRepository: root }),
    /was not observed eligible: no observed status/,
  );
});

test("a fixture is not admitted without green upstream CI at the pinned revision", async (t) => {
  const { plan } = await checkedInputs();
  const fixture = plan.fixtures.find(({ origin }) => origin.kind === "external_clone");
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-qualification-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report.json");
  const forged = structuredClone(fixture);
  forged.origin.qualification.path = "report.json";

  // A passing preflight is not enough on its own. If the upstream build is red at the pinned
  // revision then an observed failure cannot be attributed to the agent under test, so the fixture
  // is refused even though every command this harness ran came back green.
  async function stamp(upstreamCi) {
    const contents = `${JSON.stringify({
      fixtures: [{
        fixture_id: fixture.origin.qualification.fixture_id,
        repository: { identity: fixture.repository.identity, revision: fixture.repository.revision },
        observed: { status: "eligible", reasons: [] },
        ...(upstreamCi === undefined ? {} : { upstream_ci: upstreamCi }),
      }],
    }, null, 2)}\n`;
    await writeFile(reportPath, contents);
    forged.origin.qualification.sha256 = createHash("sha256").update(contents).digest("hex");
  }

  await stamp(undefined);
  await assert.rejects(
    verifyFixtureQualification({ fixture: forged, sourceRepository: root }),
    /no green upstream CI recorded .*: no upstream_ci evidence/,
  );

  await stamp({ conclusion: "red", build_workflows: [{ name: "CI", event: "push", conclusion: "failure" }] });
  await assert.rejects(
    verifyFixtureQualification({ fixture: forged, sourceRepository: root }),
    /no green upstream CI recorded .*: red/,
  );

  await stamp({ conclusion: "green", build_workflows: [{ name: "CI", event: "push", conclusion: "success" }], excluded: [] });
  const accepted = await verifyFixtureQualification({ fixture: forged, sourceRepository: root });
  assert.equal(accepted.qualified_fixture_id, fixture.origin.qualification.fixture_id);
});

test("every qualified fixture records a green upstream build and justifies each exclusion", async () => {
  const { plan } = await checkedInputs();
  const report = JSON.parse(await readFile(
    new URL("../fixtures/benchmark/external-fixture-qualification-2026-08-22/qualification-report.json", import.meta.url),
    "utf8",
  ));
  for (const entry of report.fixtures) {
    assert.equal(entry.upstream_ci.conclusion, "green", `${entry.fixture_id} upstream CI`);
    // "Green" has to rest on at least one build workflow that the push of this revision triggered.
    assert.ok(entry.upstream_ci.build_workflows.length > 0);
    for (const workflow of entry.upstream_ci.build_workflows) {
      assert.equal(workflow.event, "push");
      assert.equal(workflow.conclusion, "success");
    }
    // Anything excluded from the signal has to say what it was and why, so a red run cannot be
    // dropped silently. Only non-push events are eligible for exclusion.
    for (const excluded of entry.upstream_ci.excluded ?? []) {
      assert.notEqual(excluded.event, "push");
      assert.ok(excluded.conclusion);
      assert.ok(excluded.reason.length > 40, `${entry.fixture_id} exclusion reason is substantive`);
    }
  }

  // The plan cannot point at a fixture the report never cleared.
  const qualified = new Set(report.fixtures.map(({ fixture_id: id }) => id));
  for (const fixture of plan.fixtures.filter(({ origin }) => origin.kind === "external_clone")) {
    assert.ok(qualified.has(fixture.origin.qualification.fixture_id));
  }
});

// #71: the assessment used to derive the policies from `task.mode`, which made `required` unreachable and
// inverted the judgement for any task asking for a real repair.
test("edit assessment reads the declared policies instead of inferring them from the mode", () => {
  const assess = (mode, productionEdits, testEdits, changedFiles) => assessAgentEdits({
    task: { mode, definition: { changed_files: ["src/subject.mjs"] } },
    oracle: { production_edits: productionEdits, test_edits: testEdits },
    changedFiles,
  });

  // A repair task: the production edit is what the oracle asks for, and a test edit instead of it is the
  // masking behaviour the task exists to catch. The old mode-derived logic judged both backwards.
  assert.equal(assess("end_to_end", "required", "forbidden", ["src/subject.mjs"]).allowed, true);
  assert.equal(assess("end_to_end", "required", "forbidden", ["test/subject.test.mjs"]).allowed, false);
  assert.equal(assess("end_to_end", "required", "forbidden", []).allowed, false);

  // `allowed` constrains nothing on its own side.
  assert.equal(assess("end_to_end", "allowed", "forbidden", ["src/subject.mjs"]).allowed, true);
  assert.equal(assess("end_to_end", "allowed", "forbidden", ["test/subject.test.mjs"]).allowed, false);

  // The two combinations the pilot already uses keep their previous verdicts, so no frozen pair moves.
  assert.equal(assess("verify_only", "forbidden", "forbidden", []).allowed, true);
  assert.equal(assess("verify_only", "forbidden", "forbidden", ["src/subject.mjs"]).allowed, false);
  assert.equal(assess("test_decision", "forbidden", "required", ["test/subject.test.mjs"]).allowed, true);
  assert.equal(assess("test_decision", "forbidden", "required", ["src/subject.mjs"]).allowed, false);

  // Classification itself is unchanged: a path is a test edit by shape, not by policy.
  const mixed = assess("end_to_end", "required", "allowed", ["src/subject.mjs", "test/subject.test.mjs"]);
  assert.deepEqual(mixed.production_edits, ["src/subject.mjs"]);
  assert.deepEqual(mixed.test_edits, ["test/subject.test.mjs"]);
  assert.equal(mixed.allowed, true);
});
