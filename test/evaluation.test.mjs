import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { evaluateCohort } from "../src/evaluation.mjs";

const execFileAsync = promisify(execFile);

async function loadCohort() {
  const cohort = JSON.parse(await readFile(path.resolve("fixtures/evaluation/cohort-v1.json"), "utf8"));
  const traces = new Map();
  for (const descriptor of cohort.traces) {
    traces.set(descriptor.id, JSON.parse(await readFile(path.resolve(descriptor.path), "utf8")));
  }
  return { cohort, traces };
}

test("canonical evaluation is deterministic and refuses a positive claim", async () => {
  const { cohort, traces } = await loadCohort();
  const first = evaluateCohort(cohort, traces);
  const second = evaluateCohort(cohort, traces);

  assert.deepEqual(first, second);
  assert.equal(first.report_version, 1);
  assert.match(first.cohort.input_digest, /^[a-f0-9]{64}$/);
  assert.equal(first.metrics.event_completeness.value, 1);
  assert.equal(first.metrics.command_normalization.value, 1);
  assert.equal(first.metrics.diagnostic_precision.value, 1);
  assert.equal(first.metrics.replay_correctness.value, 1);
  assert.equal(first.metrics.comparison_integrity.value, 1);
  assert.equal(first.metrics.final_oracle_match.value, 1);
  assert.equal(first.metrics.baseline_failure_recall.value, 1);
  assert.equal(first.metrics.candidate_failure_recall.value, 1);
  assert.equal(first.metrics.verification_cost.median_duration_reduction, 0.25);
  assert.equal(first.metrics.verification_cost.median_command_reduction, 0.25);
  assert.equal(first.metrics.verification_cost.command_reduction_denominator, 4);
  assert.equal(first.metrics.evidence_sufficiency.eligible_comparisons, 0);
  assert.equal(first.metrics.evidence_sufficiency.oracle_failures, 0);
  assert.equal(first.metrics.evidence_sufficiency.calibration_oracle_failures, 3);
  assert.equal(first.conclusion.status, "evidence_insufficient");
  assert.equal(first.conclusion.efficiency_claim, "not_supported");
  assert.ok(first.conclusion.reason_codes.includes("canonical_fixtures_are_not_benchmark_evidence"));
  assert.ok(first.conclusion.reason_codes.includes("insufficient_quality_claim_comparisons"));
  assert.ok(first.gates.every((gate) => gate.definition && Object.hasOwn(gate, "threshold")));
});

test("a failed failure-recall safety gate blocks efficiency claims", async () => {
  const { cohort, traces } = await loadCohort();
  const damaged = structuredClone(traces.get("unattributed-retry-suppressed"));
  damaged.events.find((event) => event.event_type === "test_result").data.failure_signature = null;
  traces.set("unattributed-retry-suppressed", damaged);
  const report = evaluateCohort(cohort, traces);

  assert.equal(report.metrics.candidate_failure_recall.value, 0.666667);
  assert.equal(report.gates.find((gate) => gate.id === "failure_recall").status, "fail");
  assert.equal(report.gates.find((gate) => gate.id === "failure_recall").non_regression_delta, -0.333333);
  assert.equal(report.conclusion.status, "rejected");
  assert.equal(report.conclusion.efficiency_claim, "blocked");
  assert.ok(report.conclusion.reason_codes.includes("failed_safety_gate:failure_recall"));
});

test("positive claims require explicit observed evidence and passing gates", async () => {
  const { cohort, traces } = await loadCohort();
  cohort.evidence_class = "observed_benchmark";
  cohort.thresholds.minimum_quality_claim_comparisons = cohort.comparisons.length;
  cohort.thresholds.minimum_oracle_failures = 3;
  cohort.thresholds.minimum_command_reduction = 0.25;
  for (const comparison of cohort.comparisons) comparison.quality_claim_eligible = true;
  const report = evaluateCohort(cohort, traces);

  assert.equal(report.gates.every((gate) => gate.status === "pass"), true);
  assert.equal(report.conclusion.status, "eligible");
  assert.equal(report.conclusion.efficiency_claim, "supported");
});

test("evaluation CLI writes a versioned report in one command", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "evaluation-cli-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputPath = path.join(temporaryRoot, "report.json");
  const { stdout } = await execFileAsync(process.execPath, ["src/evaluate-cli.mjs", "--output", outputPath]);
  const summary = JSON.parse(stdout);
  const report = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(summary.output, outputPath);
  assert.equal(summary.status, "evidence_insufficient");
  assert.equal(report.report_version, 1);
  assert.equal(report.conclusion.efficiency_claim, "not_supported");
});
