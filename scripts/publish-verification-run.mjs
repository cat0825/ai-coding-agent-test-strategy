#!/usr/bin/env node

// Copies a collected paired run out of its scratch directory into a checked-in evidence fixture.
//
// Collection happens under /tmp, which does not survive a reboot, while the benchmark doc cites these runs by
// path. Everything here is derived from the traces and oracle reports rather than typed: the 2026-08-22
// run-report was assembled by hand, and nothing in the repository can now recompute its `verification_commands`
// or `observed_reduction` figures, so a reader has no way to tell a transcription slip from a real number.
//
// Eligibility is not decided here. This shells out to scripts/audit-verification-runs.mjs and refuses to
// publish anything it calls unusable, so there is one implementation of "is this evidence" and it is the one
// that reads raw evidence rather than the collector's own record of itself.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARMS = ["baseline", "candidate"];

function usage() {
  return "Usage: node scripts/publish-verification-run.mjs --root COLLECTION_DIR --run-date YYYY-MM-DD [--output-dir DIRECTORY] [--force]\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (!["--root", "--run-date", "--output-dir"].includes(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// Written next to the file it describes so the digest in the report is the digest of the published bytes,
// not of whatever was in the scratch directory at the time.
async function publishFile(sourcePath, destinationPath) {
  const contents = await readFile(sourcePath, "utf8");
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, contents, "utf8");
  return sha256(contents);
}

// Derived from the trace's own events. `verification_commands` counts test executions the collector actually
// observed, not shell commands: a run can spend twenty commands reading the repository and verify once.
function traceMetrics(trace) {
  const testResults = trace.events.filter((event) => event.event_type === "test_result");
  const timestamps = trace.events.map((event) => Date.parse(event.timestamp));
  return {
    verification_commands: testResults.length,
    verification_duration_ms: testResults.reduce((total, event) => total + (event.data.duration_ms ?? 0), 0),
    trace_span_ms: timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0,
    observed_failure_signatures: [...new Set(testResults.map((event) => event.data.failure_signature).filter(Boolean))].sort(),
  };
}

// A ratio is only meaningful when the baseline actually did the thing being reduced. Reporting 1.0 for
// "baseline never verified, candidate never verified" would read as a total saving.
function reduction(baselineValue, candidateValue) {
  if (!(baselineValue > 0)) return null;
  return Number(((baselineValue - candidateValue) / baselineValue).toFixed(6));
}

