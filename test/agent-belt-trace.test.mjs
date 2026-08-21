import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { convertAgentBeltLifecycleToTrace, parseNdjson } from "../src/agent-belt-trace.mjs";
import { diagnoseTrace } from "../src/diagnostics.mjs";
import { validateTrace } from "../src/trace.mjs";

const revision = "9".repeat(40);
const digest = "a".repeat(64);

function lifecycleRecord(sequence, event, milliseconds, fields = {}) {
  return {
    schema_version: 1,
    sequence,
    event,
    observed_at: `2026-08-18T00:00:00.${String(milliseconds).padStart(3, "0")}Z`,
    monotonic_ns: milliseconds * 1_000_000,
    ...fields,
  };
}

function lifecycleRecords() {
  return [
    lifecycleRecord(0, "collector.started", 0, { collector_version: "2", collector_sha256: digest, cwd_sha256: "c".repeat(64) }),
    lifecycleRecord(1, "thread.started", 10, { thread_id: "thread-1" }),
    lifecycleRecord(2, "turn.started", 20),
    lifecycleRecord(3, "item.started", 100, { call_id: "item_1", item_type: "command_execution" }),
    lifecycleRecord(4, "item.completed", 600, { call_id: "item_1", item_type: "command_execution", exit_code: 0, status: "completed" }),
    lifecycleRecord(5, "turn.completed", 700),
    lifecycleRecord(6, "process.exited", 710, { exit_code: 0 }),
  ];
}

function streamRecords() {
  return [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'TOKEN=secret PYTHONPATH=/private/tmp/work pytest -q'", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'TOKEN=secret PYTHONPATH=/private/tmp/work pytest -q'", aggregated_output: "secret output /private/tmp/work", exit_code: 0, status: "completed" } },
    { type: "turn.completed", usage: { input_tokens: 10 } },
  ];
}

function repeatedLifecycleRecords({ includeFileChange = true } = {}) {
  const records = [
    lifecycleRecord(0, "collector.started", 0, { collector_version: "2", collector_sha256: digest, cwd_sha256: "c".repeat(64) }),
    lifecycleRecord(1, "thread.started", 10, { thread_id: "thread-1" }),
    lifecycleRecord(2, "turn.started", 20),
    lifecycleRecord(3, "item.started", 100, { call_id: "item_1", item_type: "command_execution" }),
    lifecycleRecord(4, "item.completed", 200, { call_id: "item_1", item_type: "command_execution", exit_code: 0, status: "completed" }),
  ];
  if (includeFileChange) {
    records.push(lifecycleRecord(5, "file_change.completed", 250, {
      call_id: "patch_1",
      status: "completed",
      changes: [{ path: "src/api.py", path_sha256: null, kind: "update" }],
    }));
  }
  records.push(
    lifecycleRecord(records.length, "item.started", 300, { call_id: "item_2", item_type: "command_execution" }),
    lifecycleRecord(records.length + 1, "item.completed", 400, { call_id: "item_2", item_type: "command_execution", exit_code: 0, status: "completed" }),
    lifecycleRecord(records.length + 2, "turn.completed", 500),
    lifecycleRecord(records.length + 3, "process.exited", 510, { exit_code: 0 }),
  );
  return records;
}

function repeatedStreamRecords() {
  const command = "pytest tests/test_api.py";
  return [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command, aggregated_output: "", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "patch_1", type: "file_change", changes: [{ path: "src/api.py", kind: "update" }], status: "completed" } },
    { type: "item.started", item: { id: "item_2", type: "command_execution", command, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_2", type: "command_execution", command, aggregated_output: "", exit_code: 0, status: "completed" } },
    { type: "turn.completed", usage: { input_tokens: 10 } },
  ];
}

function entries(records) {
  return records.map((record, index) => ({ line: index + 1, record }));
}

function resequence(records) {
  return records.map((record, sequence) => ({ ...record, sequence }));
}

