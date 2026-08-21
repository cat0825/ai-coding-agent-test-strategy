import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCollectorProvenance } from "../src/collector-provenance.mjs";
import { runVerificationPolicyOracle } from "../src/verification-policy-oracle.mjs";
import {
  matchRequiredFailureSignatures,
  materializeVerificationTask,
  qualifyVerificationPilot,
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
