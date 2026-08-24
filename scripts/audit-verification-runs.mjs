#!/usr/bin/env node

// Decides which collected (task, arm) runs are usable paired evidence, from the raw evidence rather than
// from what the collection driver recorded about itself.
//
// The driver checks each run as it writes it, which leaves two gaps this closes. Runs collected before a
// check existed carry no verdict for it -- the first batch here predates the enforcement-coverage check
// entirely -- and no single run can check the thing that makes a pair evidence: that both arms were asked
// the same question about the same workspace. Both are re-derived here so adding a check does not mean
// re-running agents.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ARM_DIRECTORIES = ["baseline", "candidate"];

function usage() {
  return "Usage: node scripts/audit-verification-runs.mjs --root DIRECTORY [--json OUTPUT_JSON]\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--root", "--json"].includes(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

function ndjsonRecords(contents) {
  return contents.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

// Every path recorded inside run.json is absolute and was correct when written. A run directory renamed
// afterwards -- which is how failed runs are kept for reference here -- leaves those paths pointing at
// whatever now occupies the old name, so a stale ledger reads as this run's. Resolve inside the directory.
function evidencePaths(runDir) {
  return {
    trace: path.join(runDir, "trace.json"),
    oracle: path.join(runDir, "oracle.json"),
    ledger: path.join(runDir, "hook", "state", "policy-decisions.ndjson"),
    lifecycleDir: path.join(runDir, "lifecycle"),
    agentStderr: path.join(runDir, "agent.err"),
  };
}

function stableId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// Paired by tool_use_id, not counted. Every executed command must leave a PostToolUse record and every
// PostToolUse record must have a PreToolUse behind it; a command that ran ungated is what this arm exists
// to rule out. The reverse -- gated and then never executed -- is not a hole: denials are the intended
// case, and codex also drops the sibling calls of a parallel batch containing a deny, and sometimes fails
// to create the exec process at all. Those are reported, not scored.
function enforcementCoverage(ledgerRecords, shellCommands) {
  const preByTool = new Map();
  const postTools = new Set();
  for (const record of ledgerRecords) {
    if (record.event === "policy.pre_tool") preByTool.set(record.tool_use_id_sha256, record);
    if (record.event === "policy.post_tool") postTools.add(record.tool_use_id_sha256);
  }
  const postRecords = ledgerRecords.filter((record) => record.event === "policy.post_tool").length;
  const ungatedExecutions = [...postTools].filter((tool) => !preByTool.has(tool)).length;
  return {
    shell_commands: shellCommands,
    pre_tool_records: preByTool.size,
    post_tool_records: postRecords,
    denials: ledgerRecords.filter((record) => record.decision === "deny").length,
    ungated_executions: ungatedExecutions,
    unobserved_executions: shellCommands - postRecords,
    approved_not_executed: [...preByTool].filter(([tool, record]) => record.decision !== "deny" && !postTools.has(tool)).length,
    complete: postRecords === shellCommands && ungatedExecutions === 0,
  };
}

async function auditRun(runDir) {
  const run = await readJson(path.join(runDir, "run.json"));
  const paths = evidencePaths(runDir);
  const failures = [];
  const notes = [];

  if (run.agent.timed_out) failures.push("agent_killed_by_harness_timeout");
  if (run.agent.exit_code !== 0) failures.push(`agent_exit_${run.agent.exit_code}`);

  let trace = null;
  if (!(await exists(paths.trace))) failures.push("trace_missing");
  else {
    trace = await readJson(paths.trace);
    if (trace.completeness !== "complete") failures.push(`trace_${trace.completeness}`);
    if ((trace.warnings ?? []).length > 0) failures.push(`trace_warnings:${trace.warnings.join(",")}`);
    if (trace.source.state_evidence_complete !== true) failures.push("trace_state_evidence_incomplete");
    // The trace is only about this run if the version it names is the one the arm was built from.
    if (trace.policy?.version !== run.policy.version) failures.push("trace_policy_version_mismatch");
  }
  if (run.trace.exit_code !== 0) failures.push(`trace_cli_exit_${run.trace.exit_code}`);

  let oracle = null;
  if (!(await exists(paths.oracle))) failures.push("oracle_missing");
  else {
    oracle = await readJson(paths.oracle);
    // A failing hidden oracle is a result, not a collection fault -- some tasks are supposed to fail. What
    // must hold is that the oracle judged the same workspace the trace describes.
    if (!["passed", "failed", "undecided"].includes(oracle.result.status)) failures.push(`oracle_status_${oracle.result.status}`);
    // `undecided` is a legitimate status, but only when the oracle declared upfront why it cannot decide and
    // named what does. Recompute that from the report rather than trusting the status alone: an oracle that
    // claims undecidability without a reason is hiding a real failure behind it.
    if (oracle.result.status === "undecided") {
      if (!oracle.result.undecidable_reason) failures.push("undecided_oracle_without_reason");
      if (oracle.result.deciding_evidence !== "trace_only") failures.push("undecided_oracle_without_deciding_evidence");
      if ((oracle.execution?.results ?? []).length !== 0) failures.push("undecided_oracle_executed_commands");
      if ((oracle.result.failure_signatures ?? []).length !== 0) failures.push("undecided_oracle_claimed_signatures");
    }
    if (oracle.workspace.edit_policy_satisfied !== true) failures.push("edit_policy_violated");
    if (trace && oracle.workspace.post_run_workspace_state_sha256 !== trace.source.post_run_workspace_sha256) {
      failures.push("oracle_trace_workspace_digest_mismatch");
    }
  }

  let coverage = null;
  const expectsLedger = run.mode === "shadow";
  if (expectsLedger) {
    if (!(await exists(paths.ledger))) failures.push("policy_ledger_missing");
    else {
      const ledgerRecords = ndjsonRecords(await readFile(paths.ledger, "utf8"));
      if (ledgerRecords.length === 0) failures.push("policy_ledger_empty");
      coverage = enforcementCoverage(ledgerRecords, run.agent.shell_commands);
      if (!coverage.complete) {
        failures.push(`enforcement_incomplete:${coverage.unobserved_executions}_unobserved_${coverage.ungated_executions}_ungated`);
      }
      // The ledger records sha256(session_id).slice(0, 16) unsalted and codex's lifecycle thread id is that
      // same session id, so a ledger left behind by an earlier run is decidable rather than indistinguishable
      // from a run that simply stayed inside every budget.
      const sessions = [...new Set(ledgerRecords.map((record) => record.session_id_sha256))];
      const expected = typeof run.agent.thread_id === "string" ? stableId(run.agent.thread_id) : null;
      if (expected === null) failures.push("policy_ledger_session_unbindable");
      else if (sessions.length !== 1 || sessions[0] !== expected) failures.push("policy_ledger_session_mismatch");
      if (coverage.approved_not_executed > 0) {
        const unifiedExecFailures = (await exists(paths.agentStderr))
          ? ((await readFile(paths.agentStderr, "utf8")).match(/unified exec process/g) ?? []).length
          : 0;
        notes.push(`${coverage.approved_not_executed} gated command(s) never executed (${coverage.denials} denial(s), ${unifiedExecFailures} unified-exec failure(s))`);
      }
    }
  } else if (await exists(paths.ledger)) {
    // The baseline arm has no hook by design, so a ledger here means the arms differed in more than one way.
    failures.push("baseline_arm_carries_policy_ledger");
  }

  return {
    task_id: run.task_id,
    arm: path.basename(runDir),
    mode: run.mode,
    policy: run.policy,
    harness: run.harness,
    model: run.model,
    effort: run.model_reasoning_effort,
    prompt_sha256: run.prompt_sha256,
    workspace_revision: run.workspace_revision,
    scenario_definition_sha256: run.scenario_definition_sha256,
    collector_sha256: run.collector_sha256,
    shell_commands: run.agent.shell_commands,
    oracle_status: oracle?.result.status ?? null,
    trace_completeness: trace?.completeness ?? null,
    enforcement_coverage: coverage,
    usable: failures.length === 0,
    failures,
    notes,
  };
}

// A pair is evidence only if the two arms differ in exactly one way. Everything the driver derives per run
// is compared here, because "same task, same workspace, same prompt" is a property of the pair and no
// single run can assert it.
const PAIRED_FIELDS = [
  "prompt_sha256",
  "scenario_definition_sha256",
  "workspace_revision",
  "harness",
  "model",
  "effort",
  "collector_sha256",
];

function auditPair(taskId, baseline, candidate) {
  const failures = [];
  if (!baseline) failures.push("baseline_arm_missing");
  if (!candidate) failures.push("candidate_arm_missing");
  if (baseline && candidate) {
    for (const field of PAIRED_FIELDS) {
      if (baseline[field] !== candidate[field]) failures.push(`${field}_differs`);
    }
    if (baseline.mode !== "baseline") failures.push(`baseline_mode_${baseline.mode}`);
    if (candidate.mode !== "shadow") failures.push(`candidate_mode_${candidate.mode}`);
    if (baseline.policy.name === candidate.policy.name) failures.push("arms_share_policy_identity");
    // Both arms must have been judged, and judged the same way, or the comparison is between a run that
    // solved the task and a run that was measured against a different bar.
    if (baseline.oracle_status !== candidate.oracle_status) failures.push("oracle_status_differs");
  }
  const armFailures = [baseline, candidate].filter(Boolean).filter((arm) => !arm.usable).map((arm) => `${arm.arm}_unusable`);
  return {
    task_id: taskId,
    usable: failures.length === 0 && armFailures.length === 0,
    failures: [...failures, ...armFailures],
    baseline,
    candidate,
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.root) throw new Error("--root is required");
  const root = path.resolve(options.root);

  const taskIds = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const pairs = [];
  const archived = [];
  for (const taskId of taskIds) {
    const armNames = (await readdir(path.join(root, taskId), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const audits = {};
    for (const armName of armNames) {
      const runDir = path.join(root, taskId, armName);
      if (!(await exists(path.join(runDir, "run.json")))) continue;
      const audit = await auditRun(runDir);
      // Runs kept for reference under a renamed directory are listed rather than dropped, so a reader can
      // see that a task was collected more than once and why the earlier attempt was set aside.
      if (ARM_DIRECTORIES.includes(armName)) audits[armName] = audit;
      else archived.push(audit);
    }
    pairs.push(auditPair(taskId, audits.baseline ?? null, audits.candidate ?? null));
  }

  const usablePairs = pairs.filter((pair) => pair.usable);
  const report = {
    schema_version: 1,
    root,
    pairs_total: pairs.length,
    pairs_usable: usablePairs.length,
    pairs,
    archived_runs: archived,
  };
  if (options.json) {
    await (await import("node:fs/promises")).writeFile(path.resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const column = (value, width) => String(value).padEnd(width);
  process.stdout.write(`${column("task", 34)}${column("pair", 10)}${column("oracle", 8)}cmds b/c   enforcement\n`);
  for (const pair of pairs) {
    const coverage = pair.candidate?.enforcement_coverage;
    const enforcement = coverage === null || coverage === undefined
      ? "-"
      : `${coverage.post_tool_records}/${coverage.shell_commands} gated, ${coverage.denials} deny`;
    process.stdout.write(`${column(pair.task_id, 34)}${column(pair.usable ? "ok" : "UNUSABLE", 10)}${column(pair.baseline?.oracle_status ?? "-", 8)}`
      + `${column(`${pair.baseline?.shell_commands ?? "-"}/${pair.candidate?.shell_commands ?? "-"}`, 10)}${enforcement}\n`);
    for (const failure of pair.failures) process.stdout.write(`  ! ${failure}\n`);
    for (const arm of [pair.baseline, pair.candidate].filter(Boolean)) {
      for (const failure of arm.failures) process.stdout.write(`  ! ${arm.arm}: ${failure}\n`);
      for (const note of arm.notes) process.stdout.write(`  - ${arm.arm}: ${note}\n`);
    }
  }
  for (const run of archived) {
    const coverage = run.enforcement_coverage;
    const enforcement = coverage === null ? "-" : `${coverage.post_tool_records}/${coverage.shell_commands} gated, ${coverage.denials} deny`;
    process.stdout.write(`${column(run.task_id, 34)}${column("archived", 10)}${column(run.oracle_status ?? "-", 8)}${column(run.shell_commands, 10)}${enforcement}\n`);
    process.stdout.write(`  = ${run.arm}\n`);
    for (const failure of run.failures) process.stdout.write(`  ! ${failure}\n`);
    for (const note of run.notes) process.stdout.write(`  - ${note}\n`);
  }
  process.stdout.write(`\n${usablePairs.length}/${pairs.length} pairs usable as evidence\n`);
  if (usablePairs.length !== pairs.length) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