function convert(lifecycle = lifecycleRecords(), stream = streamRecords(), outcomeFilesModified = null, bindingOverrides = {}) {
  const lifecycleContents = lifecycle.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const streamContents = stream.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const observedFiles = lifecycle
    .filter(({ event, status }) => event === "file_change.completed" && status === "completed")
    .flatMap(({ changes }) => changes.map(({ path: file }) => file));
  return convertAgentBeltLifecycleToTrace({
    lifecycle: entries(lifecycle),
    stream: entries(stream),
    binding: {
      taskId: "l2_fix_formatter_bug",
      runId: "run-1",
      harness: `agent-belt@0.2.1+${revision}`,
      model: null,
      repository: "jfrog/agent-belt",
      repositoryCommit: revision,
      mode: "baseline",
      policyName: "unmanaged-coding-agent-baseline",
      policyVersion: "1",
      scenarioDefinitionSha256: digest,
      collectorSha256: digest,
      ...bindingOverrides,
    },
    lifecycleSourceRef: "codex-run.ndjson",
    streamSourceRef: "l2_fix_formatter_bug/turn_0_stream.ndjson",
    lifecycleContents,
    streamContents,
    outcomeSha256: "b".repeat(64),
    outcomeFilesModified: outcomeFilesModified ?? observedFiles,
  });
}

test("converts paired lifecycle evidence into a sanitized complete VerifyTrace", () => {
  const trace = convert();
  const result = trace.events.find((event) => event.event_type === "test_result");
  assert.equal(trace.completeness, "complete");
  assert.deepEqual(trace.warnings, []);
  assert.deepEqual(result.data.command, ["pytest"]);
  assert.equal(result.data.duration_ms, 500);
  assert.equal(result.data.exit_code, 0);
  assert.equal(result.data.command_semantics.complete, true);
  assert.match(result.data.canonical_command_id, /^baseline:pytest:semantic:[a-f0-9]{64}$/);
  assert.equal(trace.events.at(-1).data.reason, "observed_turn_completed");
  assert.equal(trace.source.scenario_definition_sha256, digest);
  assert.equal(trace.mode, "baseline");
  assert.deepEqual(trace.policy, { name: "unmanaged-coding-agent-baseline", version: "1" });
  assert.equal(validateTrace(trace).valid, true);
  assert.doesNotMatch(JSON.stringify(trace), /secret|private|aggregated_output|TOKEN/);
});

test("direct Codex traces bind the materialized task state", () => {
  const trace = convert(lifecycleRecords(), streamRecords(), [], {
    initialChangedFiles: ["src/trace.mjs"],
    initialStateSha256: "d".repeat(64),
    finalStateSha256: "d".repeat(64),
    workspaceStateChanged: false,
    sourceFormat: "codex-cli-lifecycle-v2",
  });
  assert.deepEqual(trace.events[0].data.changed_files, ["src/trace.mjs"]);
  assert.deepEqual(trace.events[0].data.change_kinds, ["code"]);
  assert.equal(trace.events[0].data.observation, "materialized_task_state");
  assert.equal(trace.events[0].raw_event_ref.kind, "codex-cli-lifecycle");
  assert.equal(trace.source.initial_workspace_state_sha256, "d".repeat(64));
  assert.equal(trace.source.workspace_state_changed, false);
  assert.equal(trace.completeness, "complete");
});

test("candidate traces include sanitized verification policy decisions", () => {
  const trace = convert(lifecycleRecords(), streamRecords(), [], {
    initialChangedFiles: ["src/trace.mjs"],
    initialStateSha256: "d".repeat(64),
    finalStateSha256: "d".repeat(64),
    workspaceStateChanged: false,
    sourceFormat: "codex-cli-lifecycle-v2",
    policyLedgerSourceRef: "policy-decisions.ndjson",
    policyLedgerSha256: "e".repeat(64),
    policyDecisions: [{
      observed_at: "2026-08-18T00:00:00.650Z",
      event: "policy.pre_tool",
      source_line: 1,
      source_ref: "policy-decisions.ndjson",
      decision: "deny",
      reason_code: "repeat_after_pass_denied",
      tier: "fast",
      canonical_command_id: `baseline:pytest:semantic:${"f".repeat(64)}`,
      command_semantic_sha256: "f".repeat(64),
      budget: { test_executions: 1, immediate_duration_ms: 500, agent_turns: 1, failed_test_turns: 0 },
    }],
  });
  const decision = trace.events.find(({ event_type }) => event_type === "policy_decision");

  assert.equal(trace.completeness, "complete");
  assert.equal(decision.data.decision, "deny");
  assert.equal(decision.data.reason_code, "repeat_after_pass_denied");
  assert.equal(trace.source.policy_ledger_sha256, "e".repeat(64));
  assert.equal(validateTrace(trace).valid, true);
  assert.doesNotMatch(JSON.stringify(trace), /session-secret|private\/workspace|raw_command/);
});

