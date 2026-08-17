import { createHash } from "node:crypto";
import { diagnoseTrace } from "./diagnostics.mjs";
import { renderTraceReplay } from "./replay.mjs";
import { validateTrace } from "./trace.mjs";

export const EVALUATION_REPORT_VERSION = 1;

const REQUIRED_THRESHOLDS = [
  "minimum_quality_claim_comparisons",
  "minimum_oracle_failures",
  "event_completeness",
  "command_normalization",
  "diagnostic_precision",
  "replay_correctness",
  "comparison_integrity",
  "final_oracle_match",
  "failure_recall",
  "minimum_duration_reduction",
  "minimum_command_reduction",
];
const EVIDENCE_CLASSES = new Set(["canonical_fixture", "observed_benchmark"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(6));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : rounded(numerator / denominator);
}

function metric(definition, numerator, denominator, extra = {}) {
  return { definition, numerator, denominator, value: ratio(numerator, denominator), ...extra };
}

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? rounded((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function reduction(baseline, candidate) {
  if (baseline === 0) return null;
  return rounded((baseline - candidate) / baseline);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assertCohort(cohort, tracesById) {
  if (!cohort || cohort.schema_version !== 1) throw new Error("Evaluation cohort schema_version must be 1");
  if (!EVIDENCE_CLASSES.has(cohort.evidence_class)) throw new Error("Evaluation cohort has an unsupported evidence_class");
  if (!Array.isArray(cohort.traces) || cohort.traces.length === 0) throw new Error("Evaluation cohort requires traces");
  if (!Array.isArray(cohort.comparisons) || cohort.comparisons.length === 0) throw new Error("Evaluation cohort requires comparisons");
  for (const threshold of REQUIRED_THRESHOLDS) {
    if (!Number.isFinite(cohort.thresholds?.[threshold]) || cohort.thresholds[threshold] < 0) throw new Error(`Evaluation cohort requires non-negative threshold ${threshold}`);
  }
  const traceIds = new Set();
  for (const descriptor of cohort.traces) {
    if (!descriptor.id || traceIds.has(descriptor.id)) throw new Error(`Duplicate or missing trace id: ${descriptor.id}`);
    traceIds.add(descriptor.id);
    if (!tracesById.has(descriptor.id)) throw new Error(`Missing loaded trace: ${descriptor.id}`);
    if (!Array.isArray(descriptor.expected_diagnostics)) throw new Error(`Trace ${descriptor.id} requires expected_diagnostics`);
  }
  const comparisonIds = new Set();
  for (const comparison of cohort.comparisons) {
    if (!comparison.id || comparisonIds.has(comparison.id)) throw new Error(`Duplicate or missing comparison id: ${comparison.id}`);
    comparisonIds.add(comparison.id);
    if (!traceIds.has(comparison.baseline_trace) || !traceIds.has(comparison.candidate_trace)) {
      throw new Error(`Comparison ${comparison.id} references an unknown trace`);
    }
    if (!comparison.oracle || !Array.isArray(comparison.oracle.failure_signatures)) {
      throw new Error(`Comparison ${comparison.id} requires an oracle`);
    }
    if (typeof comparison.quality_claim_eligible !== "boolean") {
      throw new Error(`Comparison ${comparison.id} requires quality_claim_eligible`);
    }
  }
}

function commandNormalization(trace) {
  const selectedCommands = new Map();
  let numerator = 0;
  let denominator = 0;
  for (const event of trace.events ?? []) {
    if (event.event_type === "test_selection" && Array.isArray(event.data?.commands)) {
      for (const command of event.data.commands) selectedCommands.set(command.id, stableStringify(command.argv));
    }
    if (event.event_type !== "test_result") continue;
    denominator += 1;
    if (selectedCommands.get(event.data?.canonical_command_id) === stableStringify(event.data?.command)) numerator += 1;
  }
  return { numerator, denominator };
}

function replayIsCorrect(trace) {
  try {
    const html = renderTraceReplay(trace);
    if (!html.startsWith("<!doctype html>")) return false;
    if (/<(?:script|link)\b/i.test(html) || /(?:src|href)=["']https?:/i.test(html)) return false;
    if ((html.match(/data-event-index=/g) ?? []).length !== trace.events.length) return false;
    return trace.events.every((event) => html.includes(escapeHtml(JSON.stringify(event, null, 2))));
  } catch {
    return false;
  }
}

function diagnosticKey(finding) {
  return `${finding.event_index}:${finding.label}`;
}

function finalStatus(trace) {
  return trace.events?.find((event) => event.event_type === "stop")?.data?.status ?? null;
}

function failureSignatures(trace) {
  return new Set(
    (trace.events ?? [])
      .filter((event) => event.event_type === "test_result" && event.data?.failure_signature)
      .map((event) => event.data.failure_signature),
  );
}

function traceCost(trace) {
  const results = (trace.events ?? []).filter((event) => event.event_type === "test_result");
  return {
    command_executions: results.length,
    unique_canonical_commands: new Set(results.map((event) => event.data.canonical_command_id)).size,
    duration_ms: results.reduce((total, event) => total + event.data.duration_ms, 0),
  };
}

function gate(id, category, value, threshold, definition) {
  const status = value === null ? "evidence_insufficient" : value >= threshold ? "pass" : "fail";
  return { id, category, definition, value, comparator: ">=", threshold, status };
}

function reportDigest(cohort, tracesById) {
  const traces = Object.fromEntries([...tracesById.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(stableStringify({ cohort, traces })).digest("hex");
}

export function evaluateCohort(cohort, tracesInput) {
  const tracesById = tracesInput instanceof Map ? tracesInput : new Map(Object.entries(tracesInput));
  assertCohort(cohort, tracesById);

  let completeTraces = 0;
  let normalizedCommands = 0;
  let commandResults = 0;
  let diagnosticTruePositives = 0;
  let diagnosticFalsePositives = 0;
  let diagnosticFalseNegatives = 0;
  let correctReplays = 0;

  const traceReports = cohort.traces.map((descriptor) => {
    const trace = tracesById.get(descriptor.id);
    const validation = validateTrace(trace, { allowPartial: true });
    const complete = validation.valid && trace.completeness === "complete" && finalStatus(trace) !== null;
    if (complete) completeTraces += 1;

    const normalization = commandNormalization(trace);
    normalizedCommands += normalization.numerator;
    commandResults += normalization.denominator;

    let actualDiagnostics = [];
    let diagnosticError = null;
    try {
      actualDiagnostics = diagnoseTrace(trace).findings.map((finding) => ({
        event_index: finding.event_index,
        label: finding.label,
      }));
    } catch (error) {
      diagnosticError = error.message;
    }
    const expectedKeys = new Set(descriptor.expected_diagnostics.map(diagnosticKey));
    const actualKeys = new Set(actualDiagnostics.map(diagnosticKey));
    const truePositives = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
    const falsePositives = [...actualKeys].filter((key) => !expectedKeys.has(key)).length;
    const falseNegatives = [...expectedKeys].filter((key) => !actualKeys.has(key)).length;
    diagnosticTruePositives += truePositives;
    diagnosticFalsePositives += falsePositives;
    diagnosticFalseNegatives += falseNegatives;

    const replayCorrect = replayIsCorrect(trace);
    if (replayCorrect) correctReplays += 1;
    return {
      id: descriptor.id,
      path: descriptor.path,
      trace_id: trace.trace_id ?? null,
      complete,
      validation_errors: validation.errors,
      normalized_commands: normalization,
      diagnostics: {
        expected: descriptor.expected_diagnostics,
        actual: actualDiagnostics,
        true_positives: truePositives,
        false_positives: falsePositives,
        false_negatives: falseNegatives,
        error: diagnosticError,
      },
      replay_correct: replayCorrect,
      verification_cost: traceCost(trace),
    };
  });

  let finalOracleMatches = 0;
  let comparisonIntegrityMatches = 0;
  let oracleFailureCount = 0;
  let eligibleOracleFailureCount = 0;
  let baselineFailuresCaught = 0;
  let candidateFailuresCaught = 0;
  const durationReductions = [];
  const commandReductions = [];

  const comparisonReports = cohort.comparisons.map((comparison) => {
    const baseline = tracesById.get(comparison.baseline_trace);
    const candidate = tracesById.get(comparison.candidate_trace);
    const baselineCost = traceCost(baseline);
    const candidateCost = traceCost(candidate);
    const durationReduction = reduction(baselineCost.duration_ms, candidateCost.duration_ms);
    const commandReduction = reduction(baselineCost.command_executions, candidateCost.command_executions);
    durationReductions.push(durationReduction);
    commandReductions.push(commandReduction);

    const expectedFailures = comparison.oracle.failure_signatures;
    const baselineFailures = failureSignatures(baseline);
    const candidateFailures = failureSignatures(candidate);
    const baselineCaught = expectedFailures.filter((signature) => baselineFailures.has(signature)).length;
    const candidateCaught = expectedFailures.filter((signature) => candidateFailures.has(signature)).length;
    oracleFailureCount += expectedFailures.length;
    if (comparison.quality_claim_eligible) eligibleOracleFailureCount += expectedFailures.length;
    baselineFailuresCaught += baselineCaught;
    candidateFailuresCaught += candidateCaught;

    const candidateFinalStatus = finalStatus(candidate);
    const oracleMatch = candidateFinalStatus === comparison.oracle.final_status;
    if (oracleMatch) finalOracleMatches += 1;
    const integrityMatch = baseline.task_id === comparison.task_id && candidate.task_id === comparison.task_id;
    if (integrityMatch) comparisonIntegrityMatches += 1;

    return {
      id: comparison.id,
      task_id: comparison.task_id,
      baseline_trace: comparison.baseline_trace,
      candidate_trace: comparison.candidate_trace,
      quality_claim_eligible: comparison.quality_claim_eligible === true,
      comparison_integrity: integrityMatch,
      oracle: comparison.oracle,
      candidate_final_status: candidateFinalStatus,
      final_oracle_match: oracleMatch,
      baseline_failures_caught: baselineCaught,
      candidate_failures_caught: candidateCaught,
      baseline_cost: baselineCost,
      candidate_cost: candidateCost,
      duration_reduction: durationReduction,
      command_reduction: commandReduction,
    };
  });

  const metrics = {
    event_completeness: metric(
      "Validated complete traces with an explicit stop / all cohort traces",
      completeTraces,
      cohort.traces.length,
    ),
    command_normalization: metric(
      "Test results matching a previously selected canonical command id and argv / all test results",
      normalizedCommands,
      commandResults,
    ),
    diagnostic_precision: metric(
      "Expected event-label findings / all emitted event-label findings",
      diagnosticTruePositives,
      diagnosticTruePositives + diagnosticFalsePositives,
      { true_positives: diagnosticTruePositives, false_positives: diagnosticFalsePositives },
    ),
    diagnostic_recall: metric(
      "Expected event-label findings emitted / all expected event-label findings",
      diagnosticTruePositives,
      diagnosticTruePositives + diagnosticFalseNegatives,
      { false_negatives: diagnosticFalseNegatives },
    ),
    replay_correctness: metric(
      "Offline replays containing every escaped event with no remote runtime dependency / all cohort traces",
      correctReplays,
      cohort.traces.length,
    ),
    comparison_integrity: metric(
      "Baseline and candidate traces matching the declared task id / all comparisons",
      comparisonIntegrityMatches,
      cohort.comparisons.length,
    ),
    final_oracle_match: metric(
      "Candidate traces matching the independent expected final status / all comparisons",
      finalOracleMatches,
      cohort.comparisons.length,
    ),
    baseline_failure_recall: metric(
      "Independent oracle failure signatures observed by baseline traces / all oracle failure signatures",
      baselineFailuresCaught,
      oracleFailureCount,
    ),
    candidate_failure_recall: metric(
      "Independent oracle failure signatures observed by candidate traces / all oracle failure signatures",
      candidateFailuresCaught,
      oracleFailureCount,
    ),
    failure_recall_delta: {
      definition: "Candidate failure recall minus baseline failure recall",
      value: oracleFailureCount === 0 ? null : rounded((candidateFailuresCaught - baselineFailuresCaught) / oracleFailureCount),
    },
    verification_cost: {
      definition: "Median per-task reduction from observed baseline to candidate test-result count and cumulative duration",
      comparison_count: cohort.comparisons.length,
      duration_reduction_denominator: durationReductions.filter((value) => value !== null).length,
      command_reduction_denominator: commandReductions.filter((value) => value !== null).length,
      median_duration_reduction: median(durationReductions),
      median_command_reduction: median(commandReductions),
    },
    evidence_sufficiency: {
      definition: "Quality-claim-eligible comparisons and independent oracle failures available for safety claims",
      eligible_comparisons: cohort.comparisons.filter((comparison) => comparison.quality_claim_eligible === true).length,
      required_comparisons: cohort.thresholds.minimum_quality_claim_comparisons,
      oracle_failures: eligibleOracleFailureCount,
      required_oracle_failures: cohort.thresholds.minimum_oracle_failures,
      calibration_oracle_failures: oracleFailureCount,
      evidence_class: cohort.evidence_class,
    },
  };

  const gates = [
    gate("event_completeness", "structural", metrics.event_completeness.value, cohort.thresholds.event_completeness, metrics.event_completeness.definition),
    gate("command_normalization", "structural", metrics.command_normalization.value, cohort.thresholds.command_normalization, metrics.command_normalization.definition),
    gate("diagnostic_precision", "structural", metrics.diagnostic_precision.value, cohort.thresholds.diagnostic_precision, metrics.diagnostic_precision.definition),
    gate("replay_correctness", "structural", metrics.replay_correctness.value, cohort.thresholds.replay_correctness, metrics.replay_correctness.definition),
    gate("comparison_integrity", "structural", metrics.comparison_integrity.value, cohort.thresholds.comparison_integrity, metrics.comparison_integrity.definition),
    gate("final_oracle_match", "safety", metrics.final_oracle_match.value, cohort.thresholds.final_oracle_match, metrics.final_oracle_match.definition),
    gate("failure_recall", "safety", metrics.candidate_failure_recall.value, cohort.thresholds.failure_recall, metrics.candidate_failure_recall.definition),
    gate("duration_reduction", "efficiency", metrics.verification_cost.median_duration_reduction, cohort.thresholds.minimum_duration_reduction, "Median per-task reduction in cumulative test-result duration"),
    gate("command_reduction", "efficiency", metrics.verification_cost.median_command_reduction, cohort.thresholds.minimum_command_reduction, "Median per-task reduction in normalized test-result executions"),
  ];
  const recallGate = gates.find((item) => item.id === "failure_recall");
  recallGate.definition = `${recallGate.definition}; candidate recall must not regress from baseline`;
  recallGate.non_regression_delta = metrics.failure_recall_delta.value;
  recallGate.non_regression_comparator = ">=";
  recallGate.non_regression_threshold = 0;
  if (metrics.failure_recall_delta.value === null) recallGate.status = "evidence_insufficient";
  else if (metrics.failure_recall_delta.value < 0) recallGate.status = "fail";

  const failedSafetyGates = gates.filter((item) => item.category === "safety" && item.status === "fail");
  const insufficientSafetyGates = gates.filter((item) => item.category === "safety" && item.status === "evidence_insufficient");
  const failedStructuralGates = gates.filter((item) => item.category === "structural" && item.status !== "pass");
  const failedEfficiencyGates = gates.filter((item) => item.category === "efficiency" && item.status !== "pass");
  const sufficientComparisons = metrics.evidence_sufficiency.eligible_comparisons >= metrics.evidence_sufficiency.required_comparisons;
  const sufficientFailures = metrics.evidence_sufficiency.oracle_failures >= metrics.evidence_sufficiency.required_oracle_failures;
  const claimEligibleEvidence = cohort.evidence_class === "observed_benchmark";

  let status;
  let efficiencyClaim;
  if (failedSafetyGates.length > 0) {
    status = "rejected";
    efficiencyClaim = "blocked";
  } else if (insufficientSafetyGates.length > 0 || !sufficientComparisons || !sufficientFailures || !claimEligibleEvidence) {
    status = "evidence_insufficient";
    efficiencyClaim = "not_supported";
  } else if (failedStructuralGates.length > 0 || failedEfficiencyGates.length > 0) {
    status = "adjust";
    efficiencyClaim = "not_supported";
  } else {
    status = "eligible";
    efficiencyClaim = "supported";
  }

  const reasonCodes = [
    ...failedSafetyGates.map((item) => `failed_safety_gate:${item.id}`),
    ...insufficientSafetyGates.map((item) => `insufficient_safety_gate:${item.id}`),
    ...failedStructuralGates.map((item) => `failed_structural_gate:${item.id}`),
    ...failedEfficiencyGates.map((item) => `failed_efficiency_gate:${item.id}`),
    ...(!sufficientComparisons ? ["insufficient_quality_claim_comparisons"] : []),
    ...(!sufficientFailures ? ["insufficient_oracle_failures"] : []),
    ...(!claimEligibleEvidence ? ["canonical_fixtures_are_not_benchmark_evidence"] : []),
  ];

  return {
    report_version: EVALUATION_REPORT_VERSION,
    cohort: {
      id: cohort.cohort_id,
      version: cohort.cohort_version,
      schema_version: cohort.schema_version,
      evidence_class: cohort.evidence_class,
      external_benchmarks: cohort.external_benchmarks,
      input_digest: reportDigest(cohort, tracesById),
    },
    thresholds: cohort.thresholds,
    metrics,
    gates,
    conclusion: {
      status,
      efficiency_claim: efficiencyClaim,
      reason_codes: [...new Set(reasonCodes)],
      external_p1_p2_benchmarks: "deferred",
    },
    traces: traceReports,
    comparisons: comparisonReports,
  };
}
