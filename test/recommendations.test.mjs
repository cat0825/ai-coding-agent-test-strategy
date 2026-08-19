import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appendRecommendationAudit, evaluateRecommendations } from "../src/recommendations.mjs";
import { validateTrace } from "../src/trace.mjs";

async function fixture(directory, name) {
  return JSON.parse(await readFile(path.resolve("fixtures", directory, name), "utf8"));
}

function withRisk(trace, riskLevel, fallback = false) {
  const result = structuredClone(trace);
  const risk = result.events.find((event) => event.event_type === "risk");
  risk.data.risk_level = riskLevel;
  risk.data.fallback = fallback;
  return result;
}

test("expert mode exposes the same evidence but never auto-applies", async () => {
  const trace = await fixture("diagnostics", "exact-repeat.json");
  const evaluation = evaluateRecommendations(trace, { mode: "expert" });

  assert.equal(evaluation.recommendations.length, 1);
  assert.equal(evaluation.recommendations[0].label, "exact_repeat");
  assert.equal(evaluation.recommendations[0].risk_level, "medium");
  assert.equal(evaluation.recommendations[0].confidence, "high");
  assert.equal(evaluation.recommendations[0].automatic_eligible, false);
  assert.equal(evaluation.recommendations[0].requires_confirmation, true);
  assert.deepEqual(evaluation.recommendations[0].evidence_event_indexes, [3, 4]);

  const audited = appendRecommendationAudit(trace, evaluation);
  assert.deepEqual(audited.events.map((event) => event.event_type), [
    "diff", "risk", "test_selection", "test_result", "test_result", "recommendation", "stop",
  ]);
  assert.equal(audited.events[5].data.mode, "expert");
  assert.equal(audited.events[5].data.recommendation_ruleset_version, 1);
  assert.equal(audited.events[5].data.diagnostic_ruleset_version, 1);
  assert.equal(validateTrace(audited).valid, true);
});

test("simplified mode auto-applies only a low-risk exact repeat", async () => {
  const trace = withRisk(await fixture("diagnostics", "exact-repeat.json"), "smoke");
  const evaluation = evaluateRecommendations(trace, { mode: "simplified" });
  const recommendation = evaluation.recommendations[0];

  assert.equal(recommendation.risk_level, "low");
  assert.equal(recommendation.automatic_eligible, true);
  const audited = appendRecommendationAudit(trace, evaluation);
  const decision = audited.events.find((event) => event.event_type === "decision");
  assert.deepEqual(decision.data, {
    recommendation_id: recommendation.recommendation_id,
    outcome: "applied",
    actor: "system",
    reason: "automatic_low_risk_rule",
  });
  assert.equal(validateTrace(audited).valid, true);
  const invalid = structuredClone(audited);
  invalid.events.find((event) => event.event_type === "decision").data.recommendation_id = "rec-missing";
  assert.equal(validateTrace(invalid).valid, false);
  assert.match(
    validateTrace(invalid).errors.map((error) => `${error.path} ${error.message}`).join(" "),
    /must refer to an earlier recommendation/,
  );
  const unsafe = structuredClone(audited);
  unsafe.events.find((event) => event.event_type === "recommendation").data.risk_level = "high";
  assert.equal(validateTrace(unsafe).valid, false);
  assert.match(
    validateTrace(unsafe).errors.map((error) => `${error.path} ${error.message}`).join(" "),
    /requires simplified mode, low risk, and high confidence/,
  );
});

test("overlapping repeat diagnostics produce one auditable action", async () => {
  const trace = withRisk(await fixture("diagnostics", "unattributed-retry.json"), "smoke");
  const evaluation = evaluateRecommendations(trace, { mode: "simplified" });

  assert.equal(evaluation.diagnostics.findings.length, 2);
  assert.equal(evaluation.recommendations.length, 1);
  assert.deepEqual(evaluation.recommendations[0].diagnostic_labels, ["exact_repeat", "unattributed_retry"]);
  assert.deepEqual(evaluation.recommendations[0].reason_codes, [
    "same_command_without_relevant_change",
    "same_failure_without_attribution",
  ]);
  const audited = appendRecommendationAudit(trace, evaluation);
  assert.equal(audited.events.filter((event) => event.event_type === "recommendation").length, 1);
  assert.equal(audited.events.filter((event) => event.event_type === "decision").length, 1);
});

test("high risk and fallback findings remain advisory in simplified mode", async () => {
  const trace = withRisk(await fixture("diagnostics", "exact-repeat.json"), "thorough", true);
  const evaluation = evaluateRecommendations(trace, { mode: "simplified" });
  const recommendation = evaluation.recommendations[0];

  assert.equal(recommendation.risk_level, "high");
  assert.equal(recommendation.automatic_eligible, false);
  assert.equal(recommendation.requires_confirmation, true);
  const audited = appendRecommendationAudit(trace, evaluation);
  assert.equal(audited.events.some((event) => event.event_type === "decision"), false);
  assert.equal(validateTrace(audited).valid, true);
});

test("contextual revalidation is low-confidence and records a user decision", async () => {
  const trace = await fixture("traces", "failed-retry.json");
  const evaluation = evaluateRecommendations(trace, { mode: "simplified" });
  const recommendation = evaluation.recommendations[0];

  assert.equal(recommendation.label, "necessary_revalidation");
  assert.equal(recommendation.confidence, "low");
  assert.equal(recommendation.automatic_eligible, false);
  const audited = appendRecommendationAudit(trace, evaluation, {
    decisions: {
      [recommendation.recommendation_id]: { outcome: "accepted", reason: "state changed before rerun" },
    },
  });
  const decision = audited.events.find((event) => event.event_type === "decision");
  assert.equal(decision.data.actor, "user");
  assert.equal(decision.data.outcome, "accepted");
  assert.equal(validateTrace(audited).valid, true);
});

test("unknown context produces no recommendation and unsupported modes fail closed", async () => {
  const trace = await fixture("traces", "failed-retry.json");
  trace.events[5].data.state_id = null;
  trace.events[5].data.change_kinds = [];
  assert.deepEqual(evaluateRecommendations(trace, { mode: "simplified" }).recommendations, []);
  assert.throws(() => evaluateRecommendations(trace, { mode: "automatic" }), /Unsupported recommendation mode/);
});

test("audit rejects tampered authorization and unknown user decisions", async () => {
  const trace = withRisk(await fixture("diagnostics", "exact-repeat.json"), "thorough");
  const evaluation = evaluateRecommendations(trace, { mode: "simplified" });
  const tampered = structuredClone(evaluation);
  tampered.recommendations[0].automatic_eligible = true;
  tampered.recommendations[0].requires_confirmation = false;

  assert.throws(
    () => appendRecommendationAudit(trace, tampered),
    /does not match the current trace and mode/,
  );
  assert.throws(
    () => appendRecommendationAudit(trace, evaluation, {
      decisions: { "rec-missing": { outcome: "accepted", reason: "unknown candidate" } },
    }),
    /unknown recommendations: rec-missing/,
  );
});
