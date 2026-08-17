import { createHash } from "node:crypto";

export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_EVENT_TYPES = Object.freeze([
  "diff",
  "risk",
  "test_selection",
  "test_result",
  "retry",
  "expand",
  "stop",
]);

const PHASES = new Set(["fast", "affected", "full"]);
const RISK_LEVELS = new Set(["off", "smoke", "standard", "thorough"]);
const MODES = new Set(["shadow", "baseline"]);
const COMPLETENESS = new Set(["partial", "complete"]);

const NEXT_EVENT_TYPES = Object.freeze({
  diff: new Set(["risk"]),
  risk: new Set(["test_selection"]),
  test_selection: new Set(["test_result"]),
  test_result: new Set(["test_result", "retry", "expand", "stop"]),
  retry: new Set(["diff", "test_selection"]),
  expand: new Set(["test_selection"]),
  stop: new Set(),
});

export class TraceValidationError extends Error {
  constructor(errors) {
    super(`Invalid VerifyTrace: ${errors.map(({ path, message }) => `${path} ${message}`).join("; ")}`);
    this.name = "TraceValidationError";
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

function addRequiredString(errors, value, path) {
  if (!nonEmptyString(value)) addError(errors, path, "must be a non-empty string");
}

function validateCommandShape(errors, command, path) {
  if (!isObject(command)) {
    addError(errors, path, "must be an object");
    return;
  }
  addRequiredString(errors, command.id, `${path}.id`);
  if (!Array.isArray(command.argv) || command.argv.some((value) => typeof value !== "string")) {
    addError(errors, `${path}.argv`, "must be an array of strings");
  }
}

function validateEventData(errors, event) {
  const path = `events[${event.event_index}].data`;
  if (!isObject(event.data)) {
    addError(errors, path, "must be an object");
    return;
  }

  if (event.event_type === "diff") {
    if (!Array.isArray(event.data.changed_files) || event.data.changed_files.some((file) => typeof file !== "string")) {
      addError(errors, `${path}.changed_files`, "must be an array of strings");
    }
    if (event.data.state_id !== null && !nonEmptyString(event.data.state_id)) {
      addError(errors, `${path}.state_id`, "must be null or a non-empty string");
    }
    if (!Array.isArray(event.data.change_kinds) || event.data.change_kinds.some((kind) => typeof kind !== "string")) {
      addError(errors, `${path}.change_kinds`, "must be an array of strings");
    }
  } else if (event.event_type === "risk") {
    if (!RISK_LEVELS.has(event.data.risk_level)) addError(errors, `${path}.risk_level`, "must be a supported risk level");
    if (!Array.isArray(event.data.reasons) || event.data.reasons.some((reason) => typeof reason !== "string")) {
      addError(errors, `${path}.reasons`, "must be an array of strings");
    }
    if (typeof event.data.fallback !== "boolean") addError(errors, `${path}.fallback`, "must be a boolean");
  } else if (event.event_type === "test_selection") {
    if (!PHASES.has(event.data.requested_phase)) addError(errors, `${path}.requested_phase`, "must be fast, affected, or full");
    if (!PHASES.has(event.data.selected_phase)) addError(errors, `${path}.selected_phase`, "must be fast, affected, or full");
    if (!Array.isArray(event.data.commands)) {
      addError(errors, `${path}.commands`, "must be an array");
    } else {
      event.data.commands.forEach((command, index) => validateCommandShape(errors, command, `${path}.commands[${index}]`));
    }
  } else if (event.event_type === "test_result") {
    addRequiredString(errors, event.data.canonical_command_id, `${path}.canonical_command_id`);
    if (!Array.isArray(event.data.command) || event.data.command.some((value) => typeof value !== "string")) {
      addError(errors, `${path}.command`, "must be an array of strings");
    }
    if (!Number.isFinite(event.data.duration_ms) || event.data.duration_ms < 0) {
      addError(errors, `${path}.duration_ms`, "must be a non-negative number");
    }
    if (!Number.isInteger(event.data.exit_code)) addError(errors, `${path}.exit_code`, "must be an integer");
    if (event.data.failure_signature !== null && !nonEmptyString(event.data.failure_signature)) {
      addError(errors, `${path}.failure_signature`, "must be null or a non-empty string");
    }
    if (event.data.failure_class !== null && !nonEmptyString(event.data.failure_class)) {
      addError(errors, `${path}.failure_class`, "must be null or a non-empty string");
    }
  } else if (event.event_type === "retry" || event.event_type === "expand") {
    addRequiredString(errors, event.data.reason, `${path}.reason`);
    if (!Number.isInteger(event.data.from_event_index) || event.data.from_event_index < 0) {
      addError(errors, `${path}.from_event_index`, "must be a non-negative event index");
    } else if (event.data.from_event_index >= event.event_index) {
      addError(errors, `${path}.from_event_index`, "must refer to an earlier event");
    }
    if (event.event_type === "retry" && typeof event.data.attributed !== "boolean") {
      addError(errors, `${path}.attributed`, "must be a boolean");
    }
  } else if (event.event_type === "stop") {
    addRequiredString(errors, event.data.status, `${path}.status`);
    addRequiredString(errors, event.data.reason, `${path}.reason`);
  }
}

export function validateTrace(trace, { allowPartial = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(trace)) return { valid: false, errors: [{ path: "trace", message: "must be an object" }], warnings };
  if (trace.schema_version !== TRACE_SCHEMA_VERSION) addError(errors, "schema_version", `must be ${TRACE_SCHEMA_VERSION}`);
  addRequiredString(errors, trace.trace_id, "trace_id");
  addRequiredString(errors, trace.task_id, "task_id");
  if (trace.run_id !== null && !nonEmptyString(trace.run_id)) addError(errors, "run_id", "must be null or a non-empty string");
  if (trace.harness !== null && !nonEmptyString(trace.harness)) addError(errors, "harness", "must be null or a non-empty string");
  if (trace.model !== null && !nonEmptyString(trace.model)) addError(errors, "model", "must be null or a non-empty string");
  if (trace.repository !== null && !nonEmptyString(trace.repository)) addError(errors, "repository", "must be null or a non-empty string");
  if (trace.repository_commit !== null && !nonEmptyString(trace.repository_commit)) addError(errors, "repository_commit", "must be null or a non-empty string");
  if (!MODES.has(trace.mode)) addError(errors, "mode", "must be shadow or baseline");
  if (!COMPLETENESS.has(trace.completeness)) addError(errors, "completeness", "must be partial or complete");
  if (!isObject(trace.policy)) {
    addError(errors, "policy", "must be an object");
  } else {
    addRequiredString(errors, trace.policy.name, "policy.name");
    addRequiredString(errors, trace.policy.version, "policy.version");
  }
  if (!isObject(trace.source)) {
    addError(errors, "source", "must be an object");
  } else {
    addRequiredString(errors, trace.source.format, "source.format");
    if (!Number.isInteger(trace.source.record_count) || trace.source.record_count < 0) {
      addError(errors, "source.record_count", "must be a non-negative integer");
    }
  }
  if (trace.warnings !== undefined && (!Array.isArray(trace.warnings) || trace.warnings.some((warning) => typeof warning !== "string"))) {
    addError(errors, "warnings", "must be an array of strings");
  }
  if (!Array.isArray(trace.events) || trace.events.length === 0) {
    addError(errors, "events", "must be a non-empty array");
    return { valid: errors.length === 0, errors, warnings };
  }

  let previousTime = null;
  trace.events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!isObject(event)) {
      addError(errors, path, "must be an object");
      return;
    }
    if (event.event_index !== index) addError(errors, `${path}.event_index`, `must equal ${index}`);
    if (!TRACE_EVENT_TYPES.includes(event.event_type)) addError(errors, `${path}.event_type`, "is not supported");
    if (!isIsoTimestamp(event.timestamp)) {
      addError(errors, `${path}.timestamp`, "must be an ISO-8601 UTC timestamp");
    } else {
      const currentTime = Date.parse(event.timestamp);
      if (previousTime !== null && currentTime < previousTime) addError(errors, `${path}.timestamp`, "must not precede the previous event");
      previousTime = currentTime;
    }
    if (!isObject(event.raw_event_ref)) {
      addError(errors, `${path}.raw_event_ref`, "must be an object");
    } else {
      addRequiredString(errors, event.raw_event_ref.kind, `${path}.raw_event_ref.kind`);
      if (!Number.isInteger(event.raw_event_ref.line) || event.raw_event_ref.line < 1) addError(errors, `${path}.raw_event_ref.line`, "must be a positive integer");
      addRequiredString(errors, event.raw_event_ref.event, `${path}.raw_event_ref.event`);
    }
    if (TRACE_EVENT_TYPES.includes(event.event_type)) validateEventData(errors, event);
    if (index > 0) {
      const previousType = trace.events[index - 1]?.event_type;
      if (!NEXT_EVENT_TYPES[previousType]?.has(event.event_type)) {
        addError(errors, `${path}.event_type`, `cannot follow ${previousType}`);
      }
    } else if (event.event_type !== "diff") {
      addError(errors, `${path}.event_type`, "must start with diff");
    }
  });

  const lastEvent = trace.events.at(-1);
  if (trace.completeness === "complete" && lastEvent?.event_type !== "stop") {
    addError(errors, "events", "complete traces must end with stop");
  }
  if (trace.completeness === "partial" && lastEvent?.event_type !== "stop") {
    warnings.push("missing_stop_event");
    if (!allowPartial) addError(errors, "completeness", "partial traces require allowPartial=true when validated");
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidTrace(trace, options = {}) {
  const result = validateTrace(trace, options);
  if (!result.valid) throw new TraceValidationError(result.errors);
  return trace;
}

function rawEventRef(record, line, sourceRef) {
  const reference = { kind: "ledger", line, event: record.event };
  if (sourceRef) reference.source_ref = sourceRef;
  return reference;
}

function eventFromLedger(record, line, eventType, timestamp, data, sourceRef) {
  return {
    event_index: -1,
    event_type: eventType,
    timestamp,
    data,
    raw_event_ref: rawEventRef(record, line, sourceRef),
  };
}

function hashLedger(ledger) {
  return createHash("sha256").update(JSON.stringify(ledger)).digest("hex");
}

export function convertLedgerToTrace(ledger, { sourceRef = null, taskId = null } = {}) {
  if (!Array.isArray(ledger) || ledger.length === 0) throw new Error("Ledger must be a non-empty array");
  const taskIds = [...new Set(ledger.map((record) => record?.task_id).filter(nonEmptyString))];
  const selectedTaskId = taskId ?? (taskIds.length === 1 ? taskIds[0] : null);
  if (!selectedTaskId && taskIds.length > 1) throw new Error("Ledger contains multiple task_ids; provide taskId");
  const scopedRecords = ledger
    .map((record, index) => ({ record, line: index + 1 }))
    .filter(({ record }) => !selectedTaskId || record?.task_id === selectedTaskId);
  const planEntry = scopedRecords.find(({ record }) => record?.event === "plan");
  if (!planEntry) throw new Error(selectedTaskId ? `Ledger contains no plan event for task_id ${selectedTaskId}` : "Ledger must contain a plan event");
  const plan = planEntry.record;
  if (!nonEmptyString(plan.task_id)) throw new Error("Plan event requires task_id");

  const events = [];
  events.push(eventFromLedger(plan, planEntry.line, "diff", plan.created_at, {
    changed_files: Array.isArray(plan.changed_files) ? [...plan.changed_files] : [],
    repository_commit: plan.repository_commit ?? null,
    state_id: null,
    change_kinds: [],
  }, sourceRef));
  events.push(eventFromLedger(plan, planEntry.line, "risk", plan.created_at, {
    risk_level: plan.risk_level,
    reasons: Array.isArray(plan.reasons) ? [...plan.reasons] : [],
    fallback: plan.fallback === true,
    warnings: Array.isArray(plan.warnings) ? [...plan.warnings] : [],
  }, sourceRef));
  events.push(eventFromLedger(plan, planEntry.line, "test_selection", plan.created_at, {
    requested_phase: plan.requested_phase,
    selected_phase: plan.selected_phase,
    affected_workspaces: Array.isArray(plan.affected_workspaces) ? [...plan.affected_workspaces] : [],
    commands: Array.isArray(plan.commands) ? structuredClone(plan.commands) : [],
  }, sourceRef));

  scopedRecords.forEach(({ record, line }) => {
    if (!record || record.event === "plan") return;
    if (record.event === "command") {
      events.push(eventFromLedger(record, line, "test_result", record.started_at, {
        canonical_command_id: record.canonical_command_id,
        command: Array.isArray(record.command) ? [...record.command] : [],
      duration_ms: record.duration_ms,
      exit_code: record.exit_code,
      signal: record.signal ?? null,
      failure_signature: record.failure_signature ?? null,
      failure_class: record.failure_class ?? null,
        override: record.override ?? null,
      }, sourceRef));
      return;
    }
    if (!TRACE_EVENT_TYPES.includes(record.event)) return;
    const timestamp = record.timestamp ?? record.created_at ?? record.started_at;
    if (timestamp) events.push(eventFromLedger(record, line, record.event, timestamp, structuredClone(record.data ?? {}), sourceRef));
  });

  events.forEach((event, index) => { event.event_index = index; });
  const hasStop = events.some((event) => event.event_type === "stop");
  const trace = {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: `trace-${hashLedger(ledger)}`,
    task_id: plan.task_id,
    run_id: plan.run_id ?? null,
    harness: plan.harness ?? null,
    model: plan.model ?? null,
    repository: plan.repository ?? null,
    repository_commit: plan.repository_commit ?? null,
    policy: { name: plan.policy_name ?? "unknown", version: plan.policy_version ?? "unknown" },
    mode: plan.mode ?? null,
    completeness: hasStop ? "complete" : "partial",
    source: { format: "ledger-jsonl", source_ref: sourceRef, record_count: scopedRecords.length },
    warnings: hasStop ? [] : ["missing_stop_event"],
    events,
  };
  assertValidTrace(trace, { allowPartial: true });
  return trace;
}