test("post-run oracle matching binds a semantic failure signature without raw output", () => {
  const lifecycle = lifecycleRecords().map((record) => record.event === "item.completed"
    ? { ...record, exit_code: 1 }
    : record);
  const stream = streamRecords().map((record) => record.type === "item.completed" && record.item?.type === "command_execution"
    ? { ...record, item: { ...record.item, exit_code: 1 } }
    : record);
  const trace = convert(lifecycle, stream, [], {
    oracleDefinitionSha256: "f".repeat(64),
    failureSignaturesByCallId: { item_1: "evaluation:quality-claim-regression" },
  });
  const result = trace.events.find(({ event_type }) => event_type === "test_result");
  assert.equal(result.data.failure_signature, "evaluation:quality-claim-regression");
  assert.equal(trace.source.oracle_definition_sha256, "f".repeat(64));
  assert.doesNotMatch(JSON.stringify(trace), /aggregated_output/);
});

test("unobserved workspace changes make a direct trace partial", () => {
  const trace = convert(lifecycleRecords(), streamRecords(), [], {
    initialChangedFiles: ["src/trace.mjs"],
    initialStateSha256: "d".repeat(64),
    finalStateSha256: "e".repeat(64),
    workspaceStateChanged: true,
    sourceFormat: "codex-cli-lifecycle-v2",
  });
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("workspace_state_changed_without_observed_file_change"));
});

test("shell snapshot evidence makes an observed workspace change complete", () => {
  const lifecycle = lifecycleRecords();
  lifecycle.splice(5, 0, lifecycleRecord(5, "shell_file_change.completed", 650, {
    call_id: "item_1",
    status: "completed",
    complete: true,
    changes: [{ path: "test/new.test.mjs", kind: "add" }],
  }));
  const trace = convert(resequence(lifecycle), streamRecords(), ["test/new.test.mjs"], {
    initialChangedFiles: ["src/trace.mjs"],
    initialStateSha256: "d".repeat(64),
    finalStateSha256: "e".repeat(64),
    workspaceStateChanged: true,
    sourceFormat: "codex-cli-lifecycle-v2",
  });
  const diff = trace.events.find(({ data }) => data.observation === "completed_shell_file_change");

  assert.equal(trace.completeness, "complete");
  assert.deepEqual(diff.data.changed_files, ["test/new.test.mjs"]);
  assert.equal(trace.warnings.includes("workspace_state_changed_without_observed_file_change"), false);
  assert.equal(validateTrace(trace).valid, true);
});

test("incomplete shell snapshot evidence still fails closed", () => {
  const lifecycle = lifecycleRecords();
  lifecycle.splice(5, 0, lifecycleRecord(5, "shell_file_change.completed", 650, {
    call_id: "item_1",
    status: "completed",
    complete: false,
    changes: [{ path: "test/new.test.mjs", kind: "add" }],
  }));
  const trace = convert(resequence(lifecycle), streamRecords(), ["test/new.test.mjs"], {
    initialChangedFiles: ["src/trace.mjs"],
    initialStateSha256: "d".repeat(64),
    finalStateSha256: "e".repeat(64),
    workspaceStateChanged: true,
    sourceFormat: "codex-cli-lifecycle-v2",
  });

  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("incomplete_shell_file_change_snapshot:item_1"));
  assert(trace.warnings.includes("workspace_state_changed_without_observed_file_change"));
});

