#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { convertAgentBeltLifecycleToTrace, parseNdjson } from "./agent-belt-trace.mjs";
import { stableJson } from "./benchmark-preflight.mjs";
import { verificationTaskDefinitionDigest } from "./verification-benchmark.mjs";
import {
  verificationWorkspaceChangedFiles,
  verificationWorkspaceFileSha256,
  verificationWorkspaceStateSha256,
} from "./verification-workspace.mjs";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_REVISION = /^[a-f0-9]{40}$/i;

function usage() {
  return "Usage: node src/verification-trace-cli.mjs --plan PLAN --task-manifest TASK_JSON --stream STREAM_NDJSON --lifecycle LIFECYCLE_NDJSON --collector COLLECTOR_JSON --run-id ID --harness NAME --model MODEL --output TRACE_JSON\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--plan", "--task-manifest", "--stream", "--lifecycle", "--collector", "--run-id", "--harness", "--model", "--output"].includes(argument)) {
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function git(arguments_, cwd) {
  const { stdout } = await execFileAsync("git", arguments_, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function safeChangedFiles(records) {
  const files = new Set();
  for (const { record } of records) {
    if (record.event !== "file_change.completed" || record.status !== "completed") continue;
    for (const change of record.changes ?? []) {
      if (typeof change.path === "string" && change.path.length > 0) files.add(change.path);
    }
  }
  return [...files].sort();
}

function elapsedMilliseconds(records) {
  const start = records.find(({ record }) => record.event === "turn.started")?.record.monotonic_ns;
  const end = records.find(({ record }) => ["turn.completed", "turn.failed"].includes(record.event))?.record.monotonic_ns;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return Math.round(((end - start) / 1_000_000 + Number.EPSILON) * 1000) / 1000;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["plan", "task_manifest", "stream", "lifecycle", "collector", "run_id", "harness", "model", "output"]) {
    if (!options[option]) throw new Error(`--${option.replaceAll("_", "-")} is required`);
  }

  const plan = await readJson(path.resolve(options.plan));
  const manifest = await readJson(path.resolve(options.task_manifest));
  const collector = await readJson(path.resolve(options.collector));
  const task = plan.tasks?.find(({ task_id: taskId }) => taskId === manifest.task_id);
  if (!task) throw new Error(`Task manifest references unknown task: ${manifest.task_id}`);
  if (verificationTaskDefinitionDigest(task.definition) !== task.scenario_definition_sha256
    || manifest.scenario_definition_sha256 !== task.scenario_definition_sha256) {
    throw new Error("Task definition digest does not match the public plan");
  }
  if (!GIT_REVISION.test(manifest.workspace_revision ?? "")) throw new Error("Task manifest requires workspace_revision");
  if (!SHA256.test(manifest.workspace_state_sha256 ?? "")) throw new Error("Task manifest requires workspace_state_sha256");
  if (!SHA256.test(collector.collector_sha256 ?? "")) throw new Error("Collector manifest requires collector_sha256");
  if (JSON.stringify([...(manifest.changed_files ?? [])].sort()) !== JSON.stringify([...task.definition.changed_files].sort())) {
    throw new Error("Task manifest changed_files do not match the public plan");
  }
  if (manifest.changed_file_sha256 === null || typeof manifest.changed_file_sha256 !== "object"
    || Array.isArray(manifest.changed_file_sha256)
    || JSON.stringify(Object.keys(manifest.changed_file_sha256).sort()) !== JSON.stringify([...manifest.changed_files].sort())
    || Object.values(manifest.changed_file_sha256).some((value) => value !== null && !SHA256.test(value))) {
    throw new Error("Task manifest changed_file_sha256 must bind every declared changed file");
  }

  const workspace = path.resolve(manifest.workspace);
  const observedRevision = (await git(["rev-parse", "HEAD"], workspace)).trim();
  if (observedRevision !== manifest.workspace_revision) throw new Error("Workspace revision does not match the task manifest");
  const finalStateSha256 = await verificationWorkspaceStateSha256(workspace);
  const workspaceStateChanged = finalStateSha256 !== manifest.workspace_state_sha256;
  const finalChangedFiles = await verificationWorkspaceChangedFiles(workspace);
  const finalInitialFileSha256 = await verificationWorkspaceFileSha256(workspace, manifest.changed_files);
  const initialChangedFiles = new Set(manifest.changed_files);
  const agentChangedFiles = new Set(finalChangedFiles.filter((file) => !initialChangedFiles.has(file)));
  for (const file of manifest.changed_files) {
    if (finalInitialFileSha256[file] !== manifest.changed_file_sha256[file]) agentChangedFiles.add(file);
  }

  const lifecyclePath = path.resolve(options.lifecycle);
  const streamPath = path.resolve(options.stream);
  const lifecycleContents = await readFile(lifecyclePath, "utf8");
  const streamContents = await readFile(streamPath, "utf8");
  const lifecycle = parseNdjson(lifecycleContents, "Codex lifecycle");
  const stream = parseNdjson(streamContents, "Codex stream");
  const observedAgentFileChanges = safeChangedFiles(lifecycle);
  const outcomeFilesModified = [...agentChangedFiles].sort();
  const outcome = stableJson({
    initial_workspace_state_sha256: manifest.workspace_state_sha256,
    final_workspace_state_sha256: finalStateSha256,
    workspace_state_changed: workspaceStateChanged,
    final_agent_changed_files: outcomeFilesModified,
    observed_agent_file_changes: observedAgentFileChanges,
  });
  const fixture = plan.fixtures?.find(({ fixture_id: fixtureId }) => fixtureId === task.fixture_id);
  if (!fixture) throw new Error(`Task references unknown fixture: ${task.fixture_id}`);

  const trace = convertAgentBeltLifecycleToTrace({
    lifecycle,
    stream,
    binding: {
      taskId: task.task_id,
      runId: options.run_id,
      harness: options.harness,
      model: options.model,
      repository: fixture.repository.identity,
      repositoryCommit: manifest.workspace_revision,
      scenarioDefinitionSha256: task.scenario_definition_sha256,
      collectorSha256: collector.collector_sha256,
      initialChangedFiles: manifest.changed_files,
      initialStateSha256: manifest.workspace_state_sha256,
      finalStateSha256,
      workspaceStateChanged,
      sourceFormat: "codex-cli-lifecycle-v2",
    },
    lifecycleSourceRef: path.basename(lifecyclePath),
    streamSourceRef: path.basename(streamPath),
    lifecycleContents,
    streamContents,
    outcomeSha256: sha256(outcome),
    outcomeFilesModified,
  });
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stableJson(trace), "utf8");
  const shellCommands = lifecycle.filter(({ record }) => record.event === "item.started" && record.item_type === "command_execution").length;
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    task_id: trace.task_id,
    completeness: trace.completeness,
    shell_commands: shellCommands,
    test_results: trace.events.filter(({ event_type: eventType }) => eventType === "test_result").length,
    agent_elapsed_ms: elapsedMilliseconds(lifecycle),
    workspace_state_changed: workspaceStateChanged,
    warnings: trace.warnings,
  })}\n`);
  if (trace.completeness !== "complete") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
