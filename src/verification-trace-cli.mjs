#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { convertAgentBeltLifecycleToTrace, parseNdjson } from "./agent-belt-trace.mjs";
import { stableJson } from "./benchmark-preflight.mjs";
import { verifyCollectorProvenance } from "./collector-provenance.mjs";
import { validateVerificationBenchmark } from "./verification-benchmark.mjs";
import {
  matchRequiredFailureSignatures,
  verificationPostRunWorkspaceSha256,
  verificationWorkspaceChangedFiles,
  verificationWorkspaceFileSha256,
  verifyMaterializedVerificationTask,
} from "./verification-workspace.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;

function usage() {
  return "Usage: node src/verification-trace-cli.mjs --plan PLAN --oracles ORACLES --repo REPOSITORY --task-manifest TASK_JSON --stream STREAM_NDJSON --lifecycle LIFECYCLE_NDJSON --collector COLLECTOR_JSON --run-id ID --harness NAME --model MODEL --mode baseline|shadow --policy-name NAME --policy-version VERSION --output TRACE_JSON\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--plan", "--oracles", "--repo", "--task-manifest", "--stream", "--lifecycle", "--collector", "--run-id", "--harness", "--model", "--mode", "--policy-name", "--policy-version", "--output"].includes(argument)) {
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
  for (const option of ["plan", "oracles", "repo", "task_manifest", "stream", "lifecycle", "collector", "run_id", "harness", "model", "mode", "policy_name", "policy_version", "output"]) {
    if (!options[option]) throw new Error(`--${option.replaceAll("_", "-")} is required`);
  }
  if (!["baseline", "shadow"].includes(options.mode)) throw new Error("--mode must be baseline or shadow");

  const plan = await readJson(path.resolve(options.plan));
  const oracles = await readJson(path.resolve(options.oracles));
  const designErrors = validateVerificationBenchmark(plan, oracles);
  if (designErrors.length > 0) throw new Error(`Invalid Verification Policy benchmark: ${designErrors.map(({ path: field, message }) => `${field} ${message}`).join("; ")}`);
  const manifest = await readJson(path.resolve(options.task_manifest));
  const collectorPath = path.resolve(options.collector);
  const collector = await readJson(collectorPath);
  if (!SHA256.test(collector.collector_sha256 ?? "")) throw new Error("Collector manifest requires collector_sha256");
  const collectorBinding = await verifyCollectorProvenance({
    collector,
    collectorManifestPath: collectorPath,
    controlledCollectorPath: new URL("../scripts/codex-lifecycle-wrapper.py", import.meta.url),
  });
  const { task, fixture, workspace, sourceBinding } = await verifyMaterializedVerificationTask({
    plan,
    taskManifest: manifest,
    sourceRepository: await realpath(options.repo),
  });
  const finalStateSha256 = await verificationPostRunWorkspaceSha256(workspace);
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
  const oracle = oracles.oracles.find(({ task_id: taskId }) => taskId === task.task_id);
  if (!oracle) throw new Error(`Missing oracle for task ${task.task_id}`);
  const failureSignaturesByCallId = {};
  for (const { record } of stream) {
    if (record.type !== "item.completed" || record.item?.type !== "command_execution" || record.item.exit_code === 0) continue;
    const matched = oracle.required_failure_signatures.filter((signature) => matchRequiredFailureSignatures([signature], [{
      exit_code: record.item.exit_code,
      stdout: typeof record.item.aggregated_output === "string" ? record.item.aggregated_output : "",
      stderr: "",
    }]));
    if (matched.length > 1) throw new Error(`Command ${record.item.id} matches multiple oracle failure signatures`);
    if (matched.length === 1) failureSignaturesByCallId[record.item.id] = matched[0];
  }
  const observedAgentFileChanges = safeChangedFiles(lifecycle);
  const outcomeFilesModified = [...agentChangedFiles].sort();
  const outcome = stableJson({
    initial_workspace_state_sha256: manifest.workspace_state_sha256,
    final_workspace_state_sha256: finalStateSha256,
    workspace_state_changed: workspaceStateChanged,
    final_agent_changed_files: outcomeFilesModified,
    observed_agent_file_changes: observedAgentFileChanges,
  });
  const trace = convertAgentBeltLifecycleToTrace({
    lifecycle,
    stream,
    binding: {
      taskId: task.task_id,
      runId: options.run_id,
      harness: options.harness,
      model: options.model,
      repository: fixture.repository.identity,
      repositoryCommit: sourceBinding.source_base_revision,
      mode: options.mode,
      policyName: options.policy_name,
      policyVersion: options.policy_version,
      workspaceRevision: sourceBinding.workspace_revision,
      sourceTree: sourceBinding.source_tree,
      scenarioDefinitionSha256: task.scenario_definition_sha256,
      oracleDefinitionSha256: sha256(stableJson(oracle)),
      failureSignaturesByCallId,
      collectorSha256: collectorBinding.collector_sha256,
      initialChangedFiles: manifest.changed_files,
      initialStateSha256: manifest.workspace_state_sha256,
      finalStateSha256,
      postRunWorkspaceSha256: finalStateSha256,
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
