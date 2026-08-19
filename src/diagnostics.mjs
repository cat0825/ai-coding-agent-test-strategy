import { assertValidTrace } from "./trace.mjs";

export const DIAGNOSTIC_RULESET_VERSION = 1;
export const DIAGNOSTIC_LABELS = Object.freeze([
  "exact_repeat",
  "unattributed_retry",
  "necessary_revalidation",
]);

const REVALIDATION_CHANGE_KINDS = new Set(["code", "test", "fixture", "config", "environment"]);

function finding(label, event, previous, between, reasonCode) {
  return {
    ruleset_version: DIAGNOSTIC_RULESET_VERSION,
    label,
    event_index: event.event_index,
    canonical_command_id: event.data.canonical_command_id,
    reason_code: reasonCode,
    evidence_event_indexes: [
      previous.event_index,
      ...between.map((candidate) => candidate.event_index),
      event.event_index,
    ],
  };
}

function diffEvidence(events) {
  const diffs = events.filter((event) => event.event_type === "diff");
  return {
    relevant: diffs.filter((event) => event.data.change_kinds.some((kind) => REVALIDATION_CHANGE_KINDS.has(kind))),
    unknown: diffs.filter((event) => event.data.state_id === null || event.data.change_kinds.length === 0),
  };
}

function sameObservedFailure(previous, current) {
  return (
    previous.data.exit_code !== 0 &&
    current.data.exit_code !== 0 &&
    previous.data.failure_signature !== null &&
    previous.data.failure_signature === current.data.failure_signature
  );
}

export function diagnoseTrace(trace) {
  assertValidTrace(trace, { allowPartial: trace?.completeness === "partial" });
  const findings = [];
  const previousResults = new Map();

  for (const event of trace.events) {
    if (event.event_type !== "test_result") continue;
    const commandId = event.data.canonical_command_id;
    const previous = previousResults.get(commandId);
    if (previous) {
      const between = trace.events.slice(previous.event_index + 1, event.event_index);
      const changes = diffEvidence(between);
      if (changes.relevant.length > 0) {
        findings.push(finding(
          "necessary_revalidation",
          event,
          previous,
          between,
          "relevant_state_changed",
        ));
      } else if (changes.unknown.length === 0) {
        findings.push(finding(
          "exact_repeat",
          event,
          previous,
          between,
          "same_command_without_relevant_change",
        ));
        const retries = between.filter((candidate) => candidate.event_type === "retry");
        const attributed = retries.some((retry) => retry.data.attributed === true);
        if (sameObservedFailure(previous, event) && !attributed) {
          findings.push(finding(
            "unattributed_retry",
            event,
            previous,
            between,
            "same_failure_without_attribution",
          ));
        }
      }
    }
    previousResults.set(commandId, event);
  }

  const summary = Object.fromEntries(DIAGNOSTIC_LABELS.map((label) => [label, 0]));
  for (const item of findings) summary[item.label] += 1;
  const wasteEvents = findings
    .filter((item) => item.label === "exact_repeat" || item.label === "unattributed_retry")
    .map((item) => item.event_index);

  return {
    ruleset_version: DIAGNOSTIC_RULESET_VERSION,
    trace_id: trace.trace_id,
    findings,
    summary,
    first_candidate_waste_event_index: wasteEvents.length > 0 ? Math.min(...wasteEvents) : null,
  };
}
