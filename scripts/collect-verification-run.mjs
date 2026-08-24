#!/usr/bin/env node

// One (task, arm) verification-policy collection, start to finish.
//
// Every step here was previously typed by hand, once, per run. That is how the `--policy-ledger` hole got
// in: a flag left off a command typed once leaves no trace afterwards, and the resulting trace reads
// exactly like a compliant run. So the arm's mode, policy identity, hook wiring and prompt are all
// derived in one place, and the things a trace cannot prove on its own -- that the hook actually fired,
// that the ledger belongs to this run -- are asserted here before the trace is written.
//
// The two arms differ in exactly one way: the candidate has the PreToolUse/PostToolUse hook installed.
// The prompt is byte-identical, and its digest is recorded, because enforcement is the harness's job and
// not something asked of the agent in the prompt.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = "fixtures/benchmark/verification-policy-pilot-plan.json";
const ORACLES = "fixtures/benchmark/verification-policy-pilot-oracles.json";
// Named once. A trace rebuilt later reads this back out of the run record, so the string in the trace and the
// string in the record cannot drift the way the policy version once did.
const HARNESS = "codex-cli@0.149.0";

const ARMS = {
  baseline: { mode: "baseline", policy_name: "unmanaged-coding-agent-baseline", policy_version: "1", hook: false },
  candidate: { mode: "shadow", policy_name: "observatory-verification-policy", policy_version: null, hook: true },
};

function usage() {
  return "Usage: node scripts/collect-verification-run.mjs --task TASK_ID --arm baseline|candidate --root DIRECTORY [--model MODEL] [--effort EFFORT] [--base-url URL] [--timeout-ms MS] [--rebuild-trace]\n";
}

