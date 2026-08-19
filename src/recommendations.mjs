import { diagnoseTrace, DIAGNOSTIC_RULESET_VERSION } from "./diagnostics.mjs";
import { assertValidTrace } from "./trace.mjs";

export const RECOMMENDATION_RULESET_VERSION = 1;
export const RECOMMENDATION_MODES = Object.freeze(["expert", "simplified"]);

const REPEAT_LABELS = new Set(["exact_repeat", "unattributed_retry"]);

function riskContext(trace, eventIndex) {
  let riskLevel = "low";
  let fallback = false;
  for (const event of trace.events) {
    if (event.event_index > eventIndex) break;
    if (event.event_type !== "risk") continue;
    riskLevel = event.data.risk_level;
    fallback = event.data.fallback === true;
  }

  if (fallback || riskLevel === "thorough") return "high";
  if (riskLevel === "standard") return "medium";
  return "low";
}

function recommendationFor(trace, findings, mode) {
  const primary = findings[0];
  const labels = findings.map((finding) => finding.label);
  const repeat = labels.every((label) => REPEAT_LABELS.has(label));
  const contextual = labels.includes("necessary_revalidation");
  const riskLevel = contextual ? "high" : riskContext(trace, primary.event_index);
  const confidence = contextual ? "low" : "high";
  const automaticEligible = mode === "simplified" && repeat && riskLevel === "low" && confidence === "high";
  const recommendationId = `rec-${primary.event_index}-${primary.label}`;
  const evidenceEventIndexes = [...new Set(findings.flatMap((finding) => finding.evidence_event_indexes))].sort((a, b) => a - b);

  return {
    recommendation_id: recommendationId,
    ruleset_version: RECOMMENDATION_RULESET_VERSION,
    diagnostic_ruleset_version: DIAGNOSTIC_RULESET_VERSION,
    label: primary.label,
    diagnostic_labels: labels,
    reason_codes: findings.map((finding) => finding.reason_code),
    candidate: repeat ? "duplicate_verification" : "state_change_revalidation",
    action: repeat ? "suppress_low_information_repeat" : "require_revalidation_confirmation",
    mode,
    risk_level: riskLevel,
    confidence,
    automatic_eligible: automaticEligible,
    requires_confirmation: !automaticEligible,
    evidence_event_indexes: evidenceEventIndexes,
  };
}

