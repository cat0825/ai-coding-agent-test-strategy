import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTestRunnerCommand, decomposeShellCommand } from "./test-command.mjs";

const DEFAULT_BUDGET = Object.freeze({
  max_test_executions: 2,
  max_immediate_duration_ms: 90_000,
  max_verification_turns: 2,
  max_failed_test_turns: 2,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(value) {
  return typeof value === "string" && value ? sha256(value).slice(0, 16) : "unknown";
}

function commandFromPayload(payload) {
  const input = payload?.tool_input;
  if (input && typeof input === "object") {
    for (const field of ["command", "cmd", "bash"]) {
      if (typeof input[field] === "string" && input[field].trim()) return input[field];
    }
  }
  return "";
}

function durationFromPayload(payload) {
  for (const candidate of [
    payload?.duration_ms,
    payload?.tool_response?.duration_ms,
    payload?.tool_result?.duration_ms,
  ]) {
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

// The summary line a test runner prints itself, at the end of its own run. Read only these: they are
// emitted by the runner, not by the agent, so they are evidence in the same sense the exit code is.
// Anything looser — the word "error" appearing somewhere in the output, a passing count with no
// failing count beside it — would be a guess dressed as an observation, and `unknown` is the honest
// answer instead.
const RUNNER_FAILURE_TOTALS = [
  /^\s*(?:ℹ\s*)?fail(?:ed|ures)?[\s:]+(\d+)\s*$/im, // node --test, and TAP-ish summaries
  /^\s*Tests:.*?(\d+) failed/im, // jest / vitest
];

function outcomeFromRunnerOutput(text) {
  for (const pattern of RUNNER_FAILURE_TOTALS) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]) === 0 ? "passed" : "failed";
  }
  return "unknown";
}

function outcomeFromPayload(payload) {
  const response = payload?.tool_response ?? payload?.tool_result;
  const status = response?.status ?? payload?.status;
  const exitCode = response?.exit_code ?? payload?.exit_code;
  if (Number.isInteger(exitCode)) return exitCode === 0 ? "passed" : "failed";
  if (status === "completed" || status === "success") return "passed";
  if (status === "failed" || status === "error") return "failed";
  // codex 0.149.0 sends `tool_response` as the raw combined output string, with no exit code and no
  // status anywhere in the payload. Without this arm every live run is recorded `unknown`, which
  // silently disables both the failed-turn budget and the repeat-after-pass check.
  const text = typeof response === "string" ? response : typeof response?.output === "string" ? response.output : null;
  return text ? outcomeFromRunnerOutput(text) : "unknown";
}

function policyBudget(config) {
  return {
    max_test_executions: config?.budget?.max_test_executions ?? DEFAULT_BUDGET.max_test_executions,
    max_immediate_duration_ms: config?.budget?.max_immediate_duration_ms ?? DEFAULT_BUDGET.max_immediate_duration_ms,
    max_verification_turns: config?.budget?.max_verification_turns ?? DEFAULT_BUDGET.max_verification_turns,
    max_failed_test_turns: config?.budget?.max_failed_test_turns ?? DEFAULT_BUDGET.max_failed_test_turns,
  };
}

function quoteArgv(argv) {
  return argv.map((part) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(part)
    ? part
    : `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}

function analyzeConfiguredCommand(argv, cwdSha256) {
  if (!Array.isArray(argv) || argv.some((part) => typeof part !== "string")) return null;
  return analyzeTestRunnerCommand(quoteArgv(argv), { cwdSha256 });
}

function configuredTiers(config, cwdSha256) {
  const result = {};
  for (const tier of ["fast", "affected", "full"]) {
    const analysis = analyzeConfiguredCommand(config?.commands?.[tier], cwdSha256);
    result[tier] = analysis?.semantics.complete === true ? analysis : null;
  }
  return result;
}

function tierIdentity(analysis) {
  if (!analysis?.command || analysis.semantics?.arguments_sha256 == null) return null;
  return JSON.stringify({ command: analysis.command, arguments_sha256: analysis.semantics.arguments_sha256 });
}

function tierForAnalysis(analysis, tiers) {
  const identity = tierIdentity(analysis);
  if (!identity) return "other";
  for (const tier of ["fast", "affected", "full"]) {
    if (tierIdentity(tiers[tier]) === identity) return tier;
  }
  return "other";
}

function freshSessionState() {
  return {
    test_executions: 0,
    immediate_duration_ms: 0,
    test_turns: [],
    failed_test_turns: [],
    pending: {},
    completed: [],
  };
}

function freshState() {
  return { schema_version: 2, sessions: {} };
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (parsed?.schema_version === 1) {
      return {
        schema_version: 2,
        sessions: {
          unknown: {
            test_executions: parsed.test_executions ?? 0,
            immediate_duration_ms: parsed.immediate_duration_ms ?? 0,
            test_turns: parsed.turns ?? [],
            failed_test_turns: [],
            pending: parsed.pending ?? {},
            completed: parsed.completed ?? [],
          },
        },
      };
    }
    if (parsed?.schema_version !== 2 || !parsed.sessions || typeof parsed.sessions !== "object") {
      throw new Error("Policy state schema_version must be 2");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return freshState();
    throw error;
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, statePath);
}

function decisionRecord({ payload, config, analysis, decision, reasonCode, tier, session, rewrite = null }) {
  return {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    event: payload.hook_event_name === "PostToolUse" ? "policy.post_tool" : "policy.pre_tool",
    policy: {
      name: config.policy?.name ?? "observatory-verification-policy",
      version: config.policy?.version ?? "0.1",
    },
    session_id_sha256: stableId(payload.session_id),
    turn_id_sha256: stableId(payload.turn_id),
    tool_use_id_sha256: stableId(payload.tool_use_id),
    decision,
    reason_code: reasonCode,
    tier,
    canonical_command_id: analysis?.canonicalId ?? null,
    command_semantic_sha256: analysis?.semantics?.semantic_sha256 ?? null,
    // What the agent asked for stays in the fields above; what the hook substituted, or why it
    // declined to substitute anything, stays here. The raw command text is never recorded — a
    // digest and the canonical id are enough to compare runs without transcribing the workspace.
    rewrite,
    budget: {
      test_executions: session.test_executions,
      immediate_duration_ms: session.immediate_duration_ms,
      agent_turns: session.test_turns.length,
      failed_test_turns: session.failed_test_turns.length,
    },
  };
}

async function appendDecision(ledgerPath, record) {
  if (!ledgerPath) return;
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const previous = await readFile(ledgerPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  await writeFile(ledgerPath, `${previous}${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function withStateLock(statePath, callback) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw new Error("Timed out waiting for verification policy state lock");
  try {
    return await callback();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function publicSuggestion(config) {
  const command = config?.commands?.affected ?? config?.commands?.fast;
  return Array.isArray(command) ? command : null;
}

function relativeTarget(target) {
  return target.startsWith("./") ? target.slice(2) : target;
}

// An explicit list of every test file is the full suite spelled out one file at a time.
// The list is bounded, so it clears the glob check, but it selects exactly the set the
// full-suite deny exists to refuse.
function coversFullSuite(config, analysis) {
  const declared = config?.full_suite_test_files;
  if (!Array.isArray(declared) || declared.length === 0) return false;
  const selected = new Set((analysis.selection?.targets ?? []).map(relativeTarget));
  if (selected.size === 0) return false;
  return declared.every((file) => selected.has(relativeTarget(file)));
}

// The three reasons that reject a call for testing too much rather than for spending too much.
// Only these are candidates for a rewrite: the agent wants to verify, it just aimed too wide.
const WIDE_SCOPE_REASONS = new Set([
  "untargeted_full_suite_denied",
  "unbounded_test_selection_denied",
  "full_suite_equivalent_selection_denied",
]);

// The narrower command the hook may substitute for a too-wide one. Derived only from the tier the
// task itself declared, never synthesized from the command under evaluation: a fabricated target
// would still look like verification in the transcript while actually testing something else, which
// is the failure this whole policy exists to detect.
function deriveRewrite({ config, tiers, command }) {
  if (!tiers.affected) return { command: null, declined: "affected_tier_not_declared" };
  if (tierIdentity(tiers.affected) === tierIdentity(tiers.full)) {
    return { command: null, declined: "affected_tier_equals_full_suite" };
  }
  const argv = config?.commands?.affected;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string")) {
    return { command: null, declined: "affected_tier_not_declared" };
  }
  // A rewrite replaces the entire command string, so rewriting `npm run lint && npm test` would
  // silently drop the lint. Refusing here keeps the rewrite a narrowing of the test scope and
  // nothing else; the agent is denied and can reissue the two calls separately.
  const segments = decomposeShellCommand(command);
  if (!Array.isArray(segments)) return { command: null, declined: "shell_structure_unrecognized" };
  if (segments.length !== 1) return { command: null, declined: "compound_command_not_rewritable" };
  return { command: quoteArgv(argv), declined: null, analysis: tiers.affected };
}

// Budget is checked against a specific canonical command so a proposed rewrite can be tested
// against the same limits before it is offered. A rewrite is still an execution.
function budgetReason({ session, budget, isNewVerificationTurn, canonicalId }) {
  if (session.failed_test_turns.length >= budget.max_failed_test_turns) return "failed_test_turn_budget_exceeded";
  if (isNewVerificationTurn && session.test_turns.length >= budget.max_verification_turns) return "agent_turn_budget_exceeded";
  if (session.test_executions >= budget.max_test_executions) return "test_execution_budget_exceeded";
  if (session.immediate_duration_ms >= budget.max_immediate_duration_ms) return "immediate_duration_budget_exceeded";
  const previous = [...session.completed].reverse().find((entry) => entry.canonical_command_id === canonicalId);
  return previous?.outcome === "passed" ? "repeat_after_pass_denied" : null;
}

async function evaluateLocked({ payload, config, statePath, ledgerPath, nowMs = Date.now }) {
  if (!payload || typeof payload !== "object") throw new Error("Hook payload must be an object");
  if (!config || config.schema_version !== 1) throw new Error("Policy config schema_version must be 1");
  const state = await readState(statePath);
  const sessionId = stableId(payload.session_id);
  const session = state.sessions[sessionId] ?? freshSessionState();
  state.sessions[sessionId] = session;
  const turnId = stableId(payload.turn_id);
  const command = commandFromPayload(payload);
  const cwdSha256 = sha256(typeof payload.cwd === "string" ? payload.cwd : "unknown");
  const analysis = command ? analyzeTestRunnerCommand(command, { cwdSha256 }) : null;
  const tiers = configuredTiers(config, cwdSha256);
  const tier = analysis ? tierForAnalysis(analysis, tiers) : "non_test";
  const budget = policyBudget(config);

  if (payload.hook_event_name === "PostToolUse") {
    const toolUseId = stableId(payload.tool_use_id);
    const pending = session.pending[toolUseId];
    // The pending record wins over the payload. For an ordinary allow the two agree, but for a
    // rewritten call the payload still describes what the agent asked for while the pending record
    // describes what the hook substituted and what therefore actually ran.
    const observedAnalysis = pending ? {
      canonicalId: pending.canonical_command_id,
      semantics: { semantic_sha256: pending.command_semantic_sha256 },
    } : analysis;
    const observedTier = pending?.tier ?? tier;
    if (pending) {
      const explicitDuration = durationFromPayload(payload);
      const observedDuration = explicitDuration ?? (Number.isFinite(pending.started_at_ms)
        ? Math.max(0, nowMs() - pending.started_at_ms)
        : 0);
      session.immediate_duration_ms += observedDuration;
      const outcome = outcomeFromPayload(payload);
      session.completed.push({
        canonical_command_id: pending.canonical_command_id,
        outcome,
        turn_id_sha256: turnId,
      });
      if (outcome === "failed" && !session.failed_test_turns.includes(pending.turn_id_sha256)) {
        session.failed_test_turns.push(pending.turn_id_sha256);
      }
      delete session.pending[toolUseId];
    }
    const record = decisionRecord({
      payload,
      config,
      analysis: observedAnalysis,
      decision: "observe",
      reasonCode: pending ? "test_execution_observed" : "non_test_tool_observed",
      tier: observedTier,
      session,
    });
    await writeState(statePath, state);
    await appendDecision(ledgerPath, record);
    return { decision: "allow", record };
  }

  if (!analysis) {
    const record = decisionRecord({ payload, config, analysis, decision: "allow", reasonCode: "non_test_command", tier, session });
    await writeState(statePath, state);
    await appendDecision(ledgerPath, record);
    return { decision: "allow", record };
  }

  let reasonCode = null;
  let suggestion = null;
  const isNewVerificationTurn = !session.test_turns.includes(turnId);
  const fullSuiteAllowed = config.allow_full_suite === true;
  if (analysis.semantics.complete !== true) {
    reasonCode = `command_semantics_incomplete:${analysis.semantics.reason}`;
  } else if (tier === "full" && !fullSuiteAllowed
    && tiers.affected && tierIdentity(tiers.affected) !== tierIdentity(tiers.full)) {
    reasonCode = "untargeted_full_suite_denied";
    suggestion = publicSuggestion(config);
  } else if (tier === "full" && !fullSuiteAllowed && !tiers.affected) {
    // Fail closed. With no usable affected tier the hook can neither show this run is necessary
    // nor narrow it, so the one thing it must not do is wave the full suite through as if the
    // absence of evidence were evidence of need. `allow_full_suite: true` is the explicit opt-in,
    // and it is how the full_fallback tasks legitimately run the whole suite.
    reasonCode = "full_suite_scope_undeterminable_denied";
  } else if (tier === "other" && !fullSuiteAllowed && analysis.selection?.bounded === false) {
    // A glob target expands to an unknown set of test files, so it cannot be shown to be
    // narrower than the denied full suite. Observed as a real escape from the full-suite
    // deny: `node --test test/*.test.mjs` after `npm test` was blocked.
    reasonCode = "unbounded_test_selection_denied";
    suggestion = publicSuggestion(config);
  } else if (tier === "other" && !fullSuiteAllowed && coversFullSuite(config, analysis)) {
    // Observed as a real escape from the full-suite deny: after `npm test` was blocked the
    // agent ran `node --test` over all nine test files it found, naming each one, and the
    // bounded-selection check allowed it as an ordinary narrow run.
    reasonCode = "full_suite_equivalent_selection_denied";
    suggestion = publicSuggestion(config);
  } else {
    reasonCode = budgetReason({ session, budget, isNewVerificationTurn, canonicalId: analysis.canonicalId });
  }

  // L2. A call rejected for aiming too wide is rewritten to the declared affected tier instead of
  // blocked, so the agent keeps verifying rather than losing the turn. Every other rejection stays
  // a denial: the problem there is not the target.
  let rewrite = null;
  let rewriteCommand = null;
  if (reasonCode && WIDE_SCOPE_REASONS.has(reasonCode)) {
    const candidate = deriveRewrite({ config, tiers, command });
    if (!candidate.command) {
      rewrite = { applied: false, declined_reason: candidate.declined, from_reason_code: reasonCode };
    } else {
      const blocked = budgetReason({ session, budget, isNewVerificationTurn, canonicalId: candidate.analysis.canonicalId });
      if (blocked) {
        // The narrower command breaks the same budget, so substituting it would only move the
        // denial one turn later. Keep the scope reason and stop advertising a command the agent
        // cannot run either.
        rewrite = { applied: false, declined_reason: `budget_would_be_exceeded:${blocked}`, from_reason_code: reasonCode };
        suggestion = null;
      } else {
        rewriteCommand = candidate.command;
        rewrite = {
          applied: true,
          to_tier: "affected",
          canonical_command_id: candidate.analysis.canonicalId,
          command_sha256: sha256(candidate.command),
          from_reason_code: reasonCode,
        };
        reasonCode = `${reasonCode.slice(0, -"_denied".length)}_rewritten`;
      }
    }
  }

  if (rewrite?.applied) {
    // The substituted command is the one that will actually run, so it is the one the budget and
    // the repeat check must account for from here on.
    if (isNewVerificationTurn) session.test_turns.push(turnId);
    session.test_executions += 1;
    session.pending[stableId(payload.tool_use_id)] = {
      canonical_command_id: tiers.affected.canonicalId,
      command_semantic_sha256: tiers.affected.semantics.semantic_sha256,
      tier: "affected",
      turn_id_sha256: turnId,
      started_at_ms: nowMs(),
    };
    const record = decisionRecord({ payload, config, analysis, decision: "rewrite", reasonCode, tier, session, rewrite });
    await writeState(statePath, state);
    await appendDecision(ledgerPath, record);
    return { decision: "rewrite", reason: reasonCode, command: rewriteCommand, record };
  }

  if (reasonCode) {
    const record = decisionRecord({ payload, config, analysis, decision: "deny", reasonCode, tier, session, rewrite });
    await writeState(statePath, state);
    await appendDecision(ledgerPath, record);
    return { decision: "deny", reason: reasonCode, suggestion, record };
  }

  if (isNewVerificationTurn) session.test_turns.push(turnId);
  session.test_executions += 1;
  session.pending[stableId(payload.tool_use_id)] = {
    canonical_command_id: analysis.canonicalId,
    command_semantic_sha256: analysis.semantics.semantic_sha256,
    tier,
    turn_id_sha256: turnId,
    started_at_ms: nowMs(),
  };
  const record = decisionRecord({ payload, config, analysis, decision: "allow", reasonCode: "within_budget", tier, session });
  await writeState(statePath, state);
  await appendDecision(ledgerPath, record);
  return { decision: "allow", record };
}

export async function evaluateVerificationPolicyHook(options) {
  if (!options?.statePath) throw new Error("statePath is required");
  return withStateLock(options.statePath, () => evaluateLocked(options));
}

export function codexHookResponse(result) {
  // A rewrite is delivered as an allow that carries replacement input. codex enforces two things
  // the wire schema does not spell out, and rejects the whole hook response rather than ignoring
  // the field when either is missing: `updatedInput` is only read alongside
  // `permissionDecision: "allow"`, and it must be an object with a string `command`.
  if (result.decision === "rewrite" && typeof result.command === "string" && result.command) {
    const reason = `${result.reason}. Narrowed to the affected tier: ${result.command}.`;
    return {
      systemMessage: reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
        updatedInput: { command: result.command },
      },
    };
  }
  if (result.decision !== "deny") return {};
  const guidance = result.suggestion ? ` Use the narrower command: ${result.suggestion.join(" ")}.` : "";
  const reason = `${result.reason}.${guidance}`;
  return {
    decision: "block",
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