test("missing command start produces a partial trace without a fabricated duration", () => {
  const records = resequence(lifecycleRecords().filter((record) => record.event !== "item.started"));
  const trace = convert(records);
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("missing_command_start:item_1"));
  assert.equal(trace.events.some((event) => event.event_type === "test_result"), false);
  assert.equal(validateTrace(trace, { allowPartial: true }).valid, true);
});

test("missing command completion produces a partial trace", () => {
  const records = resequence(lifecycleRecords().filter((record) => record.event !== "item.completed"));
  const trace = convert(records);
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("missing_command_completion:item_1"));
  assert.equal(trace.events.some((event) => event.event_type === "test_result"), false);
});

test("missing terminal evidence never creates a stop event", () => {
  const records = resequence(lifecycleRecords().filter((record) => record.event !== "turn.completed"));
  const trace = convert(records);
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("missing_terminal_event"));
  assert.notEqual(trace.events.at(-1).event_type, "stop");
  assert.equal(validateTrace(trace, { allowPartial: true }).valid, true);
});

test("duplicate call IDs are quality-claim-ineligible", () => {
  const records = lifecycleRecords();
  records.splice(4, 0, lifecycleRecord(4, "item.started", 200, { call_id: "item_1", item_type: "command_execution" }));
  const trace = convert(resequence(records));
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("duplicate_command_start:item_1"));
});

test("reordered lifecycle events fail closed", () => {
  const records = lifecycleRecords();
  [records[3], records[4]] = [records[4], records[3]];
  const trace = convert(resequence(records));
  assert.equal(trace.completeness, "partial");
  assert(trace.warnings.includes("lifecycle_monotonic_reordered"));
  assert(trace.warnings.includes("command_events_reordered:item_1"));
});

