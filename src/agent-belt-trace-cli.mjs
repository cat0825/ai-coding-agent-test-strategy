#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertAgentBeltLifecycleToTrace, parseNdjson } from "./agent-belt-trace.mjs";
import { stableJson } from "./benchmark-preflight.mjs";
import { scenarioOutputRelativePath } from "./pilot-audit.mjs";

function usage() {
  return "Usage: node src/agent-belt-trace-cli.mjs --run <agent-belt-run> --lifecycle-dir <collector-output> --environment <manifest> --output-dir <trace-output>\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--run", "--lifecycle-dir", "--environment", "--output-dir"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function roundMilliseconds(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

async function readJson(filePath) {
  const contents = await readFile(filePath);
  return { value: JSON.parse(contents.toString("utf8")), contents, sha256: digest(contents) };
}

function threadId(entries) {
  return entries.find(({ record }) => record.event === "thread.started")?.record.thread_id ?? null;
}

function streamThreadId(entries) {
  return entries.find(({ record }) => record.type === "thread.started")?.record.thread_id ?? null;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["run", "lifecycle_dir", "environment", "output_dir"]) {
    if (!options[option]) throw new Error(`--${option.replaceAll("_", "-")} is required`);
  }

  const runPath = path.resolve(options.run);
  const lifecyclePath = path.resolve(options.lifecycle_dir);
  const outputPath = path.resolve(options.output_dir);
  const benchmarkCard = await readJson(path.join(runPath, "benchmark-card.json"));
  const results = await readJson(path.join(runPath, "results.json"));
  const environment = await readJson(path.resolve(options.environment));
  if (benchmarkCard.value.belt?.git_sha !== environment.value.repository?.observed_revision) {
    throw new Error("Agent-belt run revision does not match the qualified environment");
  }
  if (environment.value.conclusion?.status !== "eligible" || environment.value.repository?.clean !== true) {
    throw new Error("Benchmark environment must be eligible and clean");
  }
  if (environment.value.repository.expected_revision !== environment.value.repository.observed_revision) {
    throw new Error("Benchmark environment expected and observed revisions must match");
  }
  if (benchmarkCard.value.belt?.git_dirty !== null && benchmarkCard.value.belt?.git_dirty !== false) {
    throw new Error("Agent-belt run must use a clean pinned revision");
  }
  if (benchmarkCard.value.runtime?.trials !== 1) throw new Error("Timestamped baseline collection requires trials=1");
  if (benchmarkCard.value.runtime?.streaming !== true) throw new Error("Timestamped baseline collection requires agent-belt streaming");
  const agent = benchmarkCard.value.agents?.find((entry) => entry.agent?.name === "codex");
  if (!agent) throw new Error("Benchmark card must contain the Codex agent");
  const collectorSourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/codex-lifecycle-wrapper.py");
  const expectedCollectorSha256 = digest(await readFile(collectorSourcePath));

  const lifecycleByThread = new Map();
  for (const name of (await readdir(lifecyclePath)).filter((entry) => entry.endsWith(".ndjson")).sort()) {
    const contents = await readFile(path.join(lifecyclePath, name), "utf8");
    const entries = parseNdjson(contents, `lifecycle ${name}`);
    const id = threadId(entries);
    if (!id) throw new Error(`Lifecycle file ${name} is missing thread.started`);
    if (lifecycleByThread.has(id)) throw new Error(`Duplicate lifecycle thread ${id}`);
    lifecycleByThread.set(id, { name, contents, entries });
  }

  const definitionByName = new Map((benchmarkCard.value.scenarios?.scenario_files ?? []).map((definition) => [
    path.posix.basename(definition.relpath, ".json"),
    definition.sha256,
  ]));
  const traces = [];
  const usedLifecycleThreads = new Set();
  const scenarioNames = new Set();
  for (const scenario of results.value.scenarios ?? []) {
    const name = scenario.scenario_name;
    scenarioOutputRelativePath(name);
    if (scenarioNames.has(name)) throw new Error(`Duplicate scenario ${name}`);
    scenarioNames.add(name);
    const streamRef = `${name}/turn_0_stream.ndjson`;
    const streamContents = await readFile(path.join(runPath, streamRef), "utf8");
    const stream = parseNdjson(streamContents, `stream ${name}`);
    const id = streamThreadId(stream);
    const lifecycleSource = lifecycleByThread.get(id);
    if (!lifecycleSource) throw new Error(`No lifecycle evidence matches scenario ${name}`);
    if (usedLifecycleThreads.has(id)) throw new Error(`Lifecycle thread ${id} matches more than one scenario`);
    usedLifecycleThreads.add(id);
    const outcome = await readJson(path.join(runPath, scenarioOutputRelativePath(name)));
    const scenarioDefinitionSha256 = definitionByName.get(name);
    const trace = convertAgentBeltLifecycleToTrace({
      lifecycle: lifecycleSource.entries,
      stream,
      binding: {
        taskId: name,
        runId: benchmarkCard.value.run_id,
        harness: `agent-belt@${benchmarkCard.value.belt.version}+${benchmarkCard.value.belt.git_sha}`,
        model: agent.agent.args?.model ?? null,
        repository: environment.value.repository.identity,
        repositoryCommit: environment.value.repository.observed_revision,
        scenarioDefinitionSha256,
        collectorSha256: expectedCollectorSha256,
      },
      lifecycleSourceRef: lifecycleSource.name,
      streamSourceRef: streamRef,
      lifecycleContents: lifecycleSource.contents,
      streamContents,
      outcomeSha256: outcome.sha256,
      outcomeFilesModified: outcome.value.files_modified,
    });
    traces.push(trace);
  }
  if (usedLifecycleThreads.size !== lifecycleByThread.size) {
    throw new Error("Lifecycle directory contains evidence not matched to this agent-belt run");
  }

  await mkdir(outputPath, { recursive: true });
  for (const trace of traces) await writeFile(path.join(outputPath, `${trace.task_id}.json`), stableJson(trace), "utf8");
  const report = {
    schema_version: 1,
    evidence_class: "timestamped_agent_belt_trace_collection",
    run_id: benchmarkCard.value.run_id,
    harness_revision: benchmarkCard.value.belt.git_sha,
    environment_sha256: environment.sha256,
    counts: {
      traces: traces.length,
      complete_traces: traces.filter((trace) => trace.completeness === "complete").length,
      partial_traces: traces.filter((trace) => trace.completeness === "partial").length,
      test_results: traces.reduce((count, trace) => count + trace.events.filter((event) => event.event_type === "test_result").length, 0),
    },
    timing: {
      agent_total_ms: roundMilliseconds((results.value.cost_timing?.total_seconds ?? 0) * 1000),
      observed_test_duration_ms: roundMilliseconds(traces.reduce((total, trace) => total + trace.events
        .filter((event) => event.event_type === "test_result")
        .reduce((traceTotal, event) => traceTotal + event.data.duration_ms, 0), 0)),
    },
    traces: traces.map((trace) => ({
      task_id: trace.task_id,
      trace_id: trace.trace_id,
      completeness: trace.completeness,
      warnings: trace.warnings,
      test_results: trace.events.filter((event) => event.event_type === "test_result").length,
      observed_test_duration_ms: roundMilliseconds(trace.events
        .filter((event) => event.event_type === "test_result")
        .reduce((total, event) => total + event.data.duration_ms, 0)),
    })),
  };
  await writeFile(path.join(outputPath, "report.json"), stableJson(report), "utf8");
  process.stdout.write(`${JSON.stringify({ output_dir: outputPath, counts: report.counts })}\n`);
  if (report.counts.partial_traces > 0) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
