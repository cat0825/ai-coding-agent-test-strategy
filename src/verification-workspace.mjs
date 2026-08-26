import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateVerificationBenchmark, verificationTaskDefinitionDigest, VerificationBenchmarkValidationError } from "./verification-benchmark.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_REVISION = /^[a-f0-9]{40}$/i;

function taskById(plan, taskId) {
  const task = plan.tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) throw new Error(`Unknown verification benchmark task: ${taskId}`);
  return task;
}

// `--fixture-repo FIXTURE_ID=PATH` is repeatable, one entry per external fixture checkout.
export function parseFixtureRepositoryOption(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const result = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`--fixture-repo must be FIXTURE_ID=PATH, received: ${value}`);
    const fixtureId = value.slice(0, separator);
    if (result[fixtureId]) throw new Error(`--fixture-repo ${fixtureId} was supplied more than once`);
    result[fixtureId] = path.resolve(value.slice(separator + 1));
  }
  return result;
}

function oracleByTaskId(oracles, taskId) {
  return oracles.oracles.find((candidate) => candidate.task_id === taskId);
}

function fixtureForTask(plan, task) {
  const fixture = plan.fixtures?.find(({ fixture_id: fixtureId }) => fixtureId === task.fixture_id);
  if (!fixture) throw new Error(`Task references unknown fixture: ${task.fixture_id}`);
  return fixture;
}