test("ordered file-change evidence turns a repeat into necessary revalidation", () => {
  const trace = convert(repeatedLifecycleRecords(), repeatedStreamRecords());
  const diff = trace.events.find((event, index) => index > 0 && event.event_type === "diff");
  const diagnostics = diagnoseTrace(trace);

  assert.equal(trace.completeness, "complete");
  assert.deepEqual(diff.data.changed_files, ["src/api.py"]);
  assert.deepEqual(diff.data.change_kinds, ["code"]);
  assert.match(diff.data.state_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(diagnostics.findings.map(({ label }) => label), ["necessary_revalidation"]);
});

test("a stream file change without lifecycle evidence fails closed", () => {
  const trace = convert(repeatedLifecycleRecords({ includeFileChange: false }), repeatedStreamRecords());

  assert.equal(trace.completeness, "partial");
  assert.equal(trace.source.state_evidence_complete, false);
  assert(trace.warnings.includes("missing_file_change_lifecycle:patch_1"));
  assert.deepEqual(diagnoseTrace(trace).findings, []);
});

test("the final outcome manifest detects unobserved source changes but ignores runtime caches", () => {
  const complete = convert(
    repeatedLifecycleRecords(),
    repeatedStreamRecords(),
    ["src/api.py", "src/__pycache__/api.cpython-312.pyc"],
  );
  const mismatched = convert(repeatedLifecycleRecords(), repeatedStreamRecords(), ["src/other.py"]);

  assert.equal(complete.completeness, "complete");
  assert.equal(complete.source.ignored_generated_files, 1);
  assert.equal(mismatched.completeness, "partial");
  assert.equal(mismatched.source.state_evidence_complete, false);
  assert(mismatched.warnings.some((warning) => warning.startsWith("outcome_file_not_observed:")));
});

test("an intervening non-test command makes state unknown instead of claiming a repeat", () => {
  const lifecycle = repeatedLifecycleRecords({ includeFileChange: false });
  lifecycle.splice(
    5,
    0,
    lifecycleRecord(5, "item.started", 240, { call_id: "edit_1", item_type: "command_execution" }),
    lifecycleRecord(6, "item.completed", 260, { call_id: "edit_1", item_type: "command_execution", exit_code: 0, status: "completed" }),
  );
  const stream = repeatedStreamRecords().filter(({ item }) => item?.type !== "file_change");
  stream.splice(
    4,
    0,
    { type: "item.started", item: { id: "edit_1", type: "command_execution", command: "python tools/rewrite.py", status: "in_progress" } },
    { type: "item.completed", item: { id: "edit_1", type: "command_execution", command: "python tools/rewrite.py", aggregated_output: "", exit_code: 0, status: "completed" } },
  );
  const trace = convert(resequence(lifecycle), stream);
  const unknown = trace.events.find(({ data }) => data.observation === "unknown_after_non_test_command");

  assert.equal(trace.completeness, "complete");
  assert.equal(unknown.data.state_id, null);
  assert.deepEqual(diagnoseTrace(trace).findings, []);
});

test("Codex wrapper forwards stdout and records sanitized lifecycle fields", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, "codex");
  const realCodex = path.join(directory, "real-codex");
  const lifecycleDir = path.join(directory, "lifecycle");
  await mkdir(lifecycleDir);
  await copyFile(path.resolve("scripts/codex-lifecycle-wrapper.py"), wrapper);
  await chmod(wrapper, 0o700);
  const changedFile = path.join(directory, "src", "main.py");
  await writeFile(realCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-wrapper"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"call-1","type":"command_execution","command":"pytest SECRET=hidden"}}'
sleep 0.02
printf '%s\\n' '{"type":"item.completed","item":{"id":"call-1","type":"command_execution","command":"pytest SECRET=hidden","aggregated_output":"do not retain","exit_code":0,"status":"completed"}}'
printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { id: "patch-1", type: "file_change", changes: [{ path: changedFile, kind: "update" }], status: "completed" } })}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`, { mode: 0o700 });
  await chmod(realCodex, 0o700);
  await writeFile(path.join(directory, "codex-lifecycle-config.json"), `${JSON.stringify({
    schema_version: 1,
    real_codex: realCodex,
    lifecycle_dir: lifecycleDir,
    collector_sha256: digest,
  })}\n`);

  const stdout = execFileSync(wrapper, ["exec", "--json"], { cwd: directory, encoding: "utf8" });
  assert.match(stdout, /aggregated_output/);
  const files = await readdir(lifecycleDir);
  assert.equal(files.length, 1);
  const sidecar = await readFile(path.join(lifecycleDir, files[0]), "utf8");
  const records = parseNdjson(sidecar).map(({ record }) => record);
  assert.deepEqual(records.filter((record) => record.event.startsWith("item.")).map((record) => record.event), ["item.started", "item.completed"]);
  assert.equal(records[0].collector_version, "2");
  assert.match(records[0].cwd_sha256, /^[a-f0-9]{64}$/);
  assert(records[4].monotonic_ns > records[3].monotonic_ns);
  const fileChange = records.find((record) => record.event === "file_change.completed");
  assert.deepEqual(fileChange.changes, [{ path: "src/main.py", path_sha256: null, kind: "update" }]);
  assert.equal(sidecar.includes(directory), false);
  assert.doesNotMatch(sidecar, /SECRET|hidden|aggregated_output|do not retain|real-codex/);
});

test("Codex wrapper attributes shell-created files without retaining contents", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-shell-observer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, "codex");
  const realCodex = path.join(directory, "real-codex");
  const lifecycleDir = path.join(directory, "lifecycle");
  await mkdir(lifecycleDir);
  await copyFile(path.resolve("scripts/codex-lifecycle-wrapper.py"), wrapper);
  await chmod(wrapper, 0o700);
  await writeFile(realCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-shell"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"shell-1","type":"command_execution","command":"printf secret > test/new.test.mjs"}}'
mkdir -p test
printf 'secret test contents\\n' > test/new.test.mjs
printf '%s\\n' '{"type":"item.completed","item":{"id":"shell-1","type":"command_execution","command":"printf secret > test/new.test.mjs","aggregated_output":"secret output","exit_code":0,"status":"completed"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`, { mode: 0o700 });
  await chmod(realCodex, 0o700);
  await writeFile(path.join(directory, "codex-lifecycle-config.json"), `${JSON.stringify({
    schema_version: 1,
    real_codex: realCodex,
    lifecycle_dir: lifecycleDir,
    collector_sha256: digest,
  })}\n`);

  execFileSync(wrapper, ["exec", "--json"], { cwd: directory, encoding: "utf8" });
  const files = await readdir(lifecycleDir);
  const sidecar = await readFile(path.join(lifecycleDir, files[0]), "utf8");
  const records = parseNdjson(sidecar).map(({ record }) => record);
  const shellChange = records.find((record) => record.event === "shell_file_change.completed");

  assert.deepEqual(shellChange.changes, [{ path: "test/new.test.mjs", kind: "add" }]);
  assert.equal(shellChange.complete, true);
  assert.doesNotMatch(sidecar, /secret|test contents|aggregated_output|real-codex/);
});

