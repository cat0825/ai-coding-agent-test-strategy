import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateVerificationBenchmark, VerificationBenchmarkValidationError } from "./verification-benchmark.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function taskById(plan, taskId) {
  const task = plan.tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) throw new Error(`Unknown verification benchmark task: ${taskId}`);
  return task;
}

function oracleByTaskId(oracles, taskId) {
  return oracles.oracles.find((candidate) => candidate.task_id === taskId);
}

async function run(command, cwd, timeoutMs = 30_000, extraEnvironment = {}) {
  const environment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    ...extraEnvironment,
  };
  delete environment.NODE_TEST_CONTEXT;
  try {
    const result = await execFileAsync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      env: environment,
    });
    return { exit_code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.killed) throw new Error(`Command timed out: ${command[0]}`);
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`Command exceeded output limit: ${command[0]}`);
    if (!Number.isInteger(error.code)) throw error;
    return { exit_code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function git(arguments_, cwd, timeoutMs = 30_000, extraEnvironment = {}) {
  const result = await run(["git", ...arguments_], cwd, timeoutMs, extraEnvironment);
  if (result.exit_code !== 0) throw new Error(`Git command failed: git ${arguments_.join(" ")}`);
  return result.stdout.trim();
}

async function repositoryDiff(sourceRepository, source, paths) {
  if (source.kind !== "repository_change") return null;
  const result = await run(["git", "diff", "--binary", source.base_revision, source.change_revision, "--", ...paths], sourceRepository);
  if (result.exit_code !== 0 || result.stdout.length === 0) throw new Error(`Repository change has no usable patch: ${source.change_revision}`);
  return result.stdout;
}

async function applyPatch(workspace, patchContents, containerRoot, label) {
  const patchPath = path.join(containerRoot, `${label}.patch`);
  await writeFile(patchPath, patchContents);
  await git(["apply", "--whitespace=nowarn", patchPath], workspace);
}

async function replaceExact(file, before, after) {
  const contents = await readFile(file, "utf8");
  if (!contents.includes(before)) throw new Error(`Controlled setup anchor missing: ${path.basename(file)}`);
  if (contents.indexOf(before) !== contents.lastIndexOf(before)) throw new Error(`Controlled setup anchor is ambiguous: ${path.basename(file)}`);
  await writeFile(file, contents.replace(before, after));
}

async function applyControlledSetup(setupId, workspace) {
  if (setupId === "evaluation-quality-claim-regression-v1") {
    await replaceExact(
      path.join(workspace, "src", "evaluation.mjs"),
      "const qualityClaimComparisons = comparisonReports.filter((comparison) => comparison.quality_claim_eligible);",
      "const qualityClaimComparisons = comparisonReports;",
    );
    return;
  }
  if (setupId === "shared-test-command-unknown-impact-v1") {
    const packagePath = path.join(workspace, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts.check = `${packageJson.scripts.check} && node --check src/verification-policy-missing.mjs`;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await appendFile(path.join(workspace, "src", "test-command.mjs"), "\n// Shared command-classification change under verification.\n");
    return;
  }
  if (setupId === "diagnostic-flaky-test-v1") {
    const testPath = path.join(workspace, "test", "diagnostics.test.mjs");
    await appendFile(testPath, `

test("intermittent benchmark fixture", async () => {
  const marker = path.resolve(".verification-policy-flaky-marker");
  try {
    await readFile(marker, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const { writeFile: writeMarker } = await import("node:fs/promises");
    await writeMarker(marker, "seen\\n");
    assert.fail("diagnostics:intermittent-fixture");
  }
});
`);
    return;
  }
  throw new Error(`Unsupported controlled setup: ${setupId}`);
}

export async function verificationWorkspaceChangedFiles(workspace) {
  const tracked = await run(["git", "diff", "--name-only", "--no-renames", "-z"], workspace);
  if (tracked.exit_code !== 0) throw new Error("Git diff failed while listing changed task files");
  const untracked = await run(["git", "ls-files", "--others", "--exclude-standard", "-z"], workspace);
  if (untracked.exit_code !== 0) throw new Error("Git ls-files failed while listing changed task files");
  return [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\0").filter(Boolean))].sort();
}

export async function verificationWorkspaceFileSha256(workspace, files) {
  const result = {};
  for (const relativePath of [...files].sort()) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
      throw new Error("Cannot hash a task file outside the workspace");
    }
    const filePath = path.join(workspace, relativePath);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        result[relativePath] = null;
        continue;
      }
      throw error;
    }
    const hash = createHash("sha256");
    if (stats.isSymbolicLink()) hash.update("symlink\0").update(await readlink(filePath));
    else if (stats.isFile()) hash.update("file\0").update(await readFile(filePath));
    else hash.update("other");
    result[relativePath] = hash.digest("hex");
  }
  return result;
}

