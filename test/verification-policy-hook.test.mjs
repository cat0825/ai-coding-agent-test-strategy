import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexHookResponse, evaluateVerificationPolicyHook } from "../src/verification-policy-hook.mjs";

const config = {
  schema_version: 1,
  policy: { name: "observatory-verification-policy", version: "0.1" },
  commands: {
    fast: ["node", "--test", "test/feature.test.mjs"],
    affected: ["node", "--test", "test/feature.test.mjs", "test/api.test.mjs"],
    full: ["npm", "test"],
  },
  budget: {
    max_test_executions: 2,
    max_immediate_duration_ms: 90_000,
    max_verification_turns: 2,
    max_failed_test_turns: 2,
  },
};

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verification-policy-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "policy.json");
  const statePath = path.join(directory, "state.json");
  const ledgerPath = path.join(directory, "decisions.ndjson");
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  return { statePath, ledgerPath };
}

function payload(command, overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: "/private/workspace",
    session_id: "session-secret",
    turn_id: overrides.turn_id ?? "turn-1",
    tool_use_id: overrides.tool_use_id ?? "tool-1",
    ...overrides,
  };
}

test("non-test commands are allowed and produce sanitized evidence", async (t) => {
  const paths = await harness(t);
  const result = await evaluateVerificationPolicyHook({
    payload: payload("git status", { tool_use_id: "tool-non-test" }),
    config,
    ...paths,
  });

  assert.equal(result.decision, "allow");
  const ledger = await readFile(paths.ledgerPath, "utf8");
  assert.doesNotMatch(ledger, /git status|private\/workspace|session-secret/);
  assert.match(ledger, /non_test_command/);
});

test("a targeted test is allowed and post-use updates duration state", async (t) => {
  const paths = await harness(t);
  const pre = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    ...paths,
  });
  assert.equal(pre.decision, "allow");
  assert.equal(pre.record.reason_code, "within_budget");

  const post = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: { exit_code: 0, duration_ms: 1250, status: "completed" },
    }),
    config,
    ...paths,
  });
  assert.equal(post.decision, "allow");
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  const session = Object.values(state.sessions)[0];
  assert.equal(session.test_executions, 1);
  assert.equal(session.immediate_duration_ms, 1250);
});

test("post-use falls back to elapsed wall time when Codex omits duration", async (t) => {
  const paths = await harness(t);
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    nowMs: () => 1_000,
    ...paths,
  });
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: { exit_code: 0, status: "completed" },
    }),
    config,
    nowMs: () => 2_750,
    ...paths,
  });

  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(Object.values(state.sessions)[0].immediate_duration_ms, 1750);
});

test("post-use preserves test identity when Codex omits tool input", async (t) => {
  const paths = await harness(t);
  const pre = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    ...paths,
  });
  const post = await evaluateVerificationPolicyHook({
    payload: payload("", {
      hook_event_name: "PostToolUse",
      tool_input: {},
      tool_response: { exit_code: 0, duration_ms: 10, status: "completed" },
    }),
    config,
    ...paths,
  });

  assert.equal(post.record.tier, "fast");
  assert.equal(post.record.canonical_command_id, pre.record.canonical_command_id);
  assert.equal(post.record.command_semantic_sha256, pre.record.command_semantic_sha256);
});

test("a repeated passing test is denied with a machine-readable reason", async (t) => {
  const paths = await harness(t);
  await evaluateVerificationPolicyHook({ payload: payload("node --test test/feature.test.mjs"), config, ...paths });
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: { exit_code: 0, duration_ms: 10, status: "completed" },
    }),
    config,
    ...paths,
  });
  const denied = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", { tool_use_id: "tool-2", turn_id: "turn-2" }),
    config,
    ...paths,
  });

  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "repeat_after_pass_denied");
  assert.equal(codexHookResponse(denied).hookSpecificOutput.permissionDecision, "deny");
  assert.match(codexHookResponse(denied).hookSpecificOutput.permissionDecisionReason, /repeat_after_pass_denied/);
});

