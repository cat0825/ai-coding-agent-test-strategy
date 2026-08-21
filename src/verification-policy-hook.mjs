import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTestRunnerCommand } from "./test-command.mjs";

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

function outcomeFromPayload(payload) {
  const status = payload?.tool_response?.status ?? payload?.tool_result?.status ?? payload?.status;
  const exitCode = payload?.tool_response?.exit_code ?? payload?.tool_result?.exit_code ?? payload?.exit_code;
  if (Number.isInteger(exitCode)) return exitCode === 0 ? "passed" : "failed";
  if (status === "completed" || status === "success") return "passed";
  if (status === "failed" || status === "error") return "failed";
  return "unknown";
}

function policyBudget(config) {
  return {
    max_test_executions: config?.budget?.max_test_executions ?? DEFAULT_BUDGET.max_test_executions,
    max_immediate_duration_ms: config?.budget?.max_immediate_duration_ms ?? DEFAULT_BUDGET.max_immediate_duration_ms,
    max_verification_turns: config?.budget?.max_verification_turns ?? DEFAULT_BUDGET.max_verification_turns,
    max_failed_test_turns: config?.budget?.max_failed_test_turns ?? DEFAULT_BUDGET.max_failed_test_turns,
  };
}

function analyzeConfiguredCommand(argv, cwdSha256) {
  if (!Array.isArray(argv) || argv.some((part) => typeof part !== "string")) return null;
  const command = argv.map((part) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(part)
    ? part
    : `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
  return analyzeTestRunnerCommand(command, { cwdSha256 });
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

function decisionRecord({ payload, config, analysis, decision, reasonCode, tier, session }) {
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
    const observedAnalysis = analysis ?? (pending ? {
      canonicalId: pending.canonical_command_id,
      semantics: { semantic_sha256: pending.command_semantic_sha256 },
    } : null);
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
  if (analysis.semantics.complete !== true) {
    reasonCode = `command_semantics_incomplete:${analysis.semantics.reason}`;
  } else if (tier === "full" && config.allow_full_suite !== true
    && tiers.affected && tierIdentity(tiers.affected) !== tierIdentity(tiers.full)) {
    reasonCode = "untargeted_full_suite_denied";
    suggestion = publicSuggestion(config);
  } else if (session.failed_test_turns.length >= budget.max_failed_test_turns) {
    reasonCode = "failed_test_turn_budget_exceeded";
  } else if (isNewVerificationTurn && session.test_turns.length >= budget.max_verification_turns) {
    reasonCode = "agent_turn_budget_exceeded";
  } else if (session.test_executions >= budget.max_test_executions) {
    reasonCode = "test_execution_budget_exceeded";
  } else if (session.immediate_duration_ms >= budget.max_immediate_duration_ms) {
    reasonCode = "immediate_duration_budget_exceeded";
  } else {
    const previous = [...session.completed].reverse().find((entry) => entry.canonical_command_id === analysis.canonicalId);
    if (previous?.outcome === "passed") reasonCode = "repeat_after_pass_denied";
  }

  if (reasonCode) {
    const record = decisionRecord({ payload, config, analysis, decision: "deny", reasonCode, tier, session });
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
