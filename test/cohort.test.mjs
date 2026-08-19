import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditBaselineCohort, environmentManifestDigest, validateCohortManifest } from "../src/cohort.mjs";

const revision = "a".repeat(40);

async function baseTrace() {
  const trace = JSON.parse(await readFile("fixtures/traces/success.json", "utf8"));
  trace.trace_id = "trace-task-001";
  trace.task_id = "task-001";
  trace.repository = "fixture/project";
  trace.repository_commit = revision;
  return trace;
}

function environment() {
  return {
    schema_version: 1,
    evidence_class: "benchmark_environment",
    benchmark_id: "fixture-benchmark",
    repository: { identity: "fixture/project", expected_revision: revision, observed_revision: revision, clean: true },
    conclusion: { status: "eligible", reasons: [] },
  };
}

function cohort(manifest, taskOverrides = {}) {
  return {
    schema_version: 1,
    cohort_id: "fixture-baseline",
    cohort_version: 1,
    evidence_class: "planning",
    repository: { identity: "fixture/project", kind: "coding-agent" },
    environment_manifest_digest: environmentManifestDigest(manifest),
    minimum_baseline_tasks: 30,
    tasks: [
      { task_id: "task-001", status: "collected", trace_id: "trace-task-001", trace_path: "traces/task-001.json", repository_commit: revision, environment_manifest_digest: environmentManifestDigest(manifest), evidence: { environment_status: "eligible", install_status: "passed", build_status: "passed", test_status: "passed", clean_worktree: true, failure_class: "none", oracle_status: "passed", oracle_failure_signatures: [] }, ...taskOverrides },
      { task_id: "task-002", status: "planned" },
    ],
  };
}

test("derives eligibility and reports the remaining baseline evidence deficit", async () => {
  const manifest = environment();
  const trace = await baseTrace();
  const report = auditBaselineCohort({ cohort: cohort(manifest), environment: manifest, traces: new Map([["task-001", trace]]) });
  assert.equal(report.conclusion.status, "evidence_insufficient");
  assert.equal(report.conclusion.quality_claim_eligible, false);
  assert.deepEqual(report.counts, {
    declared_tasks: 2,
    planned_tasks: 1,
    collected_tasks: 1,
    excluded_tasks: 0,
    quality_claim_eligible_tasks: 1,
    required_baseline_tasks: 30,
    evidence_deficit: 29,
  });
  assert.equal(report.tasks[0].quality_claim_eligible, true);
  assert.deepEqual(report.tasks[1].reasons, ["task_status:planned"]);
});

test("does not trust caller-declared eligibility or mismatched evidence", async () => {
  const manifest = environment();
  const invalid = cohort(manifest, { quality_claim_eligible: true });
  assert.ok(validateCohortManifest(invalid).some(({ path }) => path.endsWith("quality_claim_eligible")));

  const mismatch = cohort(manifest, { environment_manifest_digest: "b".repeat(64) });
  const trace = await baseTrace();
  const report = auditBaselineCohort({ cohort: { ...mismatch, tasks: [mismatch.tasks[0]] }, environment: manifest, traces: new Map([["task-001", trace]]) });
  assert.equal(report.tasks[0].quality_claim_eligible, false);
  assert.deepEqual(report.tasks[0].reasons, ["environment_manifest_mismatch"]);
});

test("does not allow callers to lower the 30-task evidence floor", () => {
  const manifest = environment();
  const input = cohort(manifest);
  input.minimum_baseline_tasks = 1;
  assert.ok(validateCohortManifest(input).some(({ path, message }) => path === "minimum_baseline_tasks" && message.includes("at least 30")));
});

test("excludes infrastructure and pre-existing failures from the eligible count", async () => {
  const manifest = environment();
  const trace = await baseTrace();
  const task = cohort(manifest).tasks[0];
  task.evidence.failure_class = "environment";
  const report = auditBaselineCohort({ cohort: { ...cohort(manifest), tasks: [task] }, environment: manifest, traces: new Map([["task-001", trace]]) });
  assert.equal(report.counts.quality_claim_eligible_tasks, 0);
  assert.deepEqual(report.tasks[0].reasons, ["environment_failure"]);
});

test("requires a complete baseline trace tied to the pinned repository", async () => {
  const manifest = environment();
  const trace = await baseTrace();
  trace.completeness = "partial";
  trace.events = trace.events.slice(0, -1);
  const report = auditBaselineCohort({ cohort: { ...cohort(manifest), tasks: [cohort(manifest).tasks[0]] }, environment: manifest, traces: new Map([["task-001", trace]]) });
  assert.equal(report.tasks[0].quality_claim_eligible, false);
  assert.ok(report.tasks[0].reasons.includes("trace_invalid"));
  assert.ok(report.tasks[0].reasons.includes("trace_incomplete"));
});

test("rejects an ineligible environment before counting tasks", async () => {
  const manifest = environment();
  manifest.conclusion.status = "ineligible";
  assert.throws(
    () => auditBaselineCohort({ cohort: cohort(manifest), environment: manifest, traces: new Map() }),
    /Environment manifest must be eligible/,
  );
});

test("CLI writes the explicit evidence deficit and exits with code 2", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baseline-cohort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "traces"));
  const manifest = environment();
  const input = cohort(manifest);
  await writeFile(path.join(root, "environment.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "cohort.json"), JSON.stringify(input));
  await writeFile(path.join(root, "traces", "task-001.json"), JSON.stringify(await baseTrace()));
  const cliPath = fileURLToPath(new URL("../src/cohort-cli.mjs", import.meta.url));
  let failure;
  try {
    execFileSync(process.execPath, [cliPath, "--cohort", path.join(root, "cohort.json"), "--environment", path.join(root, "environment.json"), "--output", path.join(root, "report.json")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 2);
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  assert.equal(report.conclusion.status, "evidence_insufficient");
  assert.equal(report.counts.evidence_deficit, 29);
});