function parseArguments(argv) {
  const options = { model: "gpt-5.6-sol", effort: "high", base_url: "https://agentrouter.org/v1", timeout_ms: "1200000" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--rebuild-trace") {
      options.rebuild_trace = true;
      continue;
    }
    if (!["--task", "--arm", "--root", "--model", "--effort", "--base-url", "--timeout-ms"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(value) {
  return sha256(value).slice(0, 16);
}

function log(step, detail) {
  process.stdout.write(`[${step}] ${detail}\n`);
}

function run(command, args, { cwd = REPO_ROOT, env = process.env, timeoutMs = 0, stdoutFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdoutFile) process.stderr.write(".");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (stdoutFile) process.stderr.write("\n");
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function runOrThrow(step, command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.timedOut) throw new Error(`${step} timed out`);
  if (result.code !== 0) throw new Error(`${step} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function soleFile(directory, suffix) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${directory}, found ${names.length}`);
  return path.join(directory, names[0]);
}

async function exists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

// The task manifest records where the workspace was materialized as an absolute path, which stops resolving
// when the run directory is renamed -- how failed runs are kept for reference. The materialization name is
// random per run, so a stale path cannot quietly resolve to another run's workspace; it just fails, which
// would leave archived runs pinned to whichever converter built them. So the workspace is resolved inside the
// run directory as well, and only when the recorded path is genuinely gone. task.json itself is left as
// written: the record of where this run actually ran is not edited to make a later rebuild work.
async function resolveManifest(runDir) {
  const recordedPath = path.join(runDir, "task.json");
  const manifest = await readJson(recordedPath);
  if (await exists(manifest.workspace)) return { manifestPath: recordedPath, relocated: null };
  const workspaceParent = path.join(runDir, "workspaces");
  const materialized = (await readdir(workspaceParent, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (materialized.length !== 1) {
    throw new Error(`Workspace ${manifest.workspace} is gone and ${workspaceParent} holds ${materialized.length} candidates, not 1`);
  }
  const workspace = path.join(workspaceParent, materialized[0].name, "workspace");
  if (!(await exists(workspace))) throw new Error(`Workspace ${manifest.workspace} is gone and ${workspace} does not exist either`);
  const manifestPath = path.join(runDir, "task.rebuild.json");
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, workspace }, null, 2)}\n`, "utf8");
  return { manifestPath, relocated: { from: manifest.workspace, to: workspace } };
}

function ndjsonRecords(contents) {
  return contents.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

// The one place raw evidence becomes a trace. A trace rebuilt after the converter changes has to go through
// the same call the original went through, or the rebuild is a second implementation that can disagree with
// the first: vp_flaky_retry_once was rebuilt by a hand-typed CLI invocation and ended up with a valid
// trace.json on disk while run.json still recorded the failing exit code from before the fix, which no
// reader could resolve without re-running the agent.
function buildTrace({
  manifestPath, streamPath, lifecyclePath, collectorManifest, ledgerPath,
  runId, harness, model, mode, policyName, policyVersion, tracePath,
}) {
  return run(process.execPath, [
    "src/verification-trace-cli.mjs",
    "--plan", PLAN,
    "--oracles", ORACLES,
    "--repo", ".",
    "--task-manifest", manifestPath,
    "--stream", streamPath,
    "--lifecycle", lifecyclePath,
    "--collector", collectorManifest,
    ...(ledgerPath ? ["--policy-ledger", ledgerPath] : []),
    "--run-id", runId,
    "--harness", harness,
    "--model", model,
    "--mode", mode,
    "--policy-name", policyName,
    "--policy-version", policyVersion,
    "--output", tracePath,
  ]);
}

// Re-derives one trace from evidence already on disk, for when the converter is fixed after collection.
// Nothing is re-run and nothing is re-observed -- the stream, lifecycle, ledger and workspace are the
// untouched originals -- so this changes only what was derived from them: trace.json and run.json's `trace`
// block, which must move together.
async function rebuildTrace(runDir) {
  const runRecordPath = path.join(runDir, "run.json");
  const record = await readJson(runRecordPath);
  // Resolved inside the run directory rather than read from record.paths. Those are absolute and were
  // correct when written; a run kept for reference under a renamed directory leaves them pointing at
  // whatever now occupies the old name, which would rebuild this trace from another run's evidence.
  const { manifestPath, relocated } = await resolveManifest(runDir);
  if (relocated) log("trace", `workspace moved with the run directory: ${relocated.from} -> ${relocated.to}`);
  const streamPath = path.join(runDir, "stream.ndjson");
  const lifecyclePath = await soleFile(path.join(runDir, "lifecycle"), ".ndjson");
  const collectorManifest = path.join(runDir, "bin", "codex-lifecycle-config.json");
  const ledgerPath = record.mode === "shadow" ? path.join(runDir, "hook", "state", "policy-decisions.ndjson") : null;
  if (ledgerPath !== null && (await readFile(ledgerPath, "utf8").catch(() => null)) === null) {
    throw new Error(`No policy ledger at ${ledgerPath}: refusing to rebuild a candidate trace without the enforcement it claims`);
  }
  const tracePath = path.join(runDir, "trace.json");
  // Keep the identifier the original trace was published under; a rebuild is the same run re-read.
  const previous = await readJson(tracePath).catch(() => null);
  const runId = previous?.run_id ?? `${record.arm}-${record.task_id.replaceAll("_", "-")}`;

  log("trace", `rebuilding ${record.mode} trace for ${record.task_id}/${path.basename(runDir)} as ${runId}`);
  const trace = await buildTrace({
    manifestPath,
    streamPath,
    lifecyclePath,
    collectorManifest,
    ledgerPath,
    runId,
    harness: record.harness,
    model: record.model,
    mode: record.mode,
    policyName: record.policy.name,
    policyVersion: record.policy.version,
    tracePath,
  });
  log("trace", `exit=${trace.code} ${trace.stdout.trim() || trace.stderr.trim()}`);

  const updated = {
    ...record,
    trace: { exit_code: trace.code, report: tracePath, stdout: trace.stdout.trim(), stderr: trace.stderr.trim() },
    trace_rebuilt_from: { previous_exit_code: record.trace.exit_code, collector_sha256: record.collector_sha256 },
  };
  await writeFile(runRecordPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ run: runRecordPath, trace_exit: trace.code, trace_stdout: trace.stdout.trim() })}\n`);
  if (trace.code !== 0) process.exitCode = 2;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  for (const option of ["task", "arm", "root"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }
  // Every parameter of a rebuild comes from the run record, so this runs before the ARMS lookup: it has to
  // work for runs kept under a renamed directory, which that lookup rejects.
  if (options.rebuild_trace) {
    await rebuildTrace(path.resolve(options.root, options.task, options.arm));
    return;
  }
  const arm = ARMS[options.arm];
  if (!arm) throw new Error("--arm must be baseline or candidate");
  const token = process.env.RELAY_API_KEY;
  if (!token) throw new Error("RELAY_API_KEY must be set in the environment");

  const runDir = path.resolve(options.root, options.task, options.arm);
  const lifecycleDir = path.join(runDir, "lifecycle");
  const binDir = path.join(runDir, "bin");
  const hookDir = path.join(runDir, "hook");
  const codexHome = path.join(runDir, "codex-home");
  const workspaceParent = path.join(runDir, "workspaces");
  await mkdir(runDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspaceParent, { recursive: true });

  log("workspace", `materializing ${options.task}`);
  const prepared = await runOrThrow("verification-task-cli", process.execPath, [
    "src/verification-task-cli.mjs",
    "--plan", PLAN,
    "--task", options.task,
    "--repo", ".",
    "--output-parent", workspaceParent,
  ]);
  const manifest = JSON.parse(prepared.stdout);
  const manifestPath = path.join(runDir, "task.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log("workspace", `${manifest.workspace} @ ${manifest.workspace_revision.slice(0, 12)}`);

  let policyVersion = arm.policy_version;
  let ledgerPath = null;
  if (arm.hook) {
    log("hook", "installing PreToolUse/PostToolUse policy hook");
    const hookPrep = await runOrThrow("prepare-verification-policy-hook", process.execPath, [
      "src/prepare-verification-policy-hook.mjs",
      "--plan", PLAN,
      "--task-manifest", manifestPath,
      "--output-dir", hookDir,
    ]);
    const hookPaths = JSON.parse(hookPrep.stdout);
    ledgerPath = hookPaths.ledger;
    // The version the trace claims has to be the version the hook was actually built from, not a string
    // repeated by hand at the trace call. They drifted once already (0.2-enforced vs 0.3-rewrite).
    const policy = await readJson(hookPaths.policy);
    policyVersion = policy.policy.version;
    await copyFile(hookPaths.hooks, path.join(codexHome, "hooks.json"));
    log("hook", `policy ${policy.policy.name}@${policyVersion}, allow_full_suite=${policy.allow_full_suite}`);
  }

  log("collector", "installing codex lifecycle wrapper");
  const collectorPrep = await runOrThrow("prepare-codex-collector", process.execPath, [
    "src/prepare-codex-collector.mjs",
    "--real-codex", "/opt/homebrew/bin/codex",
    "--bin-dir", binDir,
    "--lifecycle-dir", lifecycleDir,
  ]);
  const collector = JSON.parse(collectorPrep.stdout);
  const collectorManifest = path.join(binDir, "codex-lifecycle-config.json");

  const config = [
    `model_provider = "relay"`,
    `model = ${JSON.stringify(options.model)}`,
    `model_reasoning_effort = ${JSON.stringify(options.effort)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    "",
    ...(arm.hook ? ["[features]", "hooks = true", ""] : []),
    "[model_providers.relay]",
    `name = "relay"`,
    `base_url = ${JSON.stringify(options.base_url)}`,
    `wire_api = "responses"`,
    `env_key = "RELAY_API_KEY"`,
    "",
    `[projects.${JSON.stringify(manifest.workspace)}]`,
    `trust_level = "trusted"`,
    "",
  ].join("\n");
  await writeFile(path.join(codexHome, "config.toml"), config, "utf8");

  // Identical across arms by construction. The digest goes in the run record so a later reader can prove
  // the two arms of a pair were asked the same thing, rather than take this comment's word for it.
  const prompt = manifest.instruction;
  const streamPath = path.join(runDir, "stream.ndjson");
  const codexArgs = ["exec", "--json", "--cd", manifest.workspace];
  // codex 0.149.0 silently skips hooks in a CODEX_HOME with no persisted hook trust, and reports nothing
  // about it. Without this flag the candidate arm runs as an unenforced baseline that looks enforced.
  if (arm.hook) codexArgs.push("--dangerously-bypass-hook-trust");
  codexArgs.push(prompt);

  log("agent", `codex exec (${options.model}, effort=${options.effort}, arm=${options.arm})`);
  const agent = await run(path.join(binDir, "codex"), codexArgs, {
    cwd: manifest.workspace,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CODEX_HOME: codexHome, RELAY_API_KEY: token },
    timeoutMs: Number(options.timeout_ms),
    stdoutFile: streamPath,
  });
  await writeFile(streamPath, agent.stdout, "utf8");
  await writeFile(path.join(runDir, "agent.err"), agent.stderr, "utf8");
  log("agent", `exit=${agent.code}${agent.timedOut ? " (timed out)" : ""}, stream bytes=${agent.stdout.length}`);
  if (agent.stdout.length === 0) throw new Error(`Agent produced no stream output; stderr: ${agent.stderr.trim().slice(0, 400)}`);
  // An agent that fails on its own is data. An agent we killed is a truncated observation of an agent that
  // had not finished deciding, and a trace built from it would understate its verification scope.
  if (agent.timedOut) throw new Error(`Agent was killed after ${options.timeout_ms}ms; this run is an environment failure, not evidence`);

  const lifecyclePath = await soleFile(lifecycleDir, ".ndjson");
  const lifecycle = ndjsonRecords(await readFile(lifecyclePath, "utf8"));
  const threadId = lifecycle.find((record) => record.event === "thread.started")?.thread_id ?? null;
  const shellCommands = lifecycle.filter((record) => record.event === "item.started" && record.item_type === "command_execution").length;
  log("collector", `lifecycle records=${lifecycle.length}, shell commands=${shellCommands}, thread=${threadId ?? "none"}`);

  // A ledger left behind by an earlier run passes both the missing-file and empty-file checks. The ledger
  // records sha256(session_id).slice(0, 16) unsalted, so if the lifecycle thread id is that same session
  // id the binding is decidable. Whether it is has not been observed yet -- this run is where that gets
  // answered, so the comparison is recorded either way rather than assumed.
  let ledgerBinding = null;
  if (arm.hook) {
    const ledgerContents = await readFile(ledgerPath, "utf8").catch(() => null);
    if (ledgerContents === null) throw new Error(`No policy ledger at ${ledgerPath}: the hook never fired, so this candidate run carries no enforcement`);
    const ledgerRecords = ndjsonRecords(ledgerContents);
    if (ledgerRecords.length === 0) throw new Error("Policy ledger is empty: the hook did not fire");
    const ledgerSessions = [...new Set(ledgerRecords.map((record) => record.session_id_sha256).filter(Boolean))];
    // Paired by tool_use_id rather than counted. The hook matches `Bash` only, so every executed command
    // must leave a PostToolUse record and every PostToolUse record must have a PreToolUse behind it -- a
    // command that ran without being gated is the failure this arm exists to rule out. Observed live: after
    // codex failed to create a unified exec process it re-ran the command through a path that fires no
    // hooks, and the rest of that session went unenforced while the trace still looked complete.
    //
    // The reverse direction is not a hole and must not be scored as one: a PreToolUse record with no
    // PostToolUse is a command that was gated and then never ran. Denials are the intended case, and two
    // harness behaviours produce the rest -- codex drops the sibling calls of a parallel batch when the hook
    // denies one of them (vp_unknown_impact_full_fallback: three approved commands in the batch carrying a
    // deny never executed), and it sometimes fails to create the exec process at all. Counting those as
    // missing enforcement rejected two arms whose every executed command was in fact gated.
    const preByTool = new Map();
    const postTools = new Set();
    for (const record of ledgerRecords) {
      if (record.event === "policy.pre_tool") preByTool.set(record.tool_use_id_sha256, record);
      if (record.event === "policy.post_tool") postTools.add(record.tool_use_id_sha256);
    }
    const preRecords = ledgerRecords.filter((record) => record.event === "policy.pre_tool").length;
    const postRecords = ledgerRecords.filter((record) => record.event === "policy.post_tool").length;
    const denials = ledgerRecords.filter((record) => record.decision === "deny").length;
    const ungatedExecutions = [...postTools].filter((tool) => !preByTool.has(tool)).length;
    const approvedNotExecuted = [...preByTool].filter(([tool, record]) => record.decision !== "deny" && !postTools.has(tool)).length;
    const coverage = {
      shell_commands: shellCommands,
      pre_tool_records: preRecords,
      post_tool_records: postRecords,
      denials,
      ungated_executions: ungatedExecutions,
      unobserved_executions: shellCommands - postRecords,
      approved_not_executed: approvedNotExecuted,
      complete: postRecords === shellCommands && ungatedExecutions === 0,
    };
    ledgerBinding = {
      ledger_records: ledgerRecords.length,
      ledger_session_id_sha256: ledgerSessions,
      lifecycle_thread_id_stable_id: threadId ? stableId(threadId) : null,
      thread_id_equals_hook_session_id: threadId !== null && ledgerSessions.length === 1 && ledgerSessions[0] === stableId(threadId),
      enforcement_coverage: coverage,
      decisions: ledgerRecords.reduce((counts, record) => {
        const key = `${record.decision ?? "unknown"}${record.reason_code ? `/${record.reason_code}` : ""}`;
        return { ...counts, [key]: (counts[key] ?? 0) + 1 };
      }, {}),
    };
    log("ledger", `${ledgerRecords.length} decisions, bound_to_run=${ledgerBinding.thread_id_equals_hook_session_id}, coverage_complete=${coverage.complete}`);
    log("ledger", JSON.stringify(ledgerBinding.decisions));
    if (coverage.approved_not_executed > 0) {
      log("ledger", `${coverage.approved_not_executed} gated command(s) never executed (${denials} denial(s) in session, ${(agent.stderr.match(/unified exec process/g) ?? []).length} unified-exec failure(s))`);
    }
    if (!coverage.complete) {
      log("ledger", `INCOMPLETE ENFORCEMENT: ${coverage.unobserved_executions} of ${shellCommands} executed command(s) left no PostToolUse record, ${coverage.ungated_executions} ran without a PreToolUse record`);
    }
  }

  log("oracle", "running hidden oracle in a copy of the workspace");
  const oraclePath = path.join(runDir, "oracle.json");
  const oracle = await run(process.execPath, [
    "src/verification-policy-oracle-cli.mjs",
    "--plan", PLAN,
    "--oracles", ORACLES,
    "--repo", ".",
    "--task-manifest", manifestPath,
    "--output", oraclePath,
  ]);
  log("oracle", `exit=${oracle.code} ${oracle.stdout.trim() || oracle.stderr.trim()}`);

  log("trace", `building ${arm.mode} trace`);
  const runId = `${options.arm}-${options.task.replaceAll("_", "-")}`;
  const tracePath = path.join(runDir, "trace.json");
  const trace = await buildTrace({
    manifestPath,
    streamPath,
    lifecyclePath,
    collectorManifest,
    ledgerPath,
    runId,
    harness: HARNESS,
    model: options.model,
    mode: arm.mode,
    policyName: arm.policy_name,
    policyVersion,
    tracePath,
  });
  log("trace", `exit=${trace.code} ${trace.stdout.trim() || trace.stderr.trim()}`);

  const record = {
    schema_version: 1,
    task_id: options.task,
    arm: options.arm,
    mode: arm.mode,
    policy: { name: arm.policy_name, version: policyVersion },
    harness: HARNESS,
    model: options.model,
    model_reasoning_effort: options.effort,
    prompt_sha256: sha256(prompt),
    workspace: manifest.workspace,
    workspace_revision: manifest.workspace_revision,
    scenario_definition_sha256: manifest.scenario_definition_sha256,
    collector_sha256: collector.collector_sha256,
    agent: {
      exit_code: agent.code,
      timed_out: agent.timedOut,
      shell_commands: shellCommands,
      thread_id: threadId,
      // The harness fault that silences hooks mid-session. Counted so a later reader can tell an
      // unenforced stretch from an agent that simply never asked for anything the policy rejects.
      unified_exec_failures: (agent.stderr.match(/unified exec process/g) ?? []).length,
    },
    ledger: ledgerBinding,
    oracle: { exit_code: oracle.code, report: oraclePath, stdout: oracle.stdout.trim() },
    trace: { exit_code: trace.code, report: tracePath, stdout: trace.stdout.trim(), stderr: trace.stderr.trim() },
    paths: { manifest: manifestPath, stream: streamPath, lifecycle: lifecyclePath, collector: collectorManifest, ledger: ledgerPath },
  };
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const enforcementComplete = ledgerBinding?.enforcement_coverage.complete ?? null;
  process.stdout.write(`${JSON.stringify({ run: path.join(runDir, "run.json"), oracle_exit: oracle.code, trace_exit: trace.code, enforcement_complete: enforcementComplete })}\n`);
  if (oracle.code !== 0 || trace.code !== 0 || enforcementComplete === false) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