test("Codex wrapper snapshots the explicit -C workspace", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-explicit-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  const wrapper = path.join(directory, "codex");
  const realCodex = path.join(directory, "real-codex");
  const lifecycleDir = path.join(directory, "lifecycle");
  await mkdir(path.join(workspace, "test"), { recursive: true });
  await mkdir(lifecycleDir);
  await copyFile(path.resolve("scripts/codex-lifecycle-wrapper.py"), wrapper);
  await chmod(wrapper, 0o700);
  await writeFile(realCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-explicit-workspace"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"shell-c","type":"command_execution","command":"printf secret > test/new.test.mjs"}}'
mkdir -p "${workspace}/test"
printf 'secret test contents\\n' > "${workspace}/test/new.test.mjs"
printf '%s\\n' '{"type":"item.completed","item":{"id":"shell-c","type":"command_execution","command":"printf secret > test/new.test.mjs","exit_code":0,"status":"completed"}}'
printf '%s\\n' '{"type":"turn.completed"}'
`, { mode: 0o700 });
  await chmod(realCodex, 0o700);
  await writeFile(path.join(directory, "codex-lifecycle-config.json"), `${JSON.stringify({
    schema_version: 1,
    real_codex: realCodex,
    lifecycle_dir: lifecycleDir,
    collector_sha256: digest,
  })}\n`);

  execFileSync(wrapper, ["exec", "-C", workspace, "--json"], { cwd: directory, encoding: "utf8" });
  const files = await readdir(lifecycleDir);
  const records = parseNdjson(await readFile(path.join(lifecycleDir, files[0]), "utf8")).map(({ record }) => record);
  const shellChange = records.find((record) => record.event === "shell_file_change.completed");

  assert.deepEqual(shellChange.changes, [{ path: "test/new.test.mjs", kind: "add" }]);
  assert.equal(shellChange.complete, true);
  assert.match(records[0].cwd_sha256, /^[a-f0-9]{64}$/);
});

test("batch CLI maps lifecycle evidence to a scenario by thread id", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-belt-trace-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = path.join(directory, "run");
  const lifecycleDir = path.join(directory, "lifecycle");
  const outputDir = path.join(directory, "traces");
  await mkdir(path.join(run, "l2_fix_formatter_bug"), { recursive: true });
  await mkdir(lifecycleDir);
  const benchmarkCard = {
    run_id: "run-1",
    belt: { version: "0.2.1", git_sha: revision, git_dirty: null },
    runtime: { trials: 1, streaming: true },
    scenarios: { scenario_files: [{ relpath: "l2_fix_formatter_bug.json", sha256: digest }] },
    agents: [{ agent: { name: "codex", args: {} } }],
  };
  const results = { scenarios: [{ scenario_name: "l2_fix_formatter_bug" }] };
  const environment = {
    repository: { identity: "jfrog/agent-belt", expected_revision: revision, observed_revision: revision, clean: true },
    conclusion: { status: "eligible" },
  };
  await writeFile(path.join(run, "benchmark-card.json"), `${JSON.stringify(benchmarkCard)}\n`);
  await writeFile(path.join(run, "results.json"), `${JSON.stringify(results)}\n`);
  await writeFile(path.join(run, "l2_fix_formatter_bug", "turn_0_stream.ndjson"), streamRecords().map(JSON.stringify).join("\n") + "\n");
  await writeFile(path.join(run, "l2_fix_formatter_bug", "turn_0_output.json"), '{"schema_version":"1","files_modified":[]}\n');
  const collectorSha256 = createHash("sha256").update(await readFile("scripts/codex-lifecycle-wrapper.py")).digest("hex");
  const cliLifecycle = lifecycleRecords().map((record) => record.event === "collector.started"
    ? { ...record, collector_sha256: collectorSha256 }
    : record);
  await writeFile(path.join(lifecycleDir, "collector.ndjson"), cliLifecycle.map(JSON.stringify).join("\n") + "\n");
  const environmentPath = path.join(directory, "environment.json");
  await writeFile(environmentPath, `${JSON.stringify(environment)}\n`);
  execFileSync(process.execPath, [
    "src/agent-belt-trace-cli.mjs",
    "--run", run,
    "--lifecycle-dir", lifecycleDir,
    "--environment", environmentPath,
    "--output-dir", outputDir,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
  assert.deepEqual(report.counts, { complete_traces: 1, partial_traces: 0, test_results: 1, traces: 1 });
});

test("checked-in timestamped traces validate as complete VerifyTrace v1", async () => {
  for (const task of ["l1_find_bug", "l2_add_completed_at", "l2_fix_formatter_bug", "l3_add_delete_command", "l3_add_json_format"]) {
    const trace = JSON.parse(await readFile(`fixtures/benchmark/traces/${task}.json`, "utf8"));
    const validation = validateTrace(trace);
    assert.equal(validation.valid, true, `${task}: ${JSON.stringify(validation.errors)}`);
    assert.equal(trace.completeness, "complete");
  }
  const verificationSmoke = JSON.parse(await readFile("fixtures/benchmark/verification-policy-smoke-traces/vp_local_correct_stop.json", "utf8"));
  assert.equal(validateTrace(verificationSmoke).valid, true);
  assert.equal(verificationSmoke.completeness, "complete");
  assert.equal(verificationSmoke.source.format, "codex-cli-lifecycle-v2");
});

test("observed sleep commands become wait events instead of unknown state", () => {
  const lifecycle = lifecycleRecords();
  lifecycle.splice(5, 0,
    lifecycleRecord(5, "item.started", 610, { call_id: "wait_1", item_type: "command_execution" }),
    lifecycleRecord(6, "item.completed", 710, { call_id: "wait_1", item_type: "command_execution", exit_code: 0, status: "completed" }),
  );
  lifecycle.find(({ event }) => event === "turn.completed").monotonic_ns = 800 * 1_000_000;
  lifecycle.find(({ event }) => event === "process.exited").monotonic_ns = 810 * 1_000_000;
  lifecycle.find(({ event }) => event === "turn.completed").observed_at = "2026-08-18T00:00:00.800Z";
  lifecycle.find(({ event }) => event === "process.exited").observed_at = "2026-08-18T00:00:00.810Z";
  const stream = streamRecords();
  stream.splice(4, 0,
    { type: "item.started", item: { id: "wait_1", type: "command_execution", command: "sleep 1", status: "in_progress" } },
    { type: "item.completed", item: { id: "wait_1", type: "command_execution", command: "sleep 1", aggregated_output: "", exit_code: 0, status: "completed" } },
  );
  const trace = convert(resequence(lifecycle), stream);
  const wait = trace.events.find(({ event_type: type }) => type === "wait");
  assert.ok(wait, JSON.stringify({ warnings: trace.warnings, events: trace.events }));
  assert.deepEqual(wait.data, { subject: "local_process", duration_ms: 100, observed: true, subject_ref_sha256: null });
  assert.equal(trace.events.some((event) => event.event_type === "diff" && event.data.observation === "unknown_after_non_test_command"), false);
});
