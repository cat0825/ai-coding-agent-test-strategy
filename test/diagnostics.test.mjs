import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { diagnoseTrace } from "../src/diagnostics.mjs";

async function fixture(...parts) {
  return JSON.parse(await readFile(path.resolve("fixtures", ...parts), "utf8"));
}

test("exact repeats expose the first candidate waste point", async () => {
  const trace = await fixture("diagnostics", "exact-repeat.json");
  const result = diagnoseTrace(trace);

  assert.deepEqual(result.findings, [{
    ruleset_version: 1,
    label: "exact_repeat",
    event_index: 4,
    canonical_command_id: "fixture-core:test",
    reason_code: "same_command_without_relevant_change",
    evidence_event_indexes: [3, 4],
  }]);
  assert.equal(result.first_candidate_waste_event_index, 4);
  assert.deepEqual(result.summary, {
    exact_repeat: 1,
    unattributed_retry: 0,
    necessary_revalidation: 0,
  });
});

test("same failure without attribution is both a repeat and unattributed retry", async () => {
  const trace = await fixture("diagnostics", "unattributed-retry.json");
  const result = diagnoseTrace(trace);

  assert.deepEqual(result.findings.map((finding) => finding.label), ["exact_repeat", "unattributed_retry"]);
  assert.deepEqual(result.findings.map((finding) => finding.event_index), [6, 6]);
  assert.deepEqual(result.findings[1].evidence_event_indexes, [3, 4, 5, 6]);
  assert.equal(result.first_candidate_waste_event_index, 6);
});

test("a relevant state change is labeled as necessary revalidation", async () => {
  const trace = await fixture("traces", "failed-retry.json");
  const result = diagnoseTrace(trace);

  assert.deepEqual(result.findings.map((finding) => finding.label), ["necessary_revalidation"]);
  assert.deepEqual(result.findings[0].evidence_event_indexes, [3, 4, 5, 6, 7, 8]);
  assert.equal(result.first_candidate_waste_event_index, null);
});

test("unknown state changes do not produce false repeat labels", async () => {
  const trace = await fixture("traces", "failed-retry.json");
  trace.events[5].data.state_id = null;
  trace.events[5].data.change_kinds = [];
  const result = diagnoseTrace(trace);

  assert.deepEqual(result.findings, []);
  assert.equal(result.first_candidate_waste_event_index, null);
});

test("incomplete command semantics do not produce false repeat labels", async () => {
  const trace = await fixture("diagnostics", "exact-repeat.json");
  for (const event of trace.events.filter(({ event_type: type }) => type === "test_result")) {
    event.data.command_semantics = {
      version: 1,
      complete: false,
      reason: "unparseable_shell_command",
      cwd_sha256: null,
      environment_sha256: null,
      arguments_sha256: null,
      semantic_sha256: "d".repeat(64),
    };
  }

  assert.deepEqual(diagnoseTrace(trace).findings, []);
});

test("legacy agent-belt traces without explicit evidence never claim exact repeats", async () => {
  const trace = await fixture("diagnostics", "exact-repeat.json");
  trace.source.format = "agent-belt-codex-lifecycle-v1";

  assert.deepEqual(diagnoseTrace(trace).findings, []);
});

test("single runs and different commands produce no findings", async () => {
  const traces = await Promise.all([
    fixture("traces", "success.json"),
    fixture("traces", "conservative-escalation.json"),
  ]);

  assert.deepEqual(traces.map((trace) => diagnoseTrace(trace).findings), [[], []]);
});