function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const candidate = REPEAT_LABELS.has(finding.label) ? "duplicate_verification" : finding.label;
    const key = `${finding.event_index}:${candidate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.values()];
}

export function evaluateRecommendations(trace, { mode = "expert" } = {}) {
  if (!RECOMMENDATION_MODES.includes(mode)) {
    throw new Error(`Unsupported recommendation mode: ${mode}`);
  }
  assertValidTrace(trace, { allowPartial: trace?.completeness === "partial" });
  const diagnostics = diagnoseTrace(trace);
  return {
    ruleset_version: RECOMMENDATION_RULESET_VERSION,
    diagnostic_ruleset_version: diagnostics.ruleset_version,
    trace_id: trace.trace_id,
    mode,
    diagnostics,
    recommendations: groupFindings(diagnostics.findings).map((findings) => recommendationFor(trace, findings, mode)),
  };
}

function auditTimestamp(events, insertIndex) {
  return events[insertIndex - 1]?.timestamp ?? events.at(-1)?.timestamp;
}

function userDecision(recommendation, decision) {
  if (!decision || typeof decision !== "object") {
    throw new Error(`Decision for ${recommendation.recommendation_id} must be an object`);
  }
  if (!["accepted", "rejected", "deferred", "applied"].includes(decision.outcome)) {
    throw new Error(`Decision for ${recommendation.recommendation_id} has an unsupported outcome`);
  }
  if (typeof decision.reason !== "string" || decision.reason.trim() === "") {
    throw new Error(`Decision for ${recommendation.recommendation_id} requires a reason`);
  }
  return {
    recommendation_id: recommendation.recommendation_id,
    outcome: decision.outcome,
    actor: "user",
    reason: decision.reason,
  };
}

export function appendRecommendationAudit(trace, evaluation, { decisions = {} } = {}) {
  if (!evaluation || evaluation.trace_id !== trace?.trace_id) {
    throw new Error("Recommendation evaluation does not match the trace");
  }
  if (evaluation.ruleset_version !== RECOMMENDATION_RULESET_VERSION) {
    throw new Error("Unsupported recommendation ruleset version");
  }
  assertValidTrace(trace, { allowPartial: trace?.completeness === "partial" });
  const expectedEvaluation = evaluateRecommendations(trace, { mode: evaluation.mode });
  if (JSON.stringify(evaluation.recommendations) !== JSON.stringify(expectedEvaluation.recommendations)) {
    throw new Error("Recommendation evaluation does not match the current trace and mode");
  }

  const evaluatedIds = new Set(evaluation.recommendations.map((recommendation) => recommendation.recommendation_id));
  const unknownDecisionIds = Object.keys(decisions).filter((recommendationId) => !evaluatedIds.has(recommendationId));
  if (unknownDecisionIds.length > 0) {
    throw new Error(`Decisions reference unknown recommendations: ${unknownDecisionIds.join(", ")}`);
  }

  const existingIds = new Set(
    trace.events
      .filter((event) => event.event_type === "recommendation")
      .map((event) => event.data.recommendation_id),
  );
  const insertIndex = trace.events.findIndex((event) => event.event_type === "stop");
  const actualInsertIndex = insertIndex === -1 ? trace.events.length : insertIndex;
  const timestamp = auditTimestamp(trace.events, actualInsertIndex);
  const baseLine = trace.source.record_count;
  const auditEvents = [];

  evaluation.recommendations.forEach((recommendation, index) => {
    if (existingIds.has(recommendation.recommendation_id)) {
      throw new Error(`Recommendation ${recommendation.recommendation_id} already exists in trace`);
    }
    auditEvents.push({
      event_index: -1,
      event_type: "recommendation",
      timestamp,
      data: {
        recommendation_id: recommendation.recommendation_id,
        candidate: recommendation.candidate,
        action: recommendation.action,
        diagnostic_labels: [...recommendation.diagnostic_labels],
        reason_codes: [...recommendation.reason_codes],
        mode: recommendation.mode,
        risk_level: recommendation.risk_level,
        confidence: recommendation.confidence,
        diagnostic_ruleset_version: recommendation.diagnostic_ruleset_version,
        recommendation_ruleset_version: recommendation.ruleset_version,
        automatic_eligible: recommendation.automatic_eligible,
        requires_confirmation: recommendation.requires_confirmation,
        evidence_event_indexes: [...recommendation.evidence_event_indexes],
      },
      raw_event_ref: { kind: "generated", line: baseLine + index + 1, event: "recommendation" },
    });

    const requestedDecision = Object.hasOwn(decisions, recommendation.recommendation_id)
      ? decisions[recommendation.recommendation_id]
      : null;
    if (requestedDecision) {
      auditEvents.push({
        event_index: -1,
        event_type: "decision",
        timestamp,
        data: userDecision(recommendation, requestedDecision),
        raw_event_ref: { kind: "generated", line: baseLine + index + 1, event: "decision" },
      });
    } else if (recommendation.automatic_eligible) {
      auditEvents.push({
        event_index: -1,
        event_type: "decision",
        timestamp,
        data: {
          recommendation_id: recommendation.recommendation_id,
          outcome: "applied",
          actor: "system",
          reason: "automatic_low_risk_rule",
        },
        raw_event_ref: { kind: "generated", line: baseLine + index + 1, event: "decision" },
      });
    }
  });

  const events = structuredClone([
    ...trace.events.slice(0, actualInsertIndex),
    ...auditEvents,
    ...trace.events.slice(actualInsertIndex),
  ]);
  events.forEach((event, index) => { event.event_index = index; });
  const auditedTrace = { ...structuredClone(trace), events };
  assertValidTrace(auditedTrace, { allowPartial: true });
  return auditedTrace;
}
