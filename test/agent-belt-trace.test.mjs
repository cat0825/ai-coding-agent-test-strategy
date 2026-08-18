import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { convertAgentBeltLifecycleToTrace, parseNdjson } from "../src/agent-belt-trace.mjs";
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
    lifecycleRecord(0, "collector.started", 0, { collector_version: "1", collector_sha256: digest }),
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

function entries(records) {
  return records.map((record, index) => ({ line: index + 1, record }));
}

function resequence(records) {
  return records.map((record, sequence) => ({ ...record, sequence }));
}

function convert(lifecycle = lifecycleRecords(), stream = streamRecords()) {
  const lifecycleContents = lifecycle.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const streamContents = stream.map((record) => JSON.stringify(record)).join("\n") + "\n";
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
      scenarioDefinitionSha256: digest,
      collectorSha256: digest,
    },
    lifecycleSourceRef: "codex-run.ndjson",
    streamSourceRef: "l2_fix_formatter_bug/turn_0_stream.ndjson",
    lifecycleContents,
    streamContents,
    outcomeSha256: "b".repeat(64),
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
  assert.equal(trace.events.at(-1).data.reason, "observed_turn_completed");
  assert.equal(trace.source.scenario_definition_sha256, digest);
  assert.equal(validateTrace(trace).valid, true);
  assert.doesNotMatch(JSON.stringify(trace), /secret|private|aggregated_output|TOKEN/);
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

test("Codex wrapper forwards stdout and records lifecycle fields only", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, "codex");
  const realCodex = path.join(directory, "real-codex");
  const lifecycleDir = path.join(directory, "lifecycle");
  await mkdir(lifecycleDir);
  await copyFile(path.resolve("scripts/codex-lifecycle-wrapper.py"), wrapper);
  await chmod(wrapper, 0o700);
  await writeFile(realCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-wrapper"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"call-1","type":"command_execution","command":"pytest SECRET=hidden"}}'
sleep 0.02
printf '%s\\n' '{"type":"item.completed","item":{"id":"call-1","type":"command_execution","command":"pytest SECRET=hidden","aggregated_output":"do not retain","exit_code":0,"status":"completed"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`, { mode: 0o700 });
  await chmod(realCodex, 0o700);
  await writeFile(path.join(directory, "codex-lifecycle-config.json"), `${JSON.stringify({
    schema_version: 1,
    real_codex: realCodex,
    lifecycle_dir: lifecycleDir,
    collector_sha256: digest,
  })}\n`);

  const stdout = execFileSync(wrapper, ["exec", "--json"], { encoding: "utf8" });
  assert.match(stdout, /aggregated_output/);
  const files = await readdir(lifecycleDir);
  assert.equal(files.length, 1);
  const sidecar = await readFile(path.join(lifecycleDir, files[0]), "utf8");
  const records = parseNdjson(sidecar).map(({ record }) => record);
  assert.deepEqual(records.filter((record) => record.event.startsWith("item.")).map((record) => record.event), ["item.started", "item.completed"]);
  assert(records[4].monotonic_ns > records[3].monotonic_ns);
  assert.doesNotMatch(sidecar, /SECRET|hidden|aggregated_output|do not retain|real-codex/);
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
  await writeFile(path.join(run, "l2_fix_formatter_bug", "turn_0_output.json"), '{"schema_version":"1"}\n');
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
});