test("two failed verification turns stop further test expansion", async (t) => {
  const paths = await harness(t);
  const failureConfig = {
    ...config,
    budget: { ...config.budget, max_test_executions: 5, max_verification_turns: 5 },
  };
  for (const [index, command] of [
    "node --test test/feature.test.mjs",
    "node --test test/feature.test.mjs test/api.test.mjs",
  ].entries()) {
    const ids = { turn_id: `turn-${index + 1}`, tool_use_id: `tool-${index + 1}` };
    await evaluateVerificationPolicyHook({ payload: payload(command, ids), config: failureConfig, ...paths });
    await evaluateVerificationPolicyHook({
      payload: payload(command, {
        ...ids,
        hook_event_name: "PostToolUse",
        tool_response: { exit_code: 1, duration_ms: 10, status: "failed" },
      }),
      config: failureConfig,
      ...paths,
    });
  }

  const denied = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/other.test.mjs", { turn_id: "turn-3", tool_use_id: "tool-3" }),
    config: failureConfig,
    ...paths,
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "failed_test_turn_budget_exceeded");
});

test("verification turn budgets and execution budgets are session-local", async (t) => {
  const paths = await harness(t);
  const turnConfig = {
    ...config,
    budget: {
      ...config.budget,
      max_test_executions: 5,
      max_verification_turns: 1,
      max_failed_test_turns: 5,
    },
  };
  const first = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", { session_id: "session-a" }),
    config: turnConfig,
    ...paths,
  });
  const denied = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs test/api.test.mjs", {
      session_id: "session-a",
      turn_id: "turn-2",
      tool_use_id: "tool-2",
    }),
    config: turnConfig,
    ...paths,
  });
  const separateSession = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      session_id: "session-b",
      turn_id: "turn-2",
      tool_use_id: "tool-3",
    }),
    config: turnConfig,
    ...paths,
  });

  assert.equal(first.decision, "allow");
  assert.equal(denied.reason, "agent_turn_budget_exceeded");
  assert.equal(separateSession.decision, "allow");
});

test("nested and ambiguous runners fail closed", async (t) => {
  const paths = await harness(t);
  const nested = await evaluateVerificationPolicyHook({
    payload: payload("echo $(npm test)"),
    config,
    ...paths,
  });
  assert.equal(nested.decision, "deny");
  assert.equal(nested.reason, "command_semantics_incomplete:nested_runner_structure_unrecognized");

  const ambiguous = await evaluateVerificationPolicyHook({
    payload: payload("npm test && node --test", { tool_use_id: "tool-2" }),
    config,
    ...paths,
  });
  assert.equal(ambiguous.decision, "deny");
  assert.equal(ambiguous.reason, "command_semantics_incomplete:multiple_runner_commands");
});

test("full-suite calls are denied when an affected command is available", async (t) => {
  const paths = await harness(t);
  const result = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config,
    ...paths,
  });

  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "untargeted_full_suite_denied");
  assert.deepEqual(result.suggestion, config.commands.affected);
  const ledger = await readFile(paths.ledgerPath, "utf8");
  assert.doesNotMatch(ledger, /node|test\/feature|npm test/);
});

test("full-suite calls stay denied when wrapped in cd and pipelines", async (t) => {
  const paths = await harness(t);
  const wrapped = await evaluateVerificationPolicyHook({
    payload: payload("cd /private/workspace/repo && npm test 2>&1 | tail -60"),
    config,
    ...paths,
  });

  assert.equal(wrapped.decision, "deny");
  assert.equal(wrapped.reason, "untargeted_full_suite_denied");
  assert.equal(wrapped.record.tier, "full");
  assert.deepEqual(wrapped.suggestion, config.commands.affected);

  const targeted = await evaluateVerificationPolicyHook({
    payload: payload("cd /private/workspace/repo && node --test test/feature.test.mjs", { tool_use_id: "tool-targeted" }),
    config,
    ...paths,
  });

  assert.equal(targeted.decision, "allow");
  assert.equal(targeted.record.tier, "fast");
});

