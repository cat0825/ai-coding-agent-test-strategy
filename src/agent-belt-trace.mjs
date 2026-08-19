import { createHash } from "node:crypto";
import { assertValidTrace, TRACE_SCHEMA_VERSION } from "./trace.mjs";
import { canonicalTestCommandId, normalizeTestRunnerCommand } from "./test-command.mjs";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_EVENTS = new Set(["turn.completed", "turn.failed"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeCallId(value) {
  return nonEmptyString(value) && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function safeSourceReference(value) {
  if (!nonEmptyString(value) || value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateBinding(binding) {
  if (!isObject(binding)) throw new Error("Trace binding must be an object");
  for (const field of ["taskId", "runId", "harness", "repository", "repositoryCommit", "scenarioDefinitionSha256", "collectorSha256"]) {
    if (!nonEmptyString(binding[field])) throw new Error(`Trace binding requires ${field}`);
  }
  if (!/^[a-f0-9]{40}$/i.test(binding.repositoryCommit)) throw new Error("Trace binding repositoryCommit must be a Git revision");
  for (const field of ["scenarioDefinitionSha256", "collectorSha256"]) {
    if (!/^[a-f0-9]{64}$/i.test(binding[field])) throw new Error(`Trace binding ${field} must be a SHA-256 digest`);
  }
}

export function parseNdjson(contents, label = "NDJSON") {
  if (typeof contents !== "string") throw new Error(`${label} must be text`);
  const records = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON`);
    }
    if (!isObject(record)) throw new Error(`${label} line ${index + 1} must be an object`);
    records.push({ line: index + 1, record });
  }
  if (records.length === 0) throw new Error(`${label} must contain at least one record`);
  return records;
}

function rawReference(entry, sourceRef, event = entry.record.event) {
  return {
    kind: "agent-belt-lifecycle",
    line: entry.line,
    event,
    source_ref: sourceRef,
  };
}

function groupEvents(entries, eventType) {
  const grouped = new Map();
  for (const entry of entries) {
    if (entry.record.event !== eventType) continue;
    const callId = entry.record.call_id;
    if (!safeCallId(callId)) continue;
    if (!grouped.has(callId)) grouped.set(callId, []);
    grouped.get(callId).push(entry);
  }
  return grouped;
}

function groupStreamItems(entries, eventType) {
  const grouped = new Map();
  for (const entry of entries) {
    if (entry.record.type !== eventType || entry.record.item?.type !== "command_execution") continue;
    const callId = entry.record.item.id;
    if (!safeCallId(callId)) continue;
    if (!grouped.has(callId)) grouped.set(callId, []);
    grouped.get(callId).push(entry);
  }
  return grouped;
}

function validObservedAt(value) {
  return ISO_UTC.test(value ?? "") && !Number.isNaN(Date.parse(value));
}

function commandList(results) {
  const commands = new Map();
  for (const result of results) commands.set(result.canonicalId, { id: result.canonicalId, argv: result.command });
  return [...commands.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function firstEntry(entries, predicate) {
  return entries.find(({ record }) => predicate(record)) ?? null;
}

export function convertAgentBeltLifecycleToTrace({
  lifecycle,
  stream,
  binding,
  lifecycleSourceRef,
  streamSourceRef,
  lifecycleContents = null,
  streamContents = null,
  outcomeSha256 = null,
}) {
  validateBinding(binding);
  if (!Array.isArray(lifecycle) || lifecycle.length === 0) throw new Error("Lifecycle evidence must be non-empty");
  if (!Array.isArray(stream) || stream.length === 0) throw new Error("Agent-belt stream must be non-empty");
  if (!safeSourceReference(lifecycleSourceRef) || !safeSourceReference(streamSourceRef)) throw new Error("Safe relative source references are required");

  const warnings = new Set();
  let previousMonotonic = -1;
  let previousTimestamp = -1;
  lifecycle.forEach((entry, index) => {
    const record = entry.record;
    if (record.schema_version !== 1) warnings.add("unsupported_lifecycle_schema");
    if (record.sequence !== index) warnings.add("lifecycle_sequence_reordered");
    if (!Number.isInteger(record.monotonic_ns) || record.monotonic_ns < 0) {
      warnings.add("invalid_monotonic_time");
    } else {
      if (record.monotonic_ns < previousMonotonic) warnings.add("lifecycle_monotonic_reordered");
      previousMonotonic = record.monotonic_ns;
    }
    if (!validObservedAt(record.observed_at)) {
      warnings.add("invalid_utc_timestamp");
    } else {
      const timestamp = Date.parse(record.observed_at);
      if (timestamp < previousTimestamp) warnings.add("lifecycle_utc_reordered");
      previousTimestamp = timestamp;
    }
  });

  const collector = firstEntry(lifecycle, (record) => record.event === "collector.started");
  if (!collector) throw new Error("Lifecycle evidence is missing collector.started");
  if (collector.record.collector_sha256 !== binding.collectorSha256) warnings.add("collector_digest_mismatch");
  if (collector.record.collector_version !== "1") warnings.add("collector_version_mismatch");
  const turnStartedEntries = lifecycle.filter(({ record }) => record.event === "turn.started");
  if (turnStartedEntries.length === 0) warnings.add("missing_turn_started");
  if (turnStartedEntries.length > 1) warnings.add("duplicate_turn_started");
  const bootstrap = turnStartedEntries[0] ?? collector;
  if (!validObservedAt(bootstrap.record.observed_at)) throw new Error("Lifecycle evidence has no usable bootstrap timestamp");

  const threadEntry = firstEntry(lifecycle, (record) => record.event === "thread.started");
  const streamThread = firstEntry(stream, (record) => record.type === "thread.started");
  if (!threadEntry || !streamThread || threadEntry.record.thread_id !== streamThread.record.thread_id) {
    warnings.add("thread_identity_mismatch");
  }

  const starts = groupEvents(lifecycle, "item.started");
  const completions = groupEvents(lifecycle, "item.completed");
  const streamStarts = groupStreamItems(stream, "item.started");
  const streamCompletions = groupStreamItems(stream, "item.completed");
  if (lifecycle.some(({ record }) => ["item.started", "item.completed"].includes(record.event) && !safeCallId(record.call_id))) {
    warnings.add("unsafe_lifecycle_call_id");
  }
  if (stream.some(({ record }) => ["item.started", "item.completed"].includes(record.type)
    && record.item?.type === "command_execution" && !safeCallId(record.item.id))) {
    warnings.add("unsafe_stream_call_id");
  }
  const callIds = new Set([...starts.keys(), ...completions.keys(), ...streamStarts.keys(), ...streamCompletions.keys()]);
  const pairedResults = [];

  for (const callId of [...callIds].sort()) {
    const callStarts = starts.get(callId) ?? [];
    const callCompletions = completions.get(callId) ?? [];
    const rawStarts = streamStarts.get(callId) ?? [];
    const rawCompletions = streamCompletions.get(callId) ?? [];
    if (callStarts.length === 0) warnings.add(`missing_command_start:${callId}`);
    if (callCompletions.length === 0) warnings.add(`missing_command_completion:${callId}`);
    if (callStarts.length > 1) warnings.add(`duplicate_command_start:${callId}`);
    if (callCompletions.length > 1) warnings.add(`duplicate_command_completion:${callId}`);
    if (rawStarts.length !== 1) warnings.add(`${rawStarts.length === 0 ? "missing" : "duplicate"}_stream_start:${callId}`);
    if (rawCompletions.length !== 1) warnings.add(`${rawCompletions.length === 0 ? "missing" : "duplicate"}_stream_completion:${callId}`);
    if (callStarts.length !== 1 || callCompletions.length !== 1 || rawStarts.length !== 1 || rawCompletions.length !== 1) continue;

    const start = callStarts[0];
    const completion = callCompletions[0];
    if (completion.line <= start.line || completion.record.monotonic_ns < start.record.monotonic_ns) {
      warnings.add(`command_events_reordered:${callId}`);
      continue;
    }
    const lifecycleExit = completion.record.exit_code;
    const streamExit = rawCompletions[0].record.item.exit_code;
    if (!Number.isInteger(lifecycleExit) || !Number.isInteger(streamExit) || lifecycleExit !== streamExit) {
      warnings.add(`command_exit_code_mismatch:${callId}`);
      continue;
    }
    const normalized = normalizeTestRunnerCommand(rawStarts[0].record.item.command);
    if (!normalized) continue;
    pairedResults.push({
      callId,
      start,
      completion,
      rawStart: rawStarts[0],
      rawCompletion: rawCompletions[0],
      command: normalized,
      canonicalId: canonicalTestCommandId(normalized),
      durationMs: (completion.record.monotonic_ns - start.record.monotonic_ns) / 1_000_000,
      exitCode: lifecycleExit,
    });
  }

  const terminals = lifecycle.filter(({ record }) => TERMINAL_EVENTS.has(record.event));
  if (terminals.length === 0) warnings.add("missing_terminal_event");
  if (terminals.length > 1) warnings.add("duplicate_terminal_event");
  const terminal = terminals[0] ?? null;
  if (terminal && !stream.some(({ record }) => record.type === terminal.record.event)) warnings.add("terminal_stream_event_missing");
  if (lifecycle.some(({ record }) => record.event === "stream.invalid_json")) warnings.add("invalid_stream_event");

  const bootstrapMonotonic = Number.isInteger(bootstrap.record.monotonic_ns) ? bootstrap.record.monotonic_ns : 0;
  const terminalMonotonic = terminal?.record.monotonic_ns;
  const usableResults = pairedResults
    .filter((result) => {
      if (result.completion.record.monotonic_ns < bootstrapMonotonic) {
        warnings.add(`test_result_precedes_turn:${result.callId}`);
        return false;
      }
      if (Number.isInteger(terminalMonotonic) && result.completion.record.monotonic_ns > terminalMonotonic) {
        warnings.add(`test_result_follows_terminal:${result.callId}`);
        return false;
      }
      return validObservedAt(result.completion.record.observed_at);
    })
    .sort((left, right) => left.completion.record.monotonic_ns - right.completion.record.monotonic_ns);

  const events = [
    {
      event_index: 0,
      event_type: "diff",
      timestamp: bootstrap.record.observed_at,
      data: {
        changed_files: [],
        repository_commit: binding.repositoryCommit,
        state_id: binding.scenarioDefinitionSha256,
        change_kinds: [],
      },
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event),
    },
    {
      event_index: 1,
      event_type: "risk",
      timestamp: bootstrap.record.observed_at,
      data: {
        risk_level: "standard",
        reasons: ["baseline_unmanaged_agent"],
        fallback: true,
      },
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event),
    },
    {
      event_index: 2,
      event_type: "test_selection",
      timestamp: bootstrap.record.observed_at,
      data: {
        requested_phase: "affected",
        selected_phase: "affected",
        affected_workspaces: [],
        commands: commandList(usableResults),
        selection_source: "observed_test_runner_calls",
      },
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event),
    },
  ];

  for (const result of usableResults) {
    events.push({
      event_index: events.length,
      event_type: "test_result",
      timestamp: result.completion.record.observed_at,
      data: {
        canonical_command_id: result.canonicalId,
        command: result.command,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        signal: null,
        failure_signature: null,
        failure_class: null,
        override: null,
      },
      raw_event_ref: {
        ...rawReference(result.completion, lifecycleSourceRef),
        call_id: result.callId,
        start_line: result.start.line,
        stream_source_ref: streamSourceRef,
        stream_start_line: result.rawStart.line,
        stream_completion_line: result.rawCompletion.line,
      },
    });
  }

  if (terminal && validObservedAt(terminal.record.observed_at)) {
    events.push({
      event_index: events.length,
      event_type: "stop",
      timestamp: terminal.record.observed_at,
      data: {
        status: terminal.record.event === "turn.completed" ? "completed" : "failed",
        reason: terminal.record.event === "turn.completed" ? "observed_turn_completed" : "observed_turn_failed",
      },
      raw_event_ref: rawReference(terminal, lifecycleSourceRef),
    });
  }

  const warningList = [...warnings].sort();
  const complete = warningList.length === 0 && events.at(-1)?.event_type === "stop";
  const lifecycleDigest = lifecycleContents === null ? sha256(JSON.stringify(lifecycle)) : sha256(lifecycleContents);
  const streamDigest = streamContents === null ? sha256(JSON.stringify(stream)) : sha256(streamContents);
  const traceIdentity = sha256(JSON.stringify({ binding, lifecycleDigest, streamDigest, outcomeSha256 }));
  const trace = {
    schema_version: TRACE_SCHEMA_VERSION,
    trace_id: `trace-${traceIdentity}`,
    task_id: binding.taskId,
    run_id: binding.runId,
    harness: binding.harness,
    model: binding.model ?? null,
    repository: binding.repository,
    repository_commit: binding.repositoryCommit,
    policy: { name: "unmanaged-coding-agent-baseline", version: "1" },
    mode: "baseline",
    completeness: complete ? "complete" : "partial",
    source: {
      format: "agent-belt-codex-lifecycle-v1",
      record_count: lifecycle.length + stream.length,
      lifecycle_source_ref: lifecycleSourceRef,
      lifecycle_sha256: lifecycleDigest,
      stream_source_ref: streamSourceRef,
      stream_sha256: streamDigest,
      outcome_sha256: outcomeSha256,
      scenario_definition_sha256: binding.scenarioDefinitionSha256,
      collector_sha256: binding.collectorSha256,
    },
    warnings: warningList,
    events,
  };
  assertValidTrace(trace, { allowPartial: true });
  return trace;
}
