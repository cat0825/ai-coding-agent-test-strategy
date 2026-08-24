import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const revision = "9".repeat(40);
const postRunDigest = "b".repeat(64);

// The auditor reads a run tree, so these are the minimum records one usable baseline arm leaves behind.
// Only the fields the auditor recomputes matter; everything else is elided rather than faked in detail.
function runRecord() {
  return {
    schema_version: 1,
    task_id: "vp_flaky_retry_once",
    arm: "baseline",
    mode: "baseline",
    policy: { name: "unmanaged-coding-agent-baseline", version: "1" },
    harness: "codex-cli 0.147.0",
    model: "gpt-5.6-sol",
    model_reasoning_effort: "high",
    prompt_sha256: "c".repeat(64),
    workspace: "fixtures/verification-policy-pilot",
    workspace_revision: revision,
    scenario_definition_sha256: "d".repeat(64),
    collector_sha256: "e".repeat(64),
    agent: { exit_code: 0, timed_out: false, shell_commands: [], thread_id: null, unified_exec_failures: 0 },
    oracle: { exit_code: 0 },
    trace: { exit_code: 0 },
  };
}

function traceReport() {
  return {
    completeness: "complete",
    warnings: [],
    policy: { version: "1" },
    source: { state_evidence_complete: true, post_run_workspace_sha256: postRunDigest },
  };
}

// The shape the oracle runner now emits for a task it declared it cannot decide on a post-run copy.
function undecidedOracle() {
  return {
    result: {
      status: "undecided",
      undecidable_reason: "the flaky marker is consumed by the agent's first run",
      deciding_evidence: "trace_only",
      failure_signatures: [],
    },
    execution: { results: [] },
    workspace: { edit_policy_satisfied: true, post_run_workspace_state_sha256: postRunDigest },
  };
}

// Only the baseline arm is built, so the pair is unusable by construction; these tests read the arm's own
// failure list, which is where a status judgement lands.
async function auditTree(oracle) {
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-runs-"));
  const runDir = path.join(root, "vp_flaky_retry_once", "baseline");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(runRecord()), "utf8");
  await writeFile(path.join(runDir, "trace.json"), JSON.stringify(traceReport()), "utf8");
  await writeFile(path.join(runDir, "oracle.json"), JSON.stringify(oracle), "utf8");
  const reportPath = path.join(root, "audit.json");
  const result = spawnSync(process.execPath, ["scripts/audit-verification-runs.mjs", "--root", root, "--json", reportPath], { encoding: "utf8" });
  assert.equal(result.stderr, "", result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  await rm(root, { recursive: true, force: true });
  assert.equal(report.pairs.length, 1);
  return report.pairs[0].baseline;
}

test("an undecided oracle is a usable run, not a collection fault", async () => {
  const arm = await auditTree(undecidedOracle());
  assert.equal(arm.oracle_status, "undecided");
  assert.deepEqual(arm.failures, []);
  assert.equal(arm.usable, true);
});

test("undecidability must be declared, unexecuted and unclaimed", async () => {
  const cases = [
    ["undecided_oracle_without_reason", (oracle) => delete oracle.result.undecidable_reason],
    ["undecided_oracle_without_deciding_evidence", (oracle) => (oracle.result.deciding_evidence = "independent_oracle")],
    // An oracle that ran its commands and then reported `undecided` is hiding a real judgement behind the status.
    ["undecided_oracle_executed_commands", (oracle) => oracle.execution.results.push({ exit_code: 0 })],
    ["undecided_oracle_claimed_signatures", (oracle) => oracle.result.failure_signatures.push("retry_without_change")],
  ];
  for (const [expected, corrupt] of cases) {
    const oracle = undecidedOracle();
    corrupt(oracle);
    const arm = await auditTree(oracle);
    assert.ok(arm.failures.includes(expected), `expected ${expected}, got ${JSON.stringify(arm.failures)}`);
    assert.equal(arm.usable, false);
  }
});

test("an unknown oracle status is still rejected", async () => {
  const oracle = undecidedOracle();
  oracle.result.status = "skipped";
  const arm = await auditTree(oracle);
  assert.ok(arm.failures.includes("oracle_status_skipped"));
  assert.equal(arm.usable, false);
});
