import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertValidTrace,
  convertLedgerToTrace,
  TraceValidationError,
  validateTrace,
} from "../src/trace.mjs";

const fixtureRoot = path.resolve("fixtures/traces");

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), "utf8"));
}

test("canonical fixtures validate and preserve their intended lifecycle", async () => {
  const fixtures = await Promise.all([
    readFixture("success.json"),
    readFixture("failed-retry.json"),
    readFixture("conservative-escalation.json"),
  ]);

  assert.deepEqual(
    fixtures.map((fixture) => validateTrace(fixture)),
    fixtures.map(() => ({ valid: true, errors: [], warnings: [] })),
  );
  assert.deepEqual(
    fixtures.map((fixture) => fixture.events.map((event) => event.event_type)),
    [
      ["diff", "risk", "test_selection", "test_result", "stop"],
      ["diff", "risk", "test_selection", "test_result", "retry", "test_selection", "test_result", "stop"],
      ["diff", "risk", "test_selection", "test_result", "expand", "test_selection", "test_result", "stop"],
    ],
  );
});

test("ledger conversion is deterministic and does not invent missing decisions", () => {
  const ledger = [
    {
      schema_version: 1,
      task_id: "ledger-task",
      repository: "fixture-repository",
      repository_commit: "abc1234",
      policy_name: "fixture-policy",
      policy_version: "policy-v1",
      mode: "shadow",
      event: "plan",
      created_at: "2026-08-17T11:00:00.000Z",
      requested_phase: "affected",
      selected_phase: "affected",
      risk_level: "standard",
      changed_files: ["src/api.mjs"],
      affected_workspaces: ["fixture-core"],
      fallback: false,
      reasons: ["workspace_mapping"],
      warnings: [],
      commands: [{ id: "fixture-core:test", argv: ["npm", "test"] }],
    },
    {
      schema_version: 1,
      task_id: "ledger-task",
      repository: "fixture-repository",
      repository_commit: "abc1234",
      policy_name: "fixture-policy",
      policy_version: "policy-v1",
      mode: "shadow",
      event: "command",
      canonical_command_id: "fixture-core:test",
      command: ["npm", "test"],
      started_at: "2026-08-17T11:00:02.000Z",
      duration_ms: 2000,
      exit_code: 0,
      signal: null,
      failure_class: null,
      override: null,
    },
  ];
  const first = convertLedgerToTrace(ledger, { sourceRef: "ledger.jsonl" });
  const second = convertLedgerToTrace(ledger, { sourceRef: "ledger.jsonl" });

  assert.deepEqual(first, second);
  assert.equal(first.completeness, "partial");
  assert.deepEqual(first.events.map((event) => event.event_type), ["diff", "risk", "test_selection", "test_result"]);
  assert.equal(first.events.at(-1).event_type, "test_result");
  assert.equal(first.events.at(-1).raw_event_ref.line, 2);
  assert.deepEqual(validateTrace(first, { allowPartial: true }), {
    valid: true,
    errors: [],
    warnings: ["missing_stop_event"],
  });
});

test("invalid fields and event order produce actionable errors", async () => {
  const fixture = await readFixture("success.json");
  const invalid = structuredClone(fixture);
  invalid.events[2].data.selected_phase = "unknown";
  invalid.events[3].timestamp = "2026-08-17T09:00:00.000Z";
  invalid.events[3].raw_event_ref.line = 0;

  const result = validateTrace(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.path), [
    "events[2].data.selected_phase",
    "events[3].timestamp",
    "events[3].raw_event_ref.line",
  ]);
  assert.throws(() => assertValidTrace(invalid), (error) => {
    assert.equal(error instanceof TraceValidationError, true);
    assert.match(error.message, /events\[2\]\.data\.selected_phase/);
    return true;
  });
});

test("complete traces require an explicit stop event", async () => {
  const fixture = await readFixture("success.json");
  const incomplete = structuredClone(fixture);
  incomplete.completeness = "complete";
  incomplete.events.pop();
  incomplete.source.record_count = incomplete.events.length;

  const result = validateTrace(incomplete);
  assert.equal(result.valid, false);
  assert.match(result.errors.map((error) => error.message).join(" "), /complete traces must end with stop/);
});

test("retry and expansion references must point backwards", async () => {
  const fixture = await readFixture("failed-retry.json");
  const invalid = structuredClone(fixture);
  invalid.events[4].data.from_event_index = 4;

  const result = validateTrace(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.path), ["events[4].data.from_event_index"]);
});

test("conversion requires an explicit task when a ledger contains multiple tasks", () => {
  const ledger = [
    {
      event: "plan",
      task_id: "task-a",
      created_at: "2026-08-17T11:00:00.000Z",
      risk_level: "off",
      reasons: [],
      fallback: false,
      requested_phase: "fast",
      selected_phase: "fast",
      changed_files: [],
      affected_workspaces: [],
      commands: [],
      policy_name: "policy",
      policy_version: "v1",
      mode: "shadow",
      repository: "fixture",
      repository_commit: "abc",
    },
    {
      event: "plan",
      task_id: "task-b",
      created_at: "2026-08-17T11:00:01.000Z",
      risk_level: "smoke",
      reasons: ["explicit_fast_phase"],
      fallback: false,
      requested_phase: "fast",
      selected_phase: "fast",
      changed_files: ["src/index.mjs"],
      affected_workspaces: [],
      commands: [{ id: "root:test", argv: ["npm", "test"] }],
      policy_name: "policy",
      policy_version: "v1",
      mode: "shadow",
      repository: "fixture",
      repository_commit: "def",
    },
    {
      event: "command",
      task_id: "task-b",
      started_at: "2026-08-17T11:00:02.000Z",
      canonical_command_id: "root:test",
      command: ["npm", "test"],
      duration_ms: 1,
      exit_code: 0,
    },
  ];

  assert.throws(() => convertLedgerToTrace(ledger), /multiple task_ids; provide taskId/);
  const trace = convertLedgerToTrace(ledger, { taskId: "task-b" });
  assert.deepEqual(trace.events.map((event) => event.event_type), ["diff", "risk", "test_selection", "test_result"]);
  assert.deepEqual(trace.events.map((event) => event.raw_event_ref.line), [2, 2, 2, 3]);
});
