import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stableJson } from "./benchmark-preflight.mjs";

export const ORACLE_SCHEMA_VERSION = 1;
export const TASKTRACKER_ORACLE_VERSION = 1;
export const TASKTRACKER_ORACLE_TASKS = Object.freeze([
  "l2_add_completed_at",
  "l2_fix_formatter_bug",
  "l3_add_delete_command",
  "l3_add_json_format",
]);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oraclePath = path.join(projectRoot, "oracles", "agent-belt", "tasktracker_oracle.py");
const resultPrefix = "AGENT_TEST_ORACLE_RESULT=";
const maxOutputBytes = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid independent oracle evidence: ${message}`);
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!isObject(value)) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => containsKey(entry, key));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateEnvironment(environment) {
  assert(isObject(environment), "environment must be an object");
  assert(!containsKey(environment, "quality_claim_eligible"), "environment must not declare quality_claim_eligible");
  assert(environment.schema_version === 1 && environment.evidence_class === "benchmark_environment", "environment must be benchmark_environment schema v1");
  assert(environment.conclusion?.status === "eligible", "environment must be eligible");
  assert(nonEmptyString(environment.benchmark_id), "environment must include benchmark_id");
  assert(nonEmptyString(environment.repository?.identity), "environment must include repository identity");
  assert(/^[a-f0-9]{40}$/i.test(environment.repository?.observed_revision ?? ""), "environment must include observed Git revision");
  assert(environment.repository.expected_revision === environment.repository.observed_revision, "environment expected and observed revisions must match");
}

async function sourceTreeDigest(repoRoot) {
  const sourceRoot = path.join(repoRoot, "src", "tasktracker");
  assert((await stat(sourceRoot)).isDirectory(), "workspace must include src/tasktracker");
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const absolute = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), "workspace source tree must not contain symlinks");
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const metadata = await stat(absolute);
        assert(metadata.size <= maxOutputBytes, "workspace source file exceeds the oracle size limit");
        files.push({ relative: path.relative(repoRoot, absolute).split(path.sep).join("/"), contents: await readFile(absolute) });
      }
    }
  }

  await walk(sourceRoot);
  assert(files.length > 0 && files.length <= 200, "workspace source tree must contain between 1 and 200 files");
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.relative).update("\0").update(file.contents).update("\0");
  return { sha256: digest.digest("hex"), fileCount: files.length };
}

function executeOracle({ pythonBinary, repoRoot, taskId, timeoutMs, oracleHome }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary, [oraclePath, taskId], {
      cwd: repoRoot,
      env: {
        HOME: oracleHome,
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        PATH: process.env.PATH ?? "",
        PYTHONHASHSEED: "0",
        PYTHONNOUSERSITE: "1",
        PYTHONPATH: path.join(repoRoot, "src"),
        PYTHONDONTWRITEBYTECODE: "1",
        TMPDIR: oracleHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maxOutputBytes) {
        exceeded = true;
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => reject(new Error(`Oracle process could not start: ${error.code ?? error.name}`)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (exceeded) return reject(new Error("Oracle output exceeded the size limit"));
      if (signal) return reject(new Error("Oracle execution timed out or was terminated"));
      const resultLine = stdout.split(/\r?\n/).findLast((line) => line.startsWith(resultPrefix));
      if (!resultLine) return reject(new Error(`Oracle result missing (exit ${exitCode}; stderr ${stderr.length > 0 ? "present" : "empty"})`));
      let result;
      try {
        result = JSON.parse(resultLine.slice(resultPrefix.length));
      } catch {
        return reject(new Error("Oracle result is not valid JSON"));
      }
      if (!isObject(result) || !["passed", "failed"].includes(result.status)) return reject(new Error("Oracle result status is invalid"));
      if (!Array.isArray(result.failure_signatures) || result.failure_signatures.some((signature) => !nonEmptyString(signature))) {
        return reject(new Error("Oracle failure signatures are invalid"));
      }
      const expectedExitCode = result.status === "passed" ? 0 : 1;
      if (exitCode !== expectedExitCode || (result.status === "passed") !== (result.failure_signatures.length === 0)) {
        return reject(new Error("Oracle result, exit code, and failure signatures are inconsistent"));
      }
      return resolve(result);
    });
  });
}

export async function runTasktrackerOracle({ taskId, repoRoot, environment, environmentSourceDigest, pythonBinary = "python3", timeoutMs = 30_000, allowHost = false }) {
  assert(TASKTRACKER_ORACLE_TASKS.includes(taskId), `unsupported task_id ${taskId}`);
  validateEnvironment(environment);
  assert(/^[a-f0-9]{64}$/i.test(environmentSourceDigest ?? ""), "environmentSourceDigest must be a SHA-256 digest");
  assert(nonEmptyString(pythonBinary), "pythonBinary must be a non-empty string");
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, "timeoutMs must be between 1 and 120000");
  assert(allowHost === true, "host execution requires explicit allowHost=true");
  const resolvedRepo = await realpath(repoRoot);
  const [workspace, definition] = await Promise.all([sourceTreeDigest(resolvedRepo), readFile(oraclePath)]);
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "agent-test-oracle-home-"));
  let result;
  try {
    result = await executeOracle({ pythonBinary, repoRoot: resolvedRepo, taskId, timeoutMs, oracleHome });
  } finally {
    await rm(oracleHome, { recursive: true, force: true });
  }
  return {
    schema_version: ORACLE_SCHEMA_VERSION,
    evidence_class: "independent_oracle",
    task_id: taskId,
    oracle: {
      id: `agent-belt-tasktracker-${taskId}`,
      version: TASKTRACKER_ORACLE_VERSION,
      definition_sha256: hash(definition),
    },
    environment: {
      benchmark_id: environment.benchmark_id,
      repository_identity: environment.repository.identity,
      repository_revision: environment.repository.observed_revision,
      manifest_digest: hash(stableJson(environment)),
      source_sha256: environmentSourceDigest,
    },
    workspace: {
      source_tree_sha256: workspace.sha256,
      source_file_count: workspace.fileCount,
    },
    execution: {
      sandbox: "host",
      explicit_host_opt_in: true,
      environment_policy: "minimal",
    },
    result,
    eligibility: {
      baseline_quality_claim_eligible: false,
      reasons: ["complete_baseline_verifytrace_missing"],
    },
  };
}