test("full-suite fallback is allowed only when the task policy grants the exception", async (t) => {
  const paths = await harness(t);
  const fallbackConfig = { ...config, allow_full_suite: true };
  const result = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config: fallbackConfig,
    ...paths,
  });

  assert.equal(result.decision, "allow");
  assert.equal(result.record.reason_code, "within_budget");
});

test("prepare CLI carries the full-fallback exception into generated policy", async (t) => {
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-hook-prepare-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const plan = "fixtures/benchmark/verification-policy-pilot-plan.json";
  const repo = path.resolve(".");
  const prepare = (taskId) => JSON.parse(execFileSync(process.execPath, [
    "src/verification-task-cli.mjs",
    "--plan", plan,
    "--task", taskId,
    "--repo", repo,
    "--output-parent", outputParent,
  ], { cwd: repo, encoding: "utf8" }));

  const fallbackManifest = prepare("vp_unknown_impact_full_fallback");
  const fallbackManifestPath = path.join(outputParent, "fallback-task.json");
  await writeFile(fallbackManifestPath, `${JSON.stringify(fallbackManifest)}\n`);
  const fallbackDir = path.join(outputParent, "fallback-hook");
  execFileSync(process.execPath, [
    "src/prepare-verification-policy-hook.mjs",
    "--plan", plan,
    "--task-manifest", fallbackManifestPath,
    "--output-dir", fallbackDir,
  ], { cwd: repo, encoding: "utf8" });
  const fallbackPolicy = JSON.parse(await readFile(path.join(fallbackDir, "verification-policy.json"), "utf8"));
  assert.equal(fallbackPolicy.behavior_class, "full_fallback");
  assert.equal(fallbackPolicy.allow_full_suite, true);
  assert.equal(fallbackPolicy.budget.max_test_executions, 3);
  assert.equal(fallbackPolicy.budget.max_verification_turns, 3);

  const ordinaryManifest = prepare("vp_local_correct_stop");
  const ordinaryManifestPath = path.join(outputParent, "ordinary-task.json");
  await writeFile(ordinaryManifestPath, `${JSON.stringify(ordinaryManifest)}\n`);
  const ordinaryDir = path.join(outputParent, "ordinary-hook");
  execFileSync(process.execPath, [
    "src/prepare-verification-policy-hook.mjs",
    "--plan", plan,
    "--task-manifest", ordinaryManifestPath,
    "--output-dir", ordinaryDir,
  ], { cwd: repo, encoding: "utf8" });
  const ordinaryPolicy = JSON.parse(await readFile(path.join(ordinaryDir, "verification-policy.json"), "utf8"));
  const ordinaryHooks = JSON.parse(await readFile(path.join(ordinaryDir, "hooks.json"), "utf8"));
  assert.equal(ordinaryPolicy.behavior_class, "local_pass");
  assert.equal(ordinaryPolicy.allow_full_suite, false);
  assert.equal(ordinaryPolicy.budget.max_test_executions, 2);
  const generatedCommand = ordinaryHooks.hooks.PreToolUse[0].hooks[0].command;
  const generatedResult = spawnSync(generatedCommand, {
    shell: true,
    input: JSON.stringify(payload("npm test")),
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(generatedResult.status, 0);
  assert.equal(JSON.parse(generatedResult.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("generated hook denies an untargeted full suite with Codex-compatible output", async (t) => {
  const paths = await harness(t);
  const hook = path.resolve("scripts/verification-policy-hook.mjs");
  const input = JSON.stringify(payload("npm test"));
  const result = spawnSync(process.execPath, [
    hook,
    "--config", path.join(path.dirname(paths.statePath), "policy.json"),
    "--state", paths.statePath,
    "--ledger", paths.ledgerPath,
  ], { input, cwd: path.resolve("."), encoding: "utf8" });

  // codex-cli 0.147.0 discards a code-2 deny whose reason is on stdout, so the hook must
  // exit 0 and carry the denial in hookSpecificOutput.
  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.decision, "block");
  assert.equal(response.permissionDecision, undefined);
  assert.equal(response.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /untargeted_full_suite_denied/);
});