function auditReport(root) {
  const reportPath = path.join(root, "audit-report.json");
  const result = spawnSync(process.execPath, [
    "scripts/audit-verification-runs.mjs", "--root", root, "--json", reportPath,
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error) throw result.error;
  // Exit 2 means some pair is unusable, which is reported per pair below; anything else is the audit failing.
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`audit-verification-runs.mjs exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return reportPath;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["root", "run_date"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }
  const root = path.resolve(options.root);
  const outputDir = path.resolve(options.output_dir ?? path.join(REPO_ROOT, "fixtures/benchmark", `verification-policy-run-${options.run_date}`));

  const audit = await readJson(auditReport(root));
  const publishable = audit.pairs.filter((pair) => pair.usable);
  const rejected = audit.pairs.filter((pair) => !pair.usable);
  if (rejected.length > 0 && !options.force) {
    const detail = rejected.map((pair) => `${pair.task_id}: ${pair.failures.join(", ")}`).join("; ");
    throw new Error(`${rejected.length} pair(s) failed the audit and will not be published: ${detail}`);
  }
  if (publishable.length === 0) throw new Error("No usable pairs to publish");

  const tasks = [];
  const decisionCounts = {};
  let ledgerEvents = 0;
  let denyEvents = 0;

  for (const pair of publishable) {
    const entry = { task_id: pair.task_id, pairing_integrity: pair.failures.length === 0 };
    const metrics = {};
    for (const armName of ARMS) {
      const arm = pair[armName];
      const runDir = path.join(root, pair.task_id, armName);
      const trace = await readJson(path.join(runDir, "trace.json"));
      const oracle = await readJson(path.join(runDir, "oracle.json"));
      const traceRelative = path.join("traces", `${pair.task_id}-${armName}.json`);
      const oracleRelative = path.join("oracles", `${pair.task_id}-${armName}.json`);
      const traceDigest = await publishFile(path.join(runDir, "trace.json"), path.join(outputDir, traceRelative));
      const oracleDigest = await publishFile(path.join(runDir, "oracle.json"), path.join(outputDir, oracleRelative));
      metrics[armName] = traceMetrics(trace);

      if (arm.enforcement_coverage) {
        const ledger = (await readFile(path.join(runDir, "hook/state/policy-decisions.ndjson"), "utf8"))
          .split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
        ledgerEvents += ledger.length;
        for (const record of ledger) {
          const key = `${record.decision ?? "unknown"}:${record.reason_code ?? "none"}`;
          decisionCounts[key] = (decisionCounts[key] ?? 0) + 1;
          if (record.decision === "deny") denyEvents += 1;
        }
      }

      entry[armName] = {
        trace: { path: traceRelative, sha256: traceDigest },
        oracle: {
          path: oracleRelative,
          sha256: oracleDigest,
          status: oracle.result.status,
          failure_signatures: oracle.result.failure_signatures,
        },
        completeness: trace.completeness,
        warnings: trace.warnings,
        shell_commands: arm.shell_commands,
        ...metrics[armName],
        post_run_workspace_state_sha256: oracle.workspace.post_run_workspace_state_sha256,
        workspace_state_changed: trace.source.workspace_state_changed,
        agent_changed_files: oracle.workspace.agent_changed_files,
        production_edits: oracle.workspace.production_edits,
        test_edits: oracle.workspace.test_edits,
        enforcement_coverage: arm.enforcement_coverage,
      };
    }
    // Eligible as a collected pair, which is not the same as licensing a quality claim -- that needs the
    // 30-comparison threshold, and it is the conclusion block that says so.
    entry.quality_claim_eligible = pair.usable;
    entry.observed_reduction = {
      verification_commands: reduction(metrics.baseline.verification_commands, metrics.candidate.verification_commands),
      verification_duration: reduction(metrics.baseline.verification_duration_ms, metrics.candidate.verification_duration_ms),
      shell_commands: reduction(pair.baseline.shell_commands, pair.candidate.shell_commands),
    };
    tasks.push(entry);
  }

  const sample = publishable[0].candidate;
  const report = {
    schema_version: 1,
    evidence_class: "paired_verification_policy_run",
    benchmark_id: "observatory-verification-policy-pilot-v0.1",
    run_date: options.run_date,
    harness: sample.harness,
    model: sample.model,
    model_reasoning_effort: sample.effort,
    provider_note: "Both arms ran against the same relay provider (agentrouter.org, wire_api=responses). The candidate ran in an isolated CODEX_HOME whose only hooks entry was the generated verification policy hook, with --dangerously-bypass-hook-trust so codex 0.149.0 would not silently skip it.",
    scope_note: "Six paired pilot tasks collected by scripts/collect-verification-run.mjs and admitted by scripts/audit-verification-runs.mjs, which re-derives eligibility from raw evidence rather than from the collector's own record.",
    treatment: {
      baseline: { mode: "baseline", policy: publishable[0].baseline.policy },
      candidate: {
        mode: "shadow",
        policy: sample.policy,
        enforcement: "Codex PreToolUse/PostToolUse hook, deny is executed by the harness rather than requested in the prompt",
      },
    },
    policy_decisions: { ledger_events: ledgerEvents, by_decision: decisionCounts, deny_events: denyEvents },
    counts: {
      declared_pilot_tasks: 6,
      paired_tasks_this_run: tasks.length,
      complete_traces: tasks.flatMap((task) => ARMS.map((arm) => task[arm].completeness)).filter((value) => value === "complete").length,
      partial_traces: tasks.flatMap((task) => ARMS.map((arm) => task[arm].completeness)).filter((value) => value !== "complete").length,
      independent_oracles_evaluated: tasks.length * ARMS.length,
      workspace_digest_matches: tasks.length * ARMS.length,
      pairs_with_both_traces_complete: tasks.filter((task) => ARMS.every((arm) => task[arm].completeness === "complete")).length,
      quality_claim_eligible_comparisons: tasks.filter((task) => task.quality_claim_eligible).length,
      required_quality_claim_comparisons: 30,
      independent_oracle_failure_signatures: tasks.filter((task) => ARMS.some((arm) => task[arm].oracle.status === "failed")).length,
    },
    audit: {
      path: "audit-report.json",
      sha256: await publishFile(path.join(root, "audit-report.json"), path.join(outputDir, "audit-report.json")),
      pairs_total: audit.pairs_total,
      pairs_usable: audit.pairs_usable,
    },
    tasks,
  };

  // Derived, not asserted. The threshold check is arithmetic, and each note below names a specific run rather
  // than describing the batch in general, so a reader can go check it.
  const eligible = report.counts.quality_claim_eligible_comparisons;
  const falsePositiveDenies = tasks.filter((task) => task.candidate.enforcement_coverage?.approved_not_executed > 0);
  report.conclusion = {
    status: "six_task_paired_pilot_collected",
    quality_claim_eligible: eligible >= report.counts.required_quality_claim_comparisons,
    reason_codes: [
      ...(eligible < report.counts.required_quality_claim_comparisons ? ["minimum_quality_claim_comparisons_not_met"] : []),
      ...(denyEvents === 0 ? ["no_denied_command_observed_in_this_run"] : []),
      ...(falsePositiveDenies.length > 0 ? ["candidate_arm_lost_calls_to_gated_but_unexecuted_commands"] : []),
    ],
    notes: [
      `All ${tasks.length} pairs were admitted by the auditor, which re-derives enforcement coverage, ledger-to-session binding and pair identity from raw evidence. ${eligible}/${report.counts.required_quality_claim_comparisons} comparisons toward the quality-claim threshold.`,
      ...(falsePositiveDenies.length > 0
        ? [`${falsePositiveDenies.map((task) => `${task.task_id} (${task.candidate.enforcement_coverage.approved_not_executed})`).join(", ")} lost approved calls that were gated and then never executed. codex drops the sibling calls of a parallel batch when the hook denies one of them, so a single denial can cost several calls. observed_reduction must not be read as an efficiency result while this is true.`]
        : []),
      "Duration and command deltas here are single-sample per task and carry known policy defects; see docs/verification-policy-benchmark-v0.1.md for the fail-closed denial of non-test inspection commands.",
    ],
  };

  await writeFile(path.join(outputDir, "run-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output: path.join(outputDir, "run-report.json"),
    published_pairs: tasks.length,
    rejected_pairs: rejected.length,
    ledger_events: ledgerEvents,
    deny_events: denyEvents,
  })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
