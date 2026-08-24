import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("an untargeted full suite is narrowed to the affected tier instead of blocked", async (t) => {
  const paths = await harness(t);
  const result = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config,
    ...paths,
  });

  // The full suite still does not run. Replacing it rather than refusing it leaves the agent its
  // verification turn, which is the whole point of the rewrite tier.
  assert.equal(result.decision, "rewrite");
  assert.equal(result.reason, "untargeted_full_suite_rewritten");
  assert.equal(result.command, "node --test test/feature.test.mjs test/api.test.mjs");
  assert.equal(result.record.tier, "full");
  assert.deepEqual(result.record.rewrite, {
    applied: true,
    to_tier: "affected",
    canonical_command_id: result.record.rewrite.canonical_command_id,
    command_sha256: result.record.rewrite.command_sha256,
    from_reason_code: "untargeted_full_suite_denied",
  });
  // The record names what the agent asked for; the rewrite block names what it became. Neither
  // carries the command text, so the substituted target is identified only by digest.
  assert.match(result.record.rewrite.command_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(result.record.canonical_command_id, result.record.rewrite.canonical_command_id);
  const ledger = await readFile(paths.ledgerPath, "utf8");
  assert.doesNotMatch(ledger, /test\/feature|test\/api|npm test/);
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

test("glob-expanded selections cannot escape the full-suite deny", async (t) => {
  const paths = await harness(t);
  const narrowed = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config,
    ...paths,
  });
  assert.equal(narrowed.decision, "rewrite");
  assert.equal(narrowed.reason, "untargeted_full_suite_rewritten");

  const globbed = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/*.test.mjs 2>&1 | tail -40", { tool_use_id: "tool-glob" }),
    config,
    ...paths,
  });
  // A pipeline is not rewritable — substituting the whole command string would drop the `tail` the
  // agent asked for — so the escape is still refused rather than narrowed.
  assert.equal(globbed.decision, "deny");
  assert.equal(globbed.reason, "unbounded_test_selection_denied");
  assert.equal(globbed.record.tier, "other");
  assert.equal(globbed.record.rewrite.applied, false);
  assert.equal(globbed.record.rewrite.declined_reason, "compound_command_not_rewritable");
  assert.deepEqual(globbed.suggestion, config.commands.affected);

  const ledger = await readFile(paths.ledgerPath, "utf8");
  assert.doesNotMatch(ledger, /test\/\*|tail -40/);

  const fallback = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/*.test.mjs", { tool_use_id: "tool-glob-allowed" }),
    config: { ...config, allow_full_suite: true },
    ...paths,
  });
  assert.equal(fallback.decision, "allow");
});

test("an exhaustive file enumeration cannot escape the full-suite deny", async (t) => {
  // Observed in a real candidate run: after `npm test` was denied the agent named every
  // test file it had found instead of globbing, and the bounded check let it through.
  const enumerated = {
    ...config,
    full_suite_test_files: ["test/api.test.mjs", "test/feature.test.mjs", "test/trace.test.mjs"],
  };
  const paths = await harness(t);
  const denied = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs test/api.test.mjs test/trace.test.mjs 2>&1 | tail -40"),
    config: enumerated,
    ...paths,
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "full_suite_equivalent_selection_denied");
  assert.equal(denied.record.tier, "other");
  assert.deepEqual(denied.suggestion, config.commands.affected);

  const relative = await evaluateVerificationPolicyHook({
    payload: payload("node --test ./test/api.test.mjs ./test/feature.test.mjs ./test/trace.test.mjs", { tool_use_id: "tool-dot-slash" }),
    config: enumerated,
    ...paths,
  });
  // Same enumeration without the pipeline, so this one is rewritable and gets narrowed instead.
  // Either way it never runs as written, which is the property the check exists for.
  assert.equal(relative.decision, "rewrite");
  assert.equal(relative.reason, "full_suite_equivalent_selection_rewritten");
  assert.equal(relative.command, "node --test test/feature.test.mjs test/api.test.mjs");

  const ledger = await readFile(paths.ledgerPath, "utf8");
  assert.doesNotMatch(ledger, /trace\.test\.mjs|tail -40/);

  const narrower = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs test/trace.test.mjs", { tool_use_id: "tool-subset" }),
    config: enumerated,
    ...paths,
  });
  assert.equal(narrower.decision, "allow");

  // A fresh session, because the rewrite above already spent an execution against this one and the
  // question here is about the exception, not the budget.
  const fallback = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs test/api.test.mjs test/trace.test.mjs", { tool_use_id: "tool-enumerated-allowed" }),
    config: { ...enumerated, allow_full_suite: true },
    ...await harness(t),
  });
  assert.equal(fallback.decision, "allow");
});

test("generated policy pins the workspace test files and denies an exhaustive enumeration", async (t) => {
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-hook-enumeration-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const plan = "fixtures/benchmark/verification-policy-pilot-plan.json";
  const repo = path.resolve(".");
  const manifest = JSON.parse(execFileSync(process.execPath, [
    "src/verification-task-cli.mjs",
    "--plan", plan,
    "--task", "vp_public_behavior_test_required",
    "--repo", repo,
    "--output-parent", outputParent,
  ], { cwd: repo, encoding: "utf8" }));
  const manifestPath = path.join(outputParent, "task.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const hookDir = path.join(outputParent, "hook");
  execFileSync(process.execPath, [
    "src/prepare-verification-policy-hook.mjs",
    "--plan", plan,
    "--task-manifest", manifestPath,
    "--output-dir", hookDir,
  ], { cwd: repo, encoding: "utf8" });

  const policy = JSON.parse(await readFile(path.join(hookDir, "verification-policy.json"), "utf8"));
  assert.deepEqual(policy.commands.full, ["npm", "test"]);
  assert.equal(policy.full_suite_resolution, "expanded_from_workspace");
  const discovered = (await readdir(path.join(manifest.workspace, "test")))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
  assert.ok(discovered.length > 1);
  assert.deepEqual(policy.full_suite_test_files, discovered);

  const enumeration = `node --test ${policy.full_suite_test_files.join(" ")} 2>&1 | tail -40`;
  const generated = JSON.parse(await readFile(path.join(hookDir, "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  const result = spawnSync(generated, { shell: true, input: JSON.stringify(payload(enumeration)), cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /full_suite_equivalent_selection_denied/);
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
  const generatedResponse = JSON.parse(generatedResult.stdout);
  assert.equal(generatedResponse.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(generatedResponse.hookSpecificOutput.updatedInput, {
    command: `node --test ${ordinaryPolicy.commands.affected.slice(2).join(" ")}`,
  });
});

test("a rewrite reaches Codex as an allow that carries replacement input", async (t) => {
  const paths = await harness(t);
  const hook = path.resolve("scripts/verification-policy-hook.mjs");
  const input = JSON.stringify(payload("npm test"));
  const result = spawnSync(process.execPath, [
    hook,
    "--config", path.join(path.dirname(paths.statePath), "policy.json"),
    "--state", paths.statePath,
    "--ledger", paths.ledgerPath,
  ], { input, cwd: path.resolve("."), encoding: "utf8" });

  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout);
  // codex reads `updatedInput` only next to an explicit allow, and only as an object carrying a
  // string `command`. It rejects the entire hook response when either is missing rather than
  // ignoring the field, so both are asserted on the wire and not just in the return value.
  assert.equal(response.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(response.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(typeof response.hookSpecificOutput.updatedInput.command, "string");
  assert.equal(response.hookSpecificOutput.updatedInput.command, "node --test test/feature.test.mjs test/api.test.mjs");
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /untargeted_full_suite_rewritten/);
  // A block would strand the turn, and `decision` is the field codex checks first.
  assert.equal(response.decision, undefined);
  assert.deepEqual(Object.keys(response.hookSpecificOutput).sort(),
    ["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput"]);
});

test("generated hook denies a call it cannot narrow with Codex-compatible output", async (t) => {
  const paths = await harness(t);
  const hook = path.resolve("scripts/verification-policy-hook.mjs");
  // A pipeline around the full suite: the deny path, because rewriting it would drop the `tail`.
  const input = JSON.stringify(payload("npm test 2>&1 | tail -40"));
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
  assert.equal(response.hookSpecificOutput.updatedInput, undefined);
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /untargeted_full_suite_denied/);
});

test("a full suite is denied, not allowed, when the affected scope cannot be determined", async (t) => {
  // The gap this closes: the full-suite check used to require a usable affected tier, so a task
  // that declared none fell through to the budget checks and got its whole suite waved through.
  // Absence of evidence about the affected scope is not evidence that the full run is needed.
  const undeclared = { ...config, commands: { fast: config.commands.fast, full: config.commands.full } };
  const missing = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config: undeclared,
    ...await harness(t),
  });
  assert.equal(missing.decision, "deny");
  assert.equal(missing.reason, "full_suite_scope_undeterminable_denied");
  assert.equal(missing.suggestion, null);

  // An affected tier the analyzer cannot read is the same situation: no derivable narrower target.
  // The hook must not fall back to inventing one out of the command it was handed.
  const unreadable = { ...config, commands: { ...config.commands, affected: ["node", "scripts/custom-runner.mjs"] } };
  const opaque = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config: unreadable,
    ...await harness(t),
  });
  assert.equal(opaque.decision, "deny");
  assert.equal(opaque.reason, "full_suite_scope_undeterminable_denied");
  assert.equal(opaque.record.rewrite, null);

  // The exception is still the only way through, and it stays explicit.
  const granted = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config: { ...undeclared, allow_full_suite: true },
    ...await harness(t),
  });
  assert.equal(granted.decision, "allow");
});

test("no rewrite is offered when the narrower command would break the same budget", async (t) => {
  const paths = await harness(t);
  const tight = { ...config, budget: { ...config.budget, max_test_executions: 1 } };
  const first = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config: tight,
    ...paths,
  });
  assert.equal(first.decision, "allow");

  const denied = await evaluateVerificationPolicyHook({
    payload: payload("npm test", { tool_use_id: "tool-second", turn_id: "turn-2" }),
    config: tight,
    ...paths,
  });
  // Substituting the affected tier here would only move the denial one turn later, so the call is
  // refused on its own terms and the narrower command is not advertised either.
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "untargeted_full_suite_denied");
  assert.equal(denied.record.rewrite.applied, false);
  assert.equal(denied.record.rewrite.declined_reason, "budget_would_be_exceeded:test_execution_budget_exceeded");
  assert.equal(denied.suggestion, null);
});

test("a rewritten call is billed as the command that actually ran", async (t) => {
  const paths = await harness(t);
  const rewritten = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config,
    ...paths,
  });
  assert.equal(rewritten.decision, "rewrite");

  // codex may report either the original or the substituted input on the way out, so the hook
  // settles the question from its own pending record rather than from the payload.
  const observed = await evaluateVerificationPolicyHook({
    payload: payload("npm test", { hook_event_name: "PostToolUse", exit_code: 0, duration_ms: 400 }),
    config,
    ...paths,
  });
  assert.equal(observed.record.tier, "affected");
  assert.equal(observed.record.canonical_command_id, rewritten.record.rewrite.canonical_command_id);
  assert.notEqual(observed.record.canonical_command_id, rewritten.record.canonical_command_id);

  // The affected tier has now passed, so narrowing to it again would be a repeat. The second
  // full-suite call is therefore denied rather than rewritten a second time.
  const repeated = await evaluateVerificationPolicyHook({
    payload: payload("npm test", { tool_use_id: "tool-again", turn_id: "turn-2" }),
    config,
    ...paths,
  });
  assert.equal(repeated.decision, "deny");
  assert.equal(repeated.record.rewrite.declined_reason, "budget_would_be_exceeded:repeat_after_pass_denied");
});

test("a full suite the task itself calls affected is not rewritten", async (t) => {
  // When a task declares the affected tier to be the whole suite there is no narrowing to make,
  // and the run is targeted by that task's own definition rather than an unjustified escalation.
  const wholeSuiteIsAffected = { ...config, commands: { ...config.commands, affected: config.commands.full } };
  const result = await evaluateVerificationPolicyHook({
    payload: payload("npm test"),
    config: wholeSuiteIsAffected,
    ...await harness(t),
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.record.reason_code, "within_budget");
  assert.equal(result.record.tier, "affected");
  assert.equal(result.record.rewrite, null);
});

// codex 0.149.0 sends `tool_response` as the raw output string, with no exit code and no status.
// Every test above feeds an object with `exit_code`, a shape the live harness never produces, so the
// outcome path was green against a fixture and dead in production.
test("an outcome is derived from the runner's own summary when the payload carries no exit code", async (t) => {
  const paths = await harness(t);
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    ...paths,
  });
  const post = await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: "✔ works (1.2ms)\nℹ tests 13\nℹ pass 13\nℹ fail 0\nℹ duration_ms 3591\n",
    }),
    config,
    ...paths,
  });
  assert.equal(post.decision, "allow");
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  const [session] = Object.values(state.sessions);
  assert.equal(session.completed.at(-1).outcome, "passed");
  assert.deepEqual(session.failed_test_turns, []);
});

test("a failing runner summary is recorded as a failed turn, and unreadable output stays unknown", async (t) => {
  const failing = await harness(t);
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    ...failing,
  });
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: "✖ broke (1.2ms)\nℹ tests 13\nℹ pass 12\nℹ fail 1\n",
    }),
    config,
    ...failing,
  });
  const failedState = JSON.parse(await readFile(failing.statePath, "utf8"));
  const [failedSession] = Object.values(failedState.sessions);
  assert.equal(failedSession.completed.at(-1).outcome, "failed");
  assert.equal(failedSession.failed_test_turns.length, 1);

  // No total the runner printed itself, so there is nothing to read. `unknown` is the honest record:
  // a passing count with no failing count beside it does not establish that nothing failed.
  const opaque = await harness(t);
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs"),
    config,
    ...opaque,
  });
  await evaluateVerificationPolicyHook({
    payload: payload("node --test test/feature.test.mjs", {
      hook_event_name: "PostToolUse",
      tool_response: "running tests...\n13 passing\ndone\n",
    }),
    config,
    ...opaque,
  });
  const opaqueState = JSON.parse(await readFile(opaque.statePath, "utf8"));
  const [opaqueSession] = Object.values(opaqueState.sessions);
  assert.equal(opaqueSession.completed.at(-1).outcome, "unknown");
  assert.deepEqual(opaqueSession.failed_test_turns, []);
});

test("a project script that runs the suite cannot walk around the full-suite deny", async (t) => {
  const paths = await harness(t);
  // Observed live on vp_local_correct_stop: the agent never asked for the declared full tier at all.
  // It ran `npm run check`, which in that repo ends in `npm test`, and the hook allowed it as an
  // ordinary in-budget call because the empty target list read as a narrow selection.
  const script = await evaluateVerificationPolicyHook({
    payload: payload("npm run check", { tool_use_id: "tool-script" }),
    config,
    ...paths,
  });

  assert.equal(script.decision, "deny");
  assert.equal(script.reason, "unscoped_test_command_denied");
  assert.equal(script.record.tier, "other");
  assert.deepEqual(script.suggestion, config.commands.affected);
  // Not rewritten: `check` also runs syntax gates, and substituting the affected tier for the whole
  // invocation would drop them while still looking like a narrowed test run.
  assert.deepEqual(script.record.rewrite, {
    applied: false,
    declined_reason: "script_body_not_inspectable",
    from_reason_code: "unscoped_test_command_denied",
  });

  // The declared tiers still behave as before: `npm test` is the full tier and is narrowed, not denied.
  const declared = await evaluateVerificationPolicyHook({
    payload: payload("npm test", { tool_use_id: "tool-declared" }),
    config,
    ...paths,
  });
  assert.equal(declared.decision, "rewrite");
  assert.equal(declared.command, "node --test test/feature.test.mjs test/api.test.mjs");
});

test("an unscoped runner is denied but the full-fallback exception still permits it", async (t) => {
  const paths = await harness(t);
  // A bare runner names no files, so it cannot be shown to be narrower than the suite it would run.
  const bare = await evaluateVerificationPolicyHook({
    payload: payload("npx vitest", { tool_use_id: "tool-bare" }),
    config,
    ...paths,
  });
  assert.equal(bare.decision, "rewrite");
  assert.equal(bare.reason, "unscoped_test_command_rewritten");
  assert.equal(bare.record.tier, "other");

  const permitted = await evaluateVerificationPolicyHook({
    payload: payload("npm run check", { tool_use_id: "tool-permitted" }),
    config: { ...config, allow_full_suite: true },
    ...(await harness(t)),
  });
  assert.equal(permitted.decision, "allow");
  assert.equal(permitted.record.tier, "other");
});