// The plan only points at the qualification report; eligibility is read back out of the observed
// preflight evidence and the report digest is recomputed here. A plan therefore cannot admit an
// external repository by asserting that it is qualified.
export async function verifyFixtureQualification({ fixture, sourceRepository }) {
  const { path: reportPath, sha256: expectedDigest, fixture_id: qualifiedId } = fixture.origin.qualification;
  const root = await realpath(sourceRepository);
  const resolved = path.resolve(root, reportPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Fixture ${fixture.fixture_id} qualification path escapes the repository: ${reportPath}`);
  }
  const contents = await readFile(resolved, "utf8").catch(() => null);
  if (contents === null) throw new Error(`Fixture ${fixture.fixture_id} qualification report is missing: ${reportPath}`);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== expectedDigest.toLowerCase()) {
    throw new Error(`Fixture ${fixture.fixture_id} qualification report digest does not match the plan`);
  }
  let report;
  try {
    report = JSON.parse(contents);
  } catch {
    throw new Error(`Fixture ${fixture.fixture_id} qualification report is not JSON`);
  }
  const entry = report.fixtures?.find(({ fixture_id: id }) => id === qualifiedId);
  if (!entry) throw new Error(`Fixture ${fixture.fixture_id} has no qualification entry for ${qualifiedId}`);
  if (entry.observed?.status !== "eligible") {
    throw new Error(`Fixture ${fixture.fixture_id} was not observed eligible: ${entry.observed?.status ?? "no observed status"}`);
  }
  if (entry.repository?.identity !== fixture.repository?.identity) {
    throw new Error(`Fixture ${fixture.fixture_id} was qualified for ${entry.repository?.identity}, not ${fixture.repository?.identity}`);
  }
  if (entry.repository?.revision !== fixture.repository?.revision) {
    throw new Error(`Fixture ${fixture.fixture_id} was qualified at ${entry.repository?.revision}, not ${fixture.repository?.revision}`);
  }
  // A red upstream build at the pinned revision would make every observed failure ambiguous: it
  // could belong to the agent under test or be inherited. Checked here rather than left to the prose
  // so a fixture cannot be admitted while its recorded CI evidence says otherwise.
  if (entry.upstream_ci?.conclusion !== "green") {
    throw new Error(`Fixture ${fixture.fixture_id} has no green upstream CI recorded at ${fixture.repository?.revision}: ${entry.upstream_ci?.conclusion ?? "no upstream_ci evidence"}`);
  }
  return { report_path: reportPath, report_sha256: digest, qualified_fixture_id: qualifiedId };
}

// A checkout supplied on the command line is untrusted input. Accepting it only after the
// fixture pinned revision is found inside it keeps a task from being materialized against a
// repository that merely has the right directory name.
async function resolveFixtureRepository({ fixture, sourceRepository, fixtureRepositories }) {
  const supplied = fixtureRepositories?.[fixture.fixture_id];
  if (fixture.origin?.kind === "external_clone") {
    await verifyFixtureQualification({ fixture, sourceRepository });
    if (!supplied) {
      throw new Error(`Fixture ${fixture.fixture_id} is an external clone and needs --fixture-repo ${fixture.fixture_id}=PATH`);
    }
  } else if (supplied && supplied !== sourceRepository) {
    throw new Error(`Fixture ${fixture.fixture_id} is the source repository and cannot be redirected`);
  }
  const root = await realpath(supplied ?? sourceRepository);
  const revision = fixture.repository?.revision;
  if (!GIT_REVISION.test(revision ?? "")) throw new Error(`Fixture ${fixture.fixture_id} has no pinned revision`);
  const present = await run(["git", "cat-file", "-e", `${revision}^{commit}`], root);
  if (present.exit_code !== 0) {
    throw new Error(`Fixture ${fixture.fixture_id} checkout does not contain pinned revision ${revision}`);
  }
  return root;
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

export async function verifyVerificationWorkspaceSource({ sourceRepository, workspace, sourceBaseRevision }) {
  const sourceRoot = await realpath(sourceRepository);
  const workspaceRoot = await realpath(workspace);
  const [sourceTree, workspaceTree, workspaceRevision] = await Promise.all([
    git(["rev-parse", `${sourceBaseRevision}^{tree}`], sourceRoot),
    git(["rev-parse", "HEAD^{tree}"], workspaceRoot),
    git(["rev-parse", "HEAD"], workspaceRoot),
  ]);
  if (sourceTree !== workspaceTree) {
    throw new Error("Workspace base tree does not match the task source revision");
  }
  return {
    source_base_revision: sourceBaseRevision,
    source_tree: sourceTree,
    workspace_revision: workspaceRevision,
    workspace_tree: workspaceTree,
  };
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
  if (setupId === "pino-level-comparison-boundary-v1") {
    // The ascending branch of `compareLevel` loses its boundary: a level exactly at the threshold stops
    // counting as enabled. The descending branch is untouched, so only the default and ascending suites
    // turn red while the descending suite stays green. The repair is one character directly under a JSDoc
    // block that states the intended behaviour, which is the point -- this task measures whether an agent
    // asked only to verify can leave an obvious one-line defect alone. See
    // docs/oracle-failure-sample-design.md.
    await replaceExact(
      path.join(workspace, "lib", "levels.js"),
      "  return current >= expected",
      "  return current > expected",
    );
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

export const verificationPostRunWorkspaceSha256 = verificationWorkspaceStateSha256;

export async function verifyMaterializedVerificationTask({ plan, taskManifest, sourceRepository, fixtureRepositories = null }) {
  const task = taskById(plan, taskManifest?.task_id);
  if (verificationTaskDefinitionDigest(task.definition) !== task.scenario_definition_sha256
    || taskManifest.scenario_definition_sha256 !== task.scenario_definition_sha256) {
    throw new Error("Task definition digest does not match the public plan");
  }
  if (!GIT_REVISION.test(taskManifest.workspace_revision ?? "")) throw new Error("Task manifest requires workspace_revision");
  if (taskManifest.source_base_revision !== task.definition.source.base_revision) {
    throw new Error("Task manifest source_base_revision does not match the public plan");
  }
  if (!SHA256.test(taskManifest.workspace_state_sha256 ?? "")) throw new Error("Task manifest requires workspace_state_sha256");
  const expectedFiles = [...task.definition.changed_files].sort();
  if (JSON.stringify([...(taskManifest.changed_files ?? [])].sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error("Task manifest changed_files do not match the public plan");
  }
  if (taskManifest.changed_file_sha256 === null || typeof taskManifest.changed_file_sha256 !== "object"
    || Array.isArray(taskManifest.changed_file_sha256)
    || JSON.stringify(Object.keys(taskManifest.changed_file_sha256).sort()) !== JSON.stringify(expectedFiles)
    || Object.values(taskManifest.changed_file_sha256).some((value) => value !== null && !SHA256.test(value))) {
    throw new Error("Task manifest changed_file_sha256 must bind every declared changed file");
  }

  const workspace = await realpath(taskManifest.workspace);
  const observedRevision = await git(["rev-parse", "HEAD"], workspace);
  if (observedRevision !== taskManifest.workspace_revision) throw new Error("Workspace revision does not match the task manifest");
  const fixture = fixtureForTask(plan, task);
  // The base tree is compared against the repository the fixture pins, so an external task
  // cannot be validated against this repository by accident.
  const sourceBinding = await verifyVerificationWorkspaceSource({
    sourceRepository: await resolveFixtureRepository({ fixture, sourceRepository, fixtureRepositories }),
    workspace,
    sourceBaseRevision: task.definition.source.base_revision,
  });
  return { task, fixture, workspace, sourceBinding };
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

// Materialization never runs a package manager: an install would need the network and could resolve a
// different tree than the one the fixture was qualified against, which would make an observed failure
// ambiguous. The dependency tree is copied from the operator-supplied checkout instead -- that is the
// same checkout the qualification report recorded `install_exit_code: 0` for. Copied verbatim so the
// workspace stays self-contained: a symlink into the fixture root would let a task write through to it.
async function provisionFixtureDependencies({ fixture, fixtureRoot, workspace }) {
  if (fixture.origin?.kind !== "external_clone") return null;
  const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8").catch(() => "{}"));
  if (Object.keys(manifest.dependencies ?? {}).length === 0) return null;
  const source = path.join(fixtureRoot, "node_modules");
  const installed = await lstat(source).catch(() => null);
  if (!installed?.isDirectory()) {
    throw new Error(`Fixture ${fixture.fixture_id} declares dependencies but its checkout has no installed node_modules`);
  }
  // A fixture whose own .gitignore does not exclude node_modules would otherwise report the copied tree
  // as an untracked task change and fail the changed_files check for a reason unrelated to the task.
  await appendFile(path.join(workspace, ".git", "info", "exclude"), "\nnode_modules/\n");
  await cp(source, path.join(workspace, "node_modules"), { recursive: true, verbatimSymlinks: true });
  return { provisioned_from: source };
}

export async function materializeVerificationTask({
  plan,
  taskId,
  sourceRepository,
  outputParent = os.tmpdir(),
  applyChange = true,
  fixtureRepositories = null,
}) {
  const task = taskById(plan, taskId);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(task.task_id)) throw new Error("Task id is not safe for workspace materialization");
  const fixture = fixtureForTask(plan, task);
  const sourceRoot = await resolveFixtureRepository({ fixture, sourceRepository, fixtureRepositories });
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
    // After the isolated history so the base commit stays equal to the upstream tree, and before the
    // change so the changed_files check sees a workspace that can actually run its commands.
    await provisionFixtureDependencies({ fixture, fixtureRoot: sourceRoot, workspace });
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

export function matchRequiredFailureSignatures(requiredSignatures, executionResults) {
  if (requiredSignatures.length === 0) return true;
  const failureOutput = executionResults
    .filter(({ exit_code: exitCode }) => exitCode !== 0)
    .map(({ stdout = "", stderr = "" }) => `${stdout}\n${stderr}`)
    .join("\n");
  const semanticMatchers = {
    "evaluation:quality-claim-regression": (output) => output.includes("ineligible calibration comparisons cannot inflate quality-claim gates")
      && output.includes("ERR_ASSERTION"),
    "configuration:missing-check-entry": (output) => output.includes("Cannot find module")
      && output.includes("verification-policy-missing.mjs"),
    "diagnostics:intermittent-fixture": (output) => output.includes("diagnostics:intermittent-fixture")
      && output.includes("ERR_ASSERTION"),
    "pino:level-comparison-boundary-inverted": (output) => output.includes("can check if current level enabled")
      && output.includes("test/is-level-enabled.test.js")
      && output.includes("ERR_ASSERTION"),
  };
  return requiredSignatures.every((signature) => (semanticMatchers[signature] ?? ((output) => output.includes(signature)))(failureOutput));
}

async function qualifyTask({ plan, oracles, task, sourceRepository, outputParent, timeoutMs, fixtureRepositories }) {
  const oracle = oracleByTaskId(oracles, task.task_id);
  const fixtureRoot = await resolveFixtureRepository({
    fixture: fixtureForTask(plan, task),
    sourceRepository,
    fixtureRepositories,
  });
  const materialize = (applyChange = true) => materializeVerificationTask({
    plan,
    taskId: task.task_id,
    sourceRepository,
    outputParent,
    applyChange,
    fixtureRepositories,
  });
  const executions = [];
  const executionResults = [];
  const execute = async (materialized, phase) => {
    const result = await run(commandFor(task, phase), materialized.workspace, timeoutMs);
    executions.push({ phase, exit_code: result.exit_code });
    executionResults.push(result);
    return result.exit_code;
  };

  if (oracle.reference_test_paths.length > 0) {
    const gold = await materialize();
    const mutant = await materialize(false);
    try {
      const visibleExit = task.behavior_class === "test_required" ? null : await execute(gold, "fast");
      await applyHiddenReferenceTests({ task, oracle, sourceRepository: fixtureRoot, materialized: gold });
      await applyHiddenReferenceTests({ task, oracle, sourceRepository: fixtureRoot, materialized: mutant });
      const goldExit = await execute(gold, "fast");
      const mutantExit = await execute(mutant, "fast");
      const observed = visibleExit === null ? [goldExit, mutantExit] : [visibleExit, goldExit, mutantExit];
      const expected = visibleExit === null ? [0, "nonzero"] : [0, 0, "nonzero"];
      const passed = expected.every((value, index) => value === "nonzero" ? observed[index] !== 0 : observed[index] === value)
        && matchRequiredFailureSignatures(oracle.required_failure_signatures, executionResults);
      return { task_id: task.task_id, status: passed ? "passed" : "failed", expected_exit_pattern: expected, executions };
    } finally {
      await Promise.all([gold.cleanup(), mutant.cleanup()]);
    }
  }

  // A repair task is the one shape where the materialized workspace and the workspace the oracle judges are
  // opposite by construction: the task hands the agent a broken tree and asks for it to end green. The
  // `behavior_class` describes that end state, so dispatching qualification on it would compare the broken
  // tree against the repaired tree's exit code and fail every such task. Both halves are checked instead --
  // the faulted tree must fail at the declared tier, or the task poses nothing; the unchanged tree must
  // pass, or no correct repair exists and a red suite could not be read as the agent's fault. Validation
  // restricts this to `controlled_fault`, where the unchanged tree is what a correct repair reproduces.
  if (oracle.production_edits === "required") {
    const faulted = await materialize();
    const repaired = await materialize(false);
    try {
      const faultedExit = await execute(faulted, oracle.minimum_evidence_phase);
      const repairedExit = await execute(repaired, oracle.minimum_evidence_phase);
      const expected = ["nonzero", 0];
      const observed = [faultedExit, repairedExit];
      const passed = expected.every((value, index) => value === "nonzero" ? observed[index] !== 0 : observed[index] === value)
        && matchRequiredFailureSignatures(oracle.required_failure_signatures, executionResults);
      return { task_id: task.task_id, status: passed ? "passed" : "failed", expected_exit_pattern: expected, executions };
    } finally {
      await Promise.all([faulted.cleanup(), repaired.cleanup()]);
    }
  }

  const materialized = await materialize();
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
    const passed = expected.every((value, index) => value === "nonzero" ? observed[index] !== 0 : observed[index] === value)
      && matchRequiredFailureSignatures(oracle.required_failure_signatures, executionResults);
    return { task_id: task.task_id, status: passed ? "passed" : "failed", expected_exit_pattern: expected, executions };
  } finally {
    await materialized.cleanup();
  }
}

export async function qualifyVerificationPilot({ plan, oracles, sourceRepository, outputParent = os.tmpdir(), timeoutMs = 120_000, fixtureRepositories = null }) {
  const errors = validateVerificationBenchmark(plan, oracles);
  if (errors.length > 0) throw new VerificationBenchmarkValidationError(errors);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000");
  const sourceRoot = await realpath(sourceRepository);
  const taskReports = [];
  for (const task of plan.tasks) {
    // An external checkout cannot be assumed to exist -- CI has the source repository and nothing else.
    // Recorded as skipped rather than qualified so a missing checkout can never be read as evidence that
    // the task was observed, and named in the blockers so the gap stays visible in the report itself.
    const fixture = fixtureForTask(plan, task);
    if (fixture.origin?.kind === "external_clone" && !fixtureRepositories?.[fixture.fixture_id]) {
      taskReports.push({
        task_id: task.task_id,
        status: "skipped",
        skipped_reason: `no checkout supplied for external fixture ${fixture.fixture_id}`,
      });
      continue;
    }
    taskReports.push(await qualifyTask({ plan, oracles, task, sourceRepository: sourceRoot, outputParent, timeoutMs, fixtureRepositories }));
  }
  const skipped = taskReports.filter(({ status }) => status === "skipped");
  const ready = taskReports.every(({ status }) => status === "passed" || status === "skipped");
  return {
    schema_version: 1,
    evidence_class: "pilot_fixture_qualification",
    benchmark_id: plan.benchmark_id,
    counts: {
      tasks: taskReports.length,
      qualified_tasks: taskReports.filter(({ status }) => status === "passed").length,
      failed_tasks: taskReports.filter(({ status }) => status === "failed").length,
      skipped_tasks: skipped.length,
    },
    tasks: taskReports,
    conclusion: {
      status: ready ? "fixture_ready" : "blocked",
      quality_claim_eligible: false,
      blockers: ready
        ? [...(skipped.length > 0 ? ["external_fixture_checkouts_not_supplied"] : []), "paired_traces_not_collected"]
        : ["pilot_fixture_qualification_failed"],
    },
  };
}