export async function verificationWorkspaceStateSha256(workspace) {
  const result = await run(["git", "diff", "--binary", "--no-ext-diff"], workspace);
  if (result.exit_code !== 0) throw new Error("Git diff failed while hashing the task workspace");
  const untracked = await run(["git", "ls-files", "--others", "--exclude-standard", "-z"], workspace);
  if (untracked.exit_code !== 0) throw new Error("Git ls-files failed while hashing the task workspace");
  const hash = createHash("sha256").update("tracked-diff\0").update(result.stdout);
  for (const relativePath of untracked.stdout.split("\0").filter(Boolean).sort()) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
      throw new Error("Git reported an unsafe untracked path while hashing the task workspace");
    }
    const filePath = path.join(workspace, relativePath);
    const stats = await lstat(filePath);
    hash.update("\0untracked\0").update(relativePath).update("\0");
    if (stats.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(filePath));
    } else if (stats.isFile()) {
      hash.update("file\0").update(await readFile(filePath));
    } else {
      hash.update("other");
    }
  }
  return hash.digest("hex");
}

async function initializeIsolatedHistory(workspace) {
  await rm(path.join(workspace, ".git"), { recursive: true, force: true });
  await git(["init", "--quiet"], workspace);
  await git(["config", "user.name", "Verification Benchmark"], workspace);
  await git(["config", "user.email", "benchmark@example.invalid"], workspace);
  await git(["add", "."], workspace);
  await git(["commit", "--quiet", "-m", "benchmark base"], workspace, 30_000, {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  await appendFile(path.join(workspace, ".git", "info", "exclude"), "\n.verification-policy-flaky-marker\n");
}

export async function materializeVerificationTask({
  plan,
  taskId,
  sourceRepository,
  outputParent = os.tmpdir(),
  applyChange = true,
}) {
  const task = taskById(plan, taskId);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(task.task_id)) throw new Error("Task id is not safe for workspace materialization");
  const sourceRoot = await realpath(sourceRepository);
  await mkdir(outputParent, { recursive: true });
  const parent = await realpath(outputParent);
  const containerRoot = await mkdtemp(path.join(parent, `verification-${taskId}-`));
  const workspace = path.join(containerRoot, "workspace");
  const source = task.definition.source;
  let patchContents = null;
  try {
    await git(["cat-file", "-e", `${source.base_revision}^{commit}`], sourceRoot);
    if (source.kind === "repository_change") {
      await git(["cat-file", "-e", `${source.change_revision}^{commit}`], sourceRoot);
      patchContents = await repositoryDiff(sourceRoot, source, task.definition.changed_files);
    }
    await git(["clone", "--quiet", "--no-hardlinks", sourceRoot, workspace], parent, 120_000);
    await git(["checkout", "--quiet", source.base_revision], workspace);
    await initializeIsolatedHistory(workspace);
    if (applyChange) {
      if (source.kind === "repository_change") {
        await applyPatch(workspace, patchContents, containerRoot, "visible-change");
      } else {
        await applyControlledSetup(source.setup_id, workspace);
      }
      const observedFiles = await verificationWorkspaceChangedFiles(workspace);
      const expectedFiles = [...task.definition.changed_files].sort();
      if (JSON.stringify(observedFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error(`Materialized changed files do not match task definition: expected ${expectedFiles.join(",")}; observed ${observedFiles.join(",")}`);
      }
    }
    return {
      task_id: task.task_id,
      workspace,
      container_root: containerRoot,
      base_revision: source.base_revision,
      workspace_revision: await git(["rev-parse", "HEAD"], workspace),
      changed_files: applyChange ? await verificationWorkspaceChangedFiles(workspace) : [],
      changed_file_sha256: await verificationWorkspaceFileSha256(
        workspace,
        applyChange ? task.definition.changed_files : [],
      ),
      workspace_state_sha256: await verificationWorkspaceStateSha256(workspace),
      cleanup: () => rm(containerRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(containerRoot, { recursive: true, force: true });
    throw error;
  }
}

async function applyHiddenReferenceTests({ task, oracle, sourceRepository, materialized }) {
  const patchContents = await repositoryDiff(sourceRepository, task.definition.source, oracle.reference_test_paths);
  await applyPatch(materialized.workspace, patchContents, materialized.container_root, "hidden-reference-tests");
}

function commandFor(task, phase) {
  return task.definition.command_tiers[phase];
}

async function qualifyTask({ plan, oracles, task, sourceRepository, outputParent, timeoutMs }) {
  const oracle = oracleByTaskId(oracles, task.task_id);
  const executions = [];
  const execute = async (materialized, phase) => {
    const result = await run(commandFor(task, phase), materialized.workspace, timeoutMs);
    executions.push({ phase, exit_code: result.exit_code });
    return result.exit_code;
  };

  if (oracle.reference_test_paths.length > 0) {
    const gold = await materializeVerificationTask({ plan, taskId: task.task_id, sourceRepository, outputParent });
    const mutant = await materializeVerificationTask({ plan, taskId: task.task_id, sourceRepository, outputParent, applyChange: false });
    try {
      const visibleExit = task.behavior_class === "test_required" ? null : await execute(gold, "fast");
      await applyHiddenReferenceTests({ task, oracle, sourceRepository, materialized: gold });
      await applyHiddenReferenceTests({ task, oracle, sourceRepository, materialized: mutant });
      const goldExit = await execute(gold, "fast");
      const mutantExit = await execute(mutant, "fast");
      const observed = visibleExit === null ? [goldExit, mutantExit] : [visibleExit, goldExit, mutantExit];
      const expected = visibleExit === null ? [0, "nonzero"] : [0, 0, "nonzero"];
      const passed = expected.every((value, index) => value === "nonzero" ? observed[index] !== 0 : observed[index] === value);
      return { task_id: task.task_id, status: passed ? "passed" : "failed", expected_exit_pattern: expected, executions };
    } finally {
      await Promise.all([gold.cleanup(), mutant.cleanup()]);
    }
  }

  const materialized = await materializeVerificationTask({ plan, taskId: task.task_id, sourceRepository, outputParent });
  try {
    let expected;
    let observed;
    if (task.behavior_class === "affected_failure") {
      expected = ["nonzero"];
      observed = [await execute(materialized, "fast")];
    } else if (task.behavior_class === "full_fallback") {
      expected = [0, 0, "nonzero"];
      observed = [
        await execute(materialized, "fast"),
        await execute(materialized, "affected"),
        await execute(materialized, "full"),
      ];
    } else if (task.behavior_class === "flaky_retry") {
      expected = ["nonzero", 0];
      observed = [await execute(materialized, "fast"), await execute(materialized, "fast")];
    } else {
      expected = [0];
      observed = [await execute(materialized, oracle.minimum_evidence_phase)];
    }
    const passed = expected.every((value, index) => value === "nonzero" ? observed[index] !== 0 : observed[index] === value);
    return { task_id: task.task_id, status: passed ? "passed" : "failed", expected_exit_pattern: expected, executions };
  } finally {
    await materialized.cleanup();
  }
}

export async function qualifyVerificationPilot({ plan, oracles, sourceRepository, outputParent = os.tmpdir(), timeoutMs = 120_000 }) {
  const errors = validateVerificationBenchmark(plan, oracles);
  if (errors.length > 0) throw new VerificationBenchmarkValidationError(errors);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000");
  const sourceRoot = await realpath(sourceRepository);
  const taskReports = [];
  for (const task of plan.tasks) {
    taskReports.push(await qualifyTask({ plan, oracles, task, sourceRepository: sourceRoot, outputParent, timeoutMs }));
  }
  const ready = taskReports.every(({ status }) => status === "passed");
  return {
    schema_version: 1,
    evidence_class: "pilot_fixture_qualification",
    benchmark_id: plan.benchmark_id,
    counts: {
      tasks: taskReports.length,
      qualified_tasks: taskReports.filter(({ status }) => status === "passed").length,
      failed_tasks: taskReports.filter(({ status }) => status === "failed").length,
    },
    tasks: taskReports,
    conclusion: {
      status: ready ? "fixture_ready" : "blocked",
      quality_claim_eligible: false,
      blockers: ready ? ["paired_traces_not_collected"] : ["pilot_fixture_qualification_failed"],
    },
  };
}
