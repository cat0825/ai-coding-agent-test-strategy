import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
}

function assertMajor(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function assertCommand(command, name) {
  assertObject(command, name);
  if (command.status !== undefined) throw new Error(`${name}.status is not accepted; status is observed by preflight`);
  if (!Array.isArray(command.argv) || command.argv.length === 0) throw new Error(`${name}.argv must be a non-empty array`);
  for (const [index, argument] of command.argv.entries()) assertNonEmptyString(argument, `${name}.argv[${index}]`);
  if (command.timeout_ms !== undefined && (!Number.isInteger(command.timeout_ms) || command.timeout_ms <= 0)) {
    throw new Error(`${name}.timeout_ms must be a positive integer`);
  }
  if (command.cwd !== undefined) assertNonEmptyString(command.cwd, `${name}.cwd`);
}

function safeRepositoryPath(repoRoot, relativePath, name) {
  assertNonEmptyString(relativePath, name);
  if (path.isAbsolute(relativePath)) throw new Error(`${name} must be relative to the repository`);
  const resolved = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error(`${name} escapes the repository`);
  return resolved;
}

function commandWorkingDirectory(repoRoot, command, name) {
  return safeRepositoryPath(repoRoot, command.cwd ?? ".", `${name}.cwd`);
}

function assertAcyclicCommands(commands) {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const visiting = new Set();
  const visited = new Set();

  function visit(command) {
    if (visited.has(command.id)) return;
    if (visiting.has(command.id)) throw new Error(`Command prerequisite cycle detected at ${command.id}`);
    visiting.add(command.id);
    for (const prerequisite of command.prerequisites) visit(commandById.get(prerequisite));
    visiting.delete(command.id);
    visited.add(command.id);
  }

  for (const command of commands) visit(command);
}

export function validateBenchmarkSpec(spec) {
  assertObject(spec, "Benchmark preflight spec");
  if (spec.schema_version !== 1) throw new Error("Benchmark preflight spec schema_version must be 1");
  assertNonEmptyString(spec.benchmark_id, "benchmark_id");
  assertObject(spec.repository, "repository");
  if (!/^[0-9a-f]{40}$/i.test(spec.repository.expected_revision ?? "")) {
    throw new Error("repository.expected_revision must be a 40-character Git revision");
  }
  if (spec.repository.require_clean !== true) throw new Error("repository.require_clean must be true");

  assertObject(spec.runtime, "runtime");
  assertMajor(spec.runtime.node_major, "runtime.node_major");
  assertMajor(spec.runtime.npm_major, "runtime.npm_major");
  assertNonEmptyString(spec.runtime.platform, "runtime.platform");
  assertNonEmptyString(spec.runtime.arch, "runtime.arch");

  assertObject(spec.install, "install");
  if (spec.install.status !== undefined) {
    throw new Error("install.status is not accepted; status is observed by preflight");
  }
  assertCommand(spec.install.command, "install.command");
  assertObject(spec.install.lockfile, "install.lockfile");
  assertNonEmptyString(spec.install.lockfile.path, "install.lockfile.path");
  if (spec.install.lockfile.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(spec.install.lockfile.sha256)) {
    throw new Error("install.lockfile.sha256 must be a 64-character digest");
  }
  if (!Array.isArray(spec.install.required_paths)) throw new Error("install.required_paths must be an array");
  for (const [index, requiredPath] of spec.install.required_paths.entries()) {
    assertNonEmptyString(requiredPath, `install.required_paths[${index}]`);
  }
  if (!Array.isArray(spec.install.artifacts)) throw new Error("install.artifacts must be an array");
  const artifactNames = new Set();
  for (const [index, artifact] of spec.install.artifacts.entries()) {
    assertObject(artifact, `install.artifacts[${index}]`);
    assertNonEmptyString(artifact.name, `install.artifacts[${index}].name`);
    assertNonEmptyString(artifact.path, `install.artifacts[${index}].path`);
    if (!/^[0-9a-f]{64}$/i.test(artifact.sha256 ?? "")) {
      throw new Error(`install.artifacts[${index}].sha256 must be a 64-character digest`);
    }
    if (artifactNames.has(artifact.name)) throw new Error(`Duplicate artifact name: ${artifact.name}`);
    artifactNames.add(artifact.name);
  }

  if (!Array.isArray(spec.commands) || spec.commands.length === 0) throw new Error("commands must be a non-empty array");
  const commandIds = new Set();
  for (const [index, command] of spec.commands.entries()) {
    assertObject(command, `commands[${index}]`);
    assertNonEmptyString(command.id, `commands[${index}].id`);
    if (commandIds.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
    commandIds.add(command.id);
    assertCommand(command, `commands[${index}]`);
    if (command.required !== undefined && typeof command.required !== "boolean") {
      throw new Error(`commands[${index}].required must be a boolean`);
    }
    if (!Array.isArray(command.prerequisites)) throw new Error(`commands[${index}].prerequisites must be an array`);
    for (const prerequisite of command.prerequisites) assertNonEmptyString(prerequisite, `Prerequisite for ${command.id}`);
  }
  for (const command of spec.commands) {
    for (const prerequisite of command.prerequisites) {
      if (!commandIds.has(prerequisite)) throw new Error(`Command ${command.id} has unknown prerequisite ${prerequisite}`);
      if (prerequisite === command.id) throw new Error(`Command ${command.id} cannot require itself`);
    }
  }
  assertAcyclicCommands(spec.commands);
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function executeConfiguredCommand(command, repoRoot, name) {
  const cwd = commandWorkingDirectory(repoRoot, command, name);
  try {
    await execFileAsync(command.argv[0], command.argv.slice(1), {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: command.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
    return { status: "passed", exit_code: 0 };
  } catch (error) {
    return { status: "failed", exit_code: Number.isInteger(error.code) ? error.code : null };
  }
}

function commandDefinitionSha256(command) {
  return sha256Json({
    argv: command.argv,
    cwd: command.cwd ?? ".",
    timeout_ms: command.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  });
}

function major(version) {
  const match = /^(?:v)?(\d+)/.exec(version ?? "");
  return match ? Number.parseInt(match[1], 10) : null;
}

function topologicalCommands(commands) {
  const ordered = [];
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const visited = new Set();

  function visit(command) {
    if (visited.has(command.id)) return;
    for (const prerequisite of command.prerequisites) visit(commandById.get(prerequisite));
    visited.add(command.id);
    ordered.push(command);
  }

  for (const command of commands) visit(command);
  return ordered;
}

export async function generateBenchmarkManifest({ repoRoot, spec }) {
  validateBenchmarkSpec(spec);
  const resolvedRepoRoot = path.resolve(repoRoot);
  commandWorkingDirectory(resolvedRepoRoot, spec.install.command, "install.command");
  for (const command of spec.commands) commandWorkingDirectory(resolvedRepoRoot, command, `Command ${command.id}`);
  const resolvedRequiredPaths = [...spec.install.required_paths]
    .sort()
    .map((relativePath) => ({
      relativePath,
      resolved: safeRepositoryPath(resolvedRepoRoot, relativePath, `Required path ${relativePath}`),
    }));
  const expectedRevision = spec.repository.expected_revision.toLowerCase();
  const initialRevision = await commandOutput("git", ["rev-parse", "HEAD"], resolvedRepoRoot);
  const initialWorktreeStatus = await commandOutput(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    resolvedRepoRoot,
  );
  const npmVersion = await commandOutput("npm", ["--version"], resolvedRepoRoot);
  const observedRuntime = {
    platform: os.platform(),
    arch: os.arch(),
    node_version: process.version.replace(/^v/, ""),
    npm_version: npmVersion,
  };

  const reasons = [];
  if (initialRevision === null) reasons.push("repository_revision_unavailable");
  else if (initialRevision.toLowerCase() !== expectedRevision) reasons.push("repository_revision_mismatch");
  if (initialWorktreeStatus === null) reasons.push("repository_cleanliness_unavailable");
  else if (initialWorktreeStatus !== "") reasons.push("repository_dirty");
  if (observedRuntime.platform !== spec.runtime.platform) reasons.push("runtime_platform_mismatch");
  if (observedRuntime.arch !== spec.runtime.arch) reasons.push("runtime_arch_mismatch");
  if (major(observedRuntime.node_version) !== spec.runtime.node_major) reasons.push("runtime_node_major_mismatch");
  if (major(observedRuntime.npm_version) !== spec.runtime.npm_major) reasons.push("runtime_npm_major_mismatch");

  const lockfilePath = safeRepositoryPath(resolvedRepoRoot, spec.install.lockfile.path, "install.lockfile.path");
  const lockfilePresent = await fileExists(lockfilePath);
  const lockfileDigest = lockfilePresent ? await fileSha256(lockfilePath) : null;
  const expectedLockfileDigest = spec.install.lockfile.sha256?.toLowerCase() ?? null;
  if (!lockfilePresent) reasons.push("lockfile_missing");
  else if (expectedLockfileDigest && lockfileDigest !== expectedLockfileDigest) reasons.push("lockfile_checksum_mismatch");

  const artifacts = [];
  for (const artifact of [...spec.install.artifacts].sort((left, right) => left.name.localeCompare(right.name))) {
    const artifactPath = path.resolve(resolvedRepoRoot, artifact.path);
    const present = await fileExists(artifactPath);
    const digest = present ? await fileSha256(artifactPath) : null;
    const expectedDigest = artifact.sha256.toLowerCase();
    artifacts.push({
      name: artifact.name,
      file: path.basename(artifactPath),
      present,
      sha256: digest,
      expected_sha256: expectedDigest,
      checksum_match: digest === expectedDigest,
    });
    if (!present) reasons.push(`artifact_missing:${artifact.name}`);
    else if (digest !== expectedDigest) reasons.push(`artifact_checksum_mismatch:${artifact.name}`);
  }

  const foundationalFailure = reasons.length > 0;
  const installResult = foundationalFailure
    ? { status: "blocked", exit_code: null }
    : await executeConfiguredCommand(spec.install.command, resolvedRepoRoot, "install.command");
  if (installResult.status === "failed") reasons.push("install_failed");
  else if (installResult.status === "blocked") reasons.push("install_blocked");

  const requiredPaths = [];
  for (const { relativePath, resolved } of resolvedRequiredPaths) {
    const present = await fileExists(resolved);
    requiredPaths.push({ path: relativePath, present });
    if (!present) reasons.push(`required_path_missing:${relativePath}`);
  }

  const postInstallRevision = await commandOutput("git", ["rev-parse", "HEAD"], resolvedRepoRoot);
  const postInstallWorktreeStatus = await commandOutput(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    resolvedRepoRoot,
  );
  const repositoryStableAfterInstall =
    postInstallRevision === initialRevision && postInstallWorktreeStatus === initialWorktreeStatus;
  if (postInstallRevision !== initialRevision) reasons.push("repository_revision_changed_during_preflight");
  if (initialWorktreeStatus === "" && postInstallWorktreeStatus !== "") {
    reasons.push("repository_dirtied_during_preflight");
  }

  const commands = [];
  const commandById = new Map();
  const installEvidenceComplete =
    installResult.status === "passed" &&
    requiredPaths.every((entry) => entry.present) &&
    repositoryStableAfterInstall;
  for (const command of topologicalCommands(spec.commands)) {
    const unmetPrerequisites = command.prerequisites.filter(
      (prerequisite) => commandById.get(prerequisite)?.status !== "passed",
    );
    const result = !installEvidenceComplete || unmetPrerequisites.length > 0
      ? { status: "blocked", exit_code: null }
      : await executeConfiguredCommand(command, resolvedRepoRoot, `Command ${command.id}`);
    const observed = {
      id: command.id,
      required: command.required !== false,
      definition_sha256: commandDefinitionSha256(command),
      status: result.status,
      exit_code: result.exit_code,
      prerequisites: [...command.prerequisites].sort(),
    };
    commands.push(observed);
    commandById.set(command.id, observed);
    if (observed.required && observed.status !== "passed") {
      reasons.push(`command_not_passed:${observed.id}:${observed.status}`);
    }
    for (const prerequisite of unmetPrerequisites) {
      reasons.push(`command_prerequisite_unmet:${observed.id}:${prerequisite}`);
    }
  }

  const finalRevision = await commandOutput("git", ["rev-parse", "HEAD"], resolvedRepoRoot);
  const finalWorktreeStatus = await commandOutput(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    resolvedRepoRoot,
  );
  if (finalRevision !== initialRevision) reasons.push("repository_revision_changed_during_preflight");
  if (initialWorktreeStatus === "" && finalWorktreeStatus !== "") reasons.push("repository_dirtied_during_preflight");

  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    schema_version: 1,
    evidence_class: "benchmark_environment",
    benchmark_id: spec.benchmark_id,
    repository: {
      expected_revision: expectedRevision,
      observed_revision: finalRevision?.toLowerCase() ?? null,
      clean: finalWorktreeStatus === "",
    },
    runtime: {
      expected: { ...spec.runtime },
      observed: observedRuntime,
    },
    install: {
      ...installResult,
      definition_sha256: commandDefinitionSha256(spec.install.command),
      lockfile: {
        file: path.basename(lockfilePath),
        present: lockfilePresent,
        sha256: lockfileDigest,
        expected_sha256: expectedLockfileDigest,
        checksum_match: expectedLockfileDigest ? lockfileDigest === expectedLockfileDigest : null,
      },
      required_paths: requiredPaths,
      artifacts,
    },
    commands,
    conclusion: {
      status: uniqueReasons.length === 0 ? "eligible" : "ineligible",
      reasons: uniqueReasons,
    },
  };
}
