import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stableJson } from "./benchmark-preflight.mjs";
import {
  matchRequiredFailureSignatures,
  verificationPostRunWorkspaceSha256,
  verificationWorkspaceChangedFiles,
  verificationWorkspaceFileSha256,
  verifyMaterializedVerificationTask,
} from "./verification-workspace.mjs";
import { validateVerificationBenchmark } from "./verification-benchmark.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function run(command, cwd, timeoutMs) {
  try {
    const result = await execFileAsync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, CI: "1", NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    return { exit_code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.killed) throw new Error(`Command timed out: ${command[0]}`);
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`Command exceeded output limit: ${command[0]}`);
    if (!Number.isInteger(error.code)) throw error;
    return { exit_code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function copyWorkspace(workspace) {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-policy-oracle-"));
  const copy = path.join(root, "workspace");
  await cp(workspace, copy, { recursive: true });
  return { root, workspace: copy };
}

async function executionOnCopy(workspace, command, timeoutMs) {
  const copy = await copyWorkspace(workspace);
  try {
    const result = await run(command, copy.workspace, timeoutMs);
    return result;
  } finally {
    await rm(copy.root, { recursive: true, force: true });
  }
}

function expectedResult(task, oracle, executionResults) {
  const statuses = executionResults.map(({ exit_code }) => exit_code);
  let pattern;
  if (task.behavior_class === "flaky_retry") pattern = statuses.length === 2 && statuses[0] !== 0 && statuses[1] === 0;
  else if (task.behavior_class === "affected_failure" || task.behavior_class === "full_fallback") pattern = statuses.at(-1) !== 0;
  else pattern = statuses.at(-1) === 0;
  return pattern && matchRequiredFailureSignatures(oracle.required_failure_signatures, executionResults);
}

function agentEditAssessment(task, changedFiles, initialFiles) {
  const edits = changedFiles.filter((file) => !initialFiles.has(file));
  const declaredChanged = new Set(task.definition.changed_files);
  for (const file of declaredChanged) if (changedFiles.includes(file)) edits.push(file);
  const unique = [...new Set(edits)].sort();
  const productionEdits = unique.filter((file) => !/(^|\/)(test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\./i.test(file));
  const testEdits = unique.filter((file) => !productionEdits.includes(file));
  const allowed = task.mode === "verify_only"
    ? unique.length === 0
    : productionEdits.length === 0 && testEdits.length > 0;
  return { changed_files: unique, production_edits: productionEdits, test_edits: testEdits, allowed };
}

export async function runVerificationPolicyOracle({ plan, oracles, taskManifest, sourceRepository, timeoutMs = 120_000, fixtureRepositories = null }) {
  const errors = validateVerificationBenchmark(plan, oracles);
  if (errors.length > 0) throw new Error(`Invalid Verification Policy benchmark: ${errors.map(({ path, message }) => `${path} ${message}`).join("; ")}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000");
  const { task, fixture, workspace, sourceBinding } = await verifyMaterializedVerificationTask({
    plan,
    taskManifest,
    sourceRepository,
    fixtureRepositories,
  });
  const oracle = oracles.oracles.find(({ task_id: taskId }) => taskId === task.task_id);
  if (!oracle) throw new Error(`Missing oracle for task ${task.task_id}`);

  const finalStateSha256 = await verificationPostRunWorkspaceSha256(workspace);
  const finalChangedFiles = await verificationWorkspaceChangedFiles(workspace);
  const finalFileSha256 = await verificationWorkspaceFileSha256(workspace, taskManifest.changed_files);
  const initialFiles = new Set(taskManifest.changed_files);
  const observedAgentFiles = new Set(finalChangedFiles.filter((file) => !initialFiles.has(file)));
  for (const file of taskManifest.changed_files) {
    if (finalFileSha256[file] !== taskManifest.changed_file_sha256[file]) observedAgentFiles.add(file);
  }
  const edits = agentEditAssessment(task, [...observedAgentFiles].sort(), initialFiles);
  const executionResults = [];
  const execute = async (phase) => {
    const result = await executionOnCopy(workspace, task.definition.command_tiers[phase], timeoutMs);
    executionResults.push({ phase, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr });
    return result;
  };
  // An oracle declared undecidable must not re-run the commands at all: the behaviour it would look for was
  // consumed before this copy existed, so any status it reported would describe the fixture rather than the
  // agent. It still records the workspace evidence, which is what the trace is checked against.
  if (oracle.post_run_decidable === false) {
    return {
      schema_version: 1,
      evidence_class: "independent_oracle",
      benchmark_id: plan.benchmark_id,
      task_id: task.task_id,
      oracle: {
        id: oracle.oracle_id,
        definition_sha256: digest(stableJson(oracle)),
      },
      environment: {
        benchmark_id: plan.benchmark_id,
        repository_identity: fixture.repository.identity,
        repository_revision: sourceBinding.source_base_revision,
        workspace_revision: sourceBinding.workspace_revision,
        scenario_definition_sha256: task.scenario_definition_sha256,
      },
      workspace: {
        initial_workspace_state_sha256: taskManifest.workspace_state_sha256,
        post_run_workspace_state_sha256: finalStateSha256,
        changed_files: finalChangedFiles,
        agent_changed_files: edits.changed_files,
        production_edits: edits.production_edits,
        test_edits: edits.test_edits,
        edit_policy_satisfied: edits.allowed,
      },
      execution: {
        results: [],
        timeout_ms: timeoutMs,
        skipped_reason: "post_run_undecidable",
      },
      result: {
        status: "undecided",
        undecidable_reason: oracle.undecidable_reason,
        deciding_evidence: oracle.deciding_evidence,
        workspace_status: oracle.expected_workspace_status,
        failure_signatures: [],
        expected_failure_signatures: oracle.required_failure_signatures,
      },
    };
  }
  if (task.behavior_class === "flaky_retry") {
    await execute("fast");
    await execute("fast");
  } else if (task.behavior_class === "full_fallback") {
    await execute("full");
  } else {
    await execute(oracle.minimum_evidence_phase);
  }
  const oraclePassed = edits.allowed && expectedResult(task, oracle, executionResults);
  return {
    schema_version: 1,
    evidence_class: "independent_oracle",
    benchmark_id: plan.benchmark_id,
    task_id: task.task_id,
    oracle: {
      id: oracle.oracle_id,
      definition_sha256: digest(stableJson(oracle)),
    },
    environment: {
      benchmark_id: plan.benchmark_id,
      repository_identity: fixture.repository.identity,
      repository_revision: sourceBinding.source_base_revision,
      workspace_revision: sourceBinding.workspace_revision,
      scenario_definition_sha256: task.scenario_definition_sha256,
    },
    workspace: {
      initial_workspace_state_sha256: taskManifest.workspace_state_sha256,
      post_run_workspace_state_sha256: finalStateSha256,
      changed_files: finalChangedFiles,
      agent_changed_files: edits.changed_files,
      production_edits: edits.production_edits,
      test_edits: edits.test_edits,
      edit_policy_satisfied: edits.allowed,
    },
    execution: {
      results: executionResults.map(({ phase, exit_code }) => ({ phase, exit_code })),
      timeout_ms: timeoutMs,
    },
    result: {
      status: oraclePassed ? "passed" : "failed",
      workspace_status: oracle.expected_workspace_status,
      failure_signatures: oracle.required_failure_signatures.filter((signature) => (
        matchRequiredFailureSignatures([signature], executionResults)
      )),
      expected_failure_signatures: oracle.required_failure_signatures,
    },
  };
}
