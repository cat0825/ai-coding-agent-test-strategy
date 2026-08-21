import { createHash } from "node:crypto";
import { assertValidTrace, TRACE_SCHEMA_VERSION } from "./trace.mjs";
import { analyzeTestRunnerCommand, decomposeShellCommand } from "./test-command.mjs";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_EVENTS = new Set(["turn.completed", "turn.failed"]);
const FILE_CHANGE_KINDS = new Set(["add", "delete", "update"]);

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
  for (const field of ["taskId", "runId", "harness", "repository", "repositoryCommit", "scenarioDefinitionSha256", "collectorSha256", "policyName", "policyVersion"]) {
    if (!nonEmptyString(binding[field])) throw new Error(`Trace binding requires ${field}`);
  }
  if (!["baseline", "shadow"].includes(binding.mode)) throw new Error("Trace binding mode must be baseline or shadow");
  if (!/^[a-f0-9]{40}$/i.test(binding.repositoryCommit)) throw new Error("Trace binding repositoryCommit must be a Git revision");
  if (binding.workspaceRevision !== undefined && !/^[a-f0-9]{40}$/i.test(binding.workspaceRevision)) {
    throw new Error("Trace binding workspaceRevision must be a Git revision");
  }
  if (binding.sourceTree !== undefined && !/^[a-f0-9]{40}$/i.test(binding.sourceTree)) {
    throw new Error("Trace binding sourceTree must be a Git tree ID");
  }
  for (const field of ["scenarioDefinitionSha256", "collectorSha256"]) {
    if (!/^[a-f0-9]{64}$/i.test(binding[field])) throw new Error(`Trace binding ${field} must be a SHA-256 digest`);
  }
  if (binding.initialStateSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.initialStateSha256)) {
    throw new Error("Trace binding initialStateSha256 must be a SHA-256 digest");
  }
  if (binding.finalStateSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.finalStateSha256)) {
    throw new Error("Trace binding finalStateSha256 must be a SHA-256 digest");
  }
  if (binding.postRunWorkspaceSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.postRunWorkspaceSha256)) {
    throw new Error("Trace binding postRunWorkspaceSha256 must be a SHA-256 digest");
  }
  if (binding.workspaceStateChanged !== undefined && typeof binding.workspaceStateChanged !== "boolean") {
    throw new Error("Trace binding workspaceStateChanged must be a boolean");
  }
  if (binding.sourceFormat !== undefined && !nonEmptyString(binding.sourceFormat)) {
    throw new Error("Trace binding sourceFormat must be a non-empty string");
  }
  if (binding.policyLedgerSourceRef !== undefined && !safeSourceReference(binding.policyLedgerSourceRef)) {
    throw new Error("Trace binding policyLedgerSourceRef must be a safe source reference");
  }
  if (binding.policyLedgerSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.policyLedgerSha256)) {
    throw new Error("Trace binding policyLedgerSha256 must be a SHA-256 digest");
  }
  if (binding.oracleDefinitionSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(binding.oracleDefinitionSha256)) {
    throw new Error("Trace binding oracleDefinitionSha256 must be a SHA-256 digest");
  }
  if (binding.failureSignaturesByCallId !== undefined) {
    if (!isObject(binding.failureSignaturesByCallId)) throw new Error("Trace binding failureSignaturesByCallId must be an object");
    for (const [callId, signature] of Object.entries(binding.failureSignaturesByCallId)) {
      if (!safeCallId(callId) || !nonEmptyString(signature)) throw new Error("Trace binding failureSignaturesByCallId is invalid");
    }
  }
  if (binding.policyDecisions !== undefined) {
    if (!Array.isArray(binding.policyDecisions)) throw new Error("Trace binding policyDecisions must be an array");
    for (const decision of binding.policyDecisions) {
      if (!isObject(decision) || !safeSourceReference(decision.source_ref ?? "")) {
        throw new Error("Trace binding policyDecisions contains an unsafe source reference");
      }
    }
  }
  if (binding.initialChangedFiles !== undefined) {
    if (!Array.isArray(binding.initialChangedFiles)) throw new Error("Trace binding initialChangedFiles must be an array");
    const normalized = binding.initialChangedFiles.map(normalizedChangedFile);
    if (normalized.some((file) => file === null)) throw new Error("Trace binding initialChangedFiles contains an unsafe path");
    if (new Set(normalized).size !== normalized.length) throw new Error("Trace binding initialChangedFiles must be unique");
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

function rawReference(entry, sourceRef, event = entry.record.event, kind = "agent-belt-lifecycle") {
  return {
    kind,
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

function groupStreamItems(entries, eventType, itemType = "command_execution") {
  const grouped = new Map();
  for (const entry of entries) {
    if (entry.record.type !== eventType || entry.record.item?.type !== itemType) continue;
    const callId = entry.record.item.id;
    if (!safeCallId(callId)) continue;
    if (!grouped.has(callId)) grouped.set(callId, []);
    grouped.get(callId).push(entry);
  }
  return grouped;
}

function normalizedChangedFile(value) {
  if (!nonEmptyString(value) || value.includes("\0")
    || value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.includes("..")) return null;
  const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
  return normalized || null;
}

function changeKindForPath(file) {
  const normalized = file.toLowerCase();
  const parts = normalized.split("/");
  const name = parts.at(-1);
  if (parts.some((part) => part === "fixtures" || part === "fixture" || part === "testdata")) return "fixture";
  if (parts.some((part) => part === "tests" || part === "test" || part === "__tests__")
    || /(?:^|[._-])(test|spec)\.[^.]+$/.test(name)) return "test";
  if (["package.json", "pyproject.toml", "cargo.toml", "go.mod", "tsconfig.json", "tox.ini", "pytest.ini"].includes(name)
    || /\.(?:ya?ml|toml|ini|lock)$/.test(name)) return "config";
  if (/\.(?:md|mdx|rst|txt)$/.test(name)) return "docs";
  return "code";
}

function isGeneratedRuntimeArtifact(file) {
  const parts = file.toLowerCase().split("/");
  const name = parts.at(-1);
  return parts.some((part) => ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(part))
    || /\.(?:pyc|pyo)$/.test(name);
}

function validObservedAt(value) {
  return ISO_UTC.test(value ?? "") && !Number.isNaN(Date.parse(value));
}

function observedWaitSubject(command) {
  const segments = decomposeShellCommand(command);
  if (!segments || segments.length !== 1 || segments[0].nested) return null;
  const [program, subcommand] = segments[0].tokens.map((token) => token.toLowerCase());
  if (program === "sleep" && segments[0].tokens.length === 2 && /^\d+(?:\.\d+)?$/.test(subcommand)) return "local_process";
  if (program === "gh" && subcommand === "run" && segments[0].tokens[2]?.toLowerCase() === "watch") return "remote_ci";
  return null;
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
  outcomeFilesModified = null,
}) {
  validateBinding(binding);
  if (!Array.isArray(lifecycle) || lifecycle.length === 0) throw new Error("Lifecycle evidence must be non-empty");
  if (!Array.isArray(stream) || stream.length === 0) throw new Error("Agent-belt stream must be non-empty");
  if (!safeSourceReference(lifecycleSourceRef) || !safeSourceReference(streamSourceRef)) throw new Error("Safe relative source references are required");

  const warnings = new Set();
  const stateWarnings = new Set();
  const warnState = (warning) => {
    warnings.add(warning);
    stateWarnings.add(warning);
  };
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
  if (collector.record.collector_sha256 !== binding.collectorSha256) warnState("collector_digest_mismatch");
  if (collector.record.collector_version !== "2") warnState("collector_version_mismatch");
  const cwdSha256 = collector.record.cwd_sha256;
  if (!/^[a-f0-9]{64}$/i.test(cwdSha256 ?? "")) warnState("missing_collector_cwd_digest");
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
  const pairedCommands = [];

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
    const analysis = analyzeTestRunnerCommand(rawStarts[0].record.item.command, { cwdSha256 });
    if (analysis && analysis.semantics.complete !== true) {
      warnings.add(`incomplete_command_semantics:${callId}:${analysis.semantics.reason}`);
    }
    pairedCommands.push({
      callId,
      start,
      completion,
      rawStart: rawStarts[0],
      rawCompletion: rawCompletions[0],
      analysis,
      durationMs: (completion.record.monotonic_ns - start.record.monotonic_ns) / 1_000_000,
      exitCode: lifecycleExit,
    });
  }

  const lifecycleFileChanges = groupEvents(lifecycle, "file_change.completed");
  const streamFileChanges = groupStreamItems(stream, "item.completed", "file_change");
  if (lifecycle.some(({ record }) => record.event === "file_change.completed" && !safeCallId(record.call_id))) {
    warnState("unsafe_file_change_call_id");
  }
  if (stream.some(({ record }) => record.type === "item.completed"
    && record.item?.type === "file_change" && !safeCallId(record.item.id))) {
    warnState("unsafe_stream_file_change_call_id");
  }
  const fileChangeIds = new Set([...lifecycleFileChanges.keys(), ...streamFileChanges.keys()]);
  const pairedFileChanges = [];
  for (const callId of [...fileChangeIds].sort()) {
    const observed = lifecycleFileChanges.get(callId) ?? [];
    const raw = streamFileChanges.get(callId) ?? [];
    if (observed.length !== 1) warnState(`${observed.length === 0 ? "missing" : "duplicate"}_file_change_lifecycle:${callId}`);
    if (raw.length !== 1) warnState(`${raw.length === 0 ? "missing" : "duplicate"}_file_change_stream:${callId}`);
    if (observed.length !== 1 || raw.length !== 1) continue;

    const entry = observed[0];
    const streamEntry = raw[0];
    if (entry.record.status !== streamEntry.record.item.status
      || !["completed", "failed"].includes(entry.record.status)) {
      warnState(`file_change_status_mismatch:${callId}`);
      continue;
    }
    const changes = entry.record.changes;
    const streamChanges = streamEntry.record.item.changes;
    if (!Array.isArray(changes) || !Array.isArray(streamChanges) || changes.length !== streamChanges.length) {
      warnState(`file_change_count_mismatch:${callId}`);
      continue;
    }
    const sanitized = [];
    let valid = true;
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      const streamChange = streamChanges[index];
      if (!isObject(change) || !isObject(streamChange)
        || normalizedChangedFile(change.path) !== change.path
        || !FILE_CHANGE_KINDS.has(change.kind)
        || streamChange.kind !== change.kind) {
        warnState(`invalid_file_change:${callId}:${index}`);
        valid = false;
        continue;
      }
      const streamPath = normalizedChangedFile(streamChange.path);
      if (streamPath && streamPath !== change.path) {
        warnState(`file_change_path_mismatch:${callId}:${index}`);
        valid = false;
        continue;
      }
      sanitized.push({ path: change.path, kind: change.kind });
    }
    if (!valid) continue;
    pairedFileChanges.push({
      callId,
      entry,
      streamEntry,
      status: entry.record.status,
      changes: sanitized,
    });
  }
  // Codex only emits file_change items for apply_patch. When the agent writes a
  // file through a shell redirect the stream stays silent, so the collector
  // attributes a before/after workspace snapshot diff to the owning command.
  // These records have no stream counterpart by construction and are therefore
  // validated on their own terms rather than through two-channel pairing.
  const shellFileChanges = [];
  const commandsByCallId = new Map(pairedCommands.map((command) => [command.callId, command]));
  for (const entry of lifecycle) {
    if (entry.record.event !== "shell_file_change.completed") continue;
    const callId = entry.record.call_id;
    if (!safeCallId(callId)) {
      warnState("unsafe_shell_file_change_call_id");
      continue;
    }
    if (entry.record.complete !== true) {
      warnState(`incomplete_shell_file_change_snapshot:${callId}`);
      continue;
    }
    const command = commandsByCallId.get(callId);
    if (!command) {
      warnState(`shell_file_change_without_command:${callId}`);
      continue;
    }
    if (entry.record.status !== command.completion.record.status) {
      warnState(`shell_file_change_status_mismatch:${callId}`);
      continue;
    }
    const changes = entry.record.changes;
    if (!Array.isArray(changes)) {
      warnState(`invalid_shell_file_change:${callId}`);
      continue;
    }
    const sanitized = [];
    let valid = true;
    for (const [index, change] of changes.entries()) {
      if (!isObject(change)
        || normalizedChangedFile(change.path) !== change.path
        || !FILE_CHANGE_KINDS.has(change.kind)) {
        warnState(`invalid_shell_file_change:${callId}:${index}`);
        valid = false;
        continue;
      }
      sanitized.push({ path: change.path, kind: change.kind });
    }
    if (!valid) continue;
    if (sanitized.length === 0) continue;
    shellFileChanges.push({
      callId,
      entry,
      streamEntry: command.rawCompletion,
      status: entry.record.status,
      changes: sanitized,
    });
  }

  const observedStateChange = pairedFileChanges.some(({ status, changes }) => status === "completed" && changes.length > 0)
    || shellFileChanges.some(({ status, changes }) => status === "completed" && changes.length > 0);
  if (binding.workspaceStateChanged === true && !observedStateChange) {
    warnState("workspace_state_changed_without_observed_file_change");
  }

  let outcomeFileCount = 0;
  let ignoredGeneratedFileCount = 0;
  if (!Array.isArray(outcomeFilesModified)) {
    warnState("missing_outcome_file_manifest");
  } else {
    const outcomeFiles = new Set();
    for (const [index, file] of outcomeFilesModified.entries()) {
      const normalized = normalizedChangedFile(file);
      if (!normalized) {
        warnState(`invalid_outcome_file:${index}`);
        continue;
      }
      outcomeFiles.add(normalized);
    }
    outcomeFileCount = outcomeFiles.size;
    const relevantOutcomeFiles = new Set([...outcomeFiles].filter((file) => {
      if (!isGeneratedRuntimeArtifact(file)) return true;
      ignoredGeneratedFileCount += 1;
      return false;
    }));
    const observedFiles = new Set([...pairedFileChanges, ...shellFileChanges]
      .filter(({ status }) => status === "completed")
      .flatMap(({ changes }) => changes.map(({ path: file }) => file)));
    for (const file of relevantOutcomeFiles) {
      if (!observedFiles.has(file)) warnState(`outcome_file_not_observed:${sha256(file).slice(0, 16)}`);
    }
    for (const file of observedFiles) {
      if (!relevantOutcomeFiles.has(file)) warnState(`observed_file_not_in_outcome:${sha256(file).slice(0, 16)}`);
    }
  }

  const terminals = lifecycle.filter(({ record }) => TERMINAL_EVENTS.has(record.event));
  if (terminals.length === 0) warnings.add("missing_terminal_event");
  if (terminals.length > 1) warnings.add("duplicate_terminal_event");
  const terminal = terminals[0] ?? null;
  if (terminal && !stream.some(({ record }) => record.type === terminal.record.event)) warnings.add("terminal_stream_event_missing");
  if (lifecycle.some(({ record }) => record.event === "stream.invalid_json")) warnings.add("invalid_stream_event");

  const bootstrapMonotonic = Number.isInteger(bootstrap.record.monotonic_ns) ? bootstrap.record.monotonic_ns : 0;
  const terminalMonotonic = terminal?.record.monotonic_ns;
  const usableCommands = pairedCommands
    .filter((command) => {
      if (command.completion.record.monotonic_ns < bootstrapMonotonic) {
        warnings.add(`command_precedes_turn:${command.callId}`);
        return false;
      }
      if (Number.isInteger(terminalMonotonic) && command.completion.record.monotonic_ns > terminalMonotonic) {
        warnings.add(`command_follows_terminal:${command.callId}`);
        return false;
      }
      return validObservedAt(command.completion.record.observed_at);
    })
    .sort((left, right) => left.completion.record.monotonic_ns - right.completion.record.monotonic_ns);
  const usableResults = usableCommands
    .filter((command) => command.analysis !== null)
    .map((command) => ({
      ...command,
      command: command.analysis.command,
      canonicalId: command.analysis.canonicalId,
      semantics: command.analysis.semantics,
    }));
  const usableShellFileChanges = shellFileChanges
    .filter((change) => {
      if (change.entry.record.monotonic_ns < bootstrapMonotonic) {
        warnState(`shell_file_change_precedes_turn:${change.callId}`);
        return false;
      }
      if (Number.isInteger(terminalMonotonic) && change.entry.record.monotonic_ns > terminalMonotonic) {
        warnState(`shell_file_change_follows_terminal:${change.callId}`);
        return false;
      }
      return validObservedAt(change.entry.record.observed_at);
    })
    .sort((left, right) => left.entry.record.monotonic_ns - right.entry.record.monotonic_ns);

  const usableFileChanges = pairedFileChanges
    .filter((change) => {
      if (change.entry.record.monotonic_ns < bootstrapMonotonic) {
        warnState(`file_change_precedes_turn:${change.callId}`);
        return false;
      }
      if (Number.isInteger(terminalMonotonic) && change.entry.record.monotonic_ns > terminalMonotonic) {
        warnState(`file_change_follows_terminal:${change.callId}`);
        return false;
      }
      return validObservedAt(change.entry.record.observed_at);
    })
    .sort((left, right) => left.entry.record.monotonic_ns - right.entry.record.monotonic_ns);

  const initialChangedFiles = [...(binding.initialChangedFiles ?? [])].sort();
  const rawEventKind = binding.sourceFormat === "codex-cli-lifecycle-v2"
    ? "codex-cli-lifecycle"
    : "agent-belt-lifecycle";
  const initialStateId = sha256(JSON.stringify({
    repository_commit: binding.repositoryCommit,
    changed_files: initialChangedFiles,
    workspace_state_sha256: binding.initialStateSha256 ?? null,
  }));
  const events = [
    {
      event_index: 0,
      event_type: "diff",
      timestamp: bootstrap.record.observed_at,
      data: {
        changed_files: initialChangedFiles,
        repository_commit: binding.repositoryCommit,
        state_id: initialStateId,
        change_kinds: [...new Set(initialChangedFiles.map(changeKindForPath))].sort(),
        observation: initialChangedFiles.length === 0 ? "pinned_repository_state" : "materialized_task_state",
      },
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event, rawEventKind),
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
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event, rawEventKind),
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
        selection_source: binding.sourceFormat === "codex-cli-lifecycle-v2"
          ? "observed_verification_calls"
          : "observed_test_runner_calls",
      },
      raw_event_ref: rawReference(bootstrap, lifecycleSourceRef, bootstrap.record.event, rawEventKind),
    },
  ];

  const observedWaits = usableCommands
    .map((command) => ({ ...command, subject: observedWaitSubject(command.rawStart.record.item.command) }))
    .filter((command) => command.subject !== null && command.durationMs > 0);
  const observedWaitCallIds = new Set(observedWaits.map(({ callId }) => callId));

  const firstResultMonotonic = usableResults[0]?.completion.record.monotonic_ns ?? null;
  const lastResultMonotonic = usableResults.at(-1)?.completion.record.monotonic_ns ?? null;
  const bootstrapObservedMs = Date.parse(bootstrap.record.observed_at);
  const policyDecisionMonotonic = (decision) => bootstrapMonotonic
    + Math.round((Date.parse(decision.observed_at) - bootstrapObservedMs) * 1_000_000);
  // A non-test command whose workspace effect was snapshotted is no longer opaque,
  // so it must not collapse the observed state into unknown.
  const snapshotObservedCallIds = new Set(usableShellFileChanges.map(({ callId }) => callId));
  const unknownStateCommands = usableCommands.filter((command) => command.analysis === null
    && !snapshotObservedCallIds.has(command.callId)
    && !observedWaitCallIds.has(command.callId)
    && firstResultMonotonic !== null
    && command.completion.record.monotonic_ns > firstResultMonotonic
    && command.completion.record.monotonic_ns < lastResultMonotonic);
  const activities = [
    ...usableResults.map((result) => ({
      kind: "test_result",
      monotonicNs: result.completion.record.monotonic_ns,
      value: result,
    })),
    ...usableFileChanges
      .filter((change) => change.status === "completed" && change.changes.length > 0)
      .map((change) => ({
        kind: "file_change",
        monotonicNs: change.entry.record.monotonic_ns,
        value: change,
      })),
    ...usableShellFileChanges
      .filter((change) => change.status === "completed" && change.changes.length > 0)
      .map((change) => ({
        kind: "shell_file_change",
        monotonicNs: change.entry.record.monotonic_ns,
        value: change,
      })),
    ...observedWaits.map((wait) => ({
      kind: "wait",
      monotonicNs: wait.completion.record.monotonic_ns,
      value: wait,
    })),
    ...unknownStateCommands.map((command) => ({
      kind: "unknown_state",
      monotonicNs: command.completion.record.monotonic_ns,
      value: command,
    })),
    ...(binding.policyDecisions ?? []).map((decision) => ({
      kind: "policy_decision",
      monotonicNs: policyDecisionMonotonic(decision),
      value: decision,
    })),
  ].sort((left, right) => left.monotonicNs - right.monotonicNs
    || Number(left.kind === "test_result") - Number(right.kind === "test_result"));

  let observedStateId = events[0].data.state_id;
  for (const activity of activities) {
    if (activity.kind === "policy_decision") {
      const decision = activity.value;
      events.push({
        event_index: events.length,
        event_type: "policy_decision",
        timestamp: decision.observed_at,
        data: {
          decision: decision.decision,
          reason_code: decision.reason_code,
          tier: decision.tier ?? null,
          canonical_command_id: decision.canonical_command_id ?? null,
          command_semantic_sha256: decision.command_semantic_sha256 ?? null,
          budget: {
            test_executions: decision.budget?.test_executions ?? 0,
            immediate_duration_ms: decision.budget?.immediate_duration_ms ?? 0,
            agent_turns: decision.budget?.agent_turns ?? 0,
            failed_test_turns: decision.budget?.failed_test_turns ?? 0,
          },
        },
        raw_event_ref: {
          kind: "verification-policy-ledger",
          line: Number.isInteger(decision.source_line) ? decision.source_line : 1,
          event: decision.event ?? "policy.decision",
          source_ref: decision.source_ref,
        },
      });
      continue;
    }
    if (activity.kind === "wait") {
      const wait = activity.value;
      events.push({
        event_index: events.length,
        event_type: "wait",
        timestamp: wait.completion.record.observed_at,
        data: {
          subject: wait.subject,
          duration_ms: wait.durationMs,
          observed: true,
          subject_ref_sha256: null,
        },
        raw_event_ref: {
          ...rawReference(wait.completion, lifecycleSourceRef, wait.completion.record.event, rawEventKind),
          call_id: wait.callId,
          stream_source_ref: streamSourceRef,
          stream_start_line: wait.rawStart.line,
          stream_completion_line: wait.rawCompletion.line,
        },
      });
      continue;
    }
    if (activity.kind === "shell_file_change") {
      const change = activity.value;
      observedStateId = observedStateId === null ? null : sha256(JSON.stringify({
        previous_state_id: observedStateId,
        changes: change.changes,
      }));
      events.push({
        event_index: events.length,
        event_type: "diff",
        timestamp: change.entry.record.observed_at,
        data: {
          changed_files: [...new Set(change.changes.map(({ path: file }) => file))].sort(),
          repository_commit: binding.repositoryCommit,
          state_id: observedStateId,
          change_kinds: [...new Set(change.changes.map(({ path: file }) => changeKindForPath(file)))].sort(),
          observation: "completed_shell_file_change",
        },
        raw_event_ref: {
          ...rawReference(change.entry, lifecycleSourceRef, change.entry.record.event, rawEventKind),
          call_id: change.callId,
          stream_source_ref: streamSourceRef,
          stream_completion_line: change.streamEntry.line,
        },
      });
      continue;
    }
    if (activity.kind === "file_change") {
      const change = activity.value;
      observedStateId = observedStateId === null ? null : sha256(JSON.stringify({
        previous_state_id: observedStateId,
        changes: change.changes,
      }));
      events.push({
        event_index: events.length,
        event_type: "diff",
        timestamp: change.entry.record.observed_at,
        data: {
          changed_files: [...new Set(change.changes.map(({ path: file }) => file))].sort(),
          repository_commit: binding.repositoryCommit,
          state_id: observedStateId,
          change_kinds: [...new Set(change.changes.map(({ path: file }) => changeKindForPath(file)))].sort(),
          observation: "completed_file_change",
        },
        raw_event_ref: {
          ...rawReference(change.entry, lifecycleSourceRef, change.entry.record.event, rawEventKind),
          call_id: change.callId,
          stream_source_ref: streamSourceRef,
          stream_completion_line: change.streamEntry.line,
        },
      });
      continue;
    }
    if (activity.kind === "unknown_state") {
      const command = activity.value;
      observedStateId = null;
      events.push({
        event_index: events.length,
        event_type: "diff",
        timestamp: command.completion.record.observed_at,
        data: {
          changed_files: [],
          repository_commit: binding.repositoryCommit,
          state_id: null,
          change_kinds: [],
          observation: "unknown_after_non_test_command",
        },
        raw_event_ref: {
          ...rawReference(command.completion, lifecycleSourceRef, command.completion.record.event, rawEventKind),
          call_id: command.callId,
          stream_source_ref: streamSourceRef,
          stream_start_line: command.rawStart.line,
          stream_completion_line: command.rawCompletion.line,
        },
      });
      continue;
    }

    const result = activity.value;
    events.push({
      event_index: events.length,
      event_type: "test_result",
      timestamp: result.completion.record.observed_at,
      data: {
        canonical_command_id: result.canonicalId,
        command: result.command,
        command_semantics: result.semantics,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        signal: null,
        failure_signature: binding.failureSignaturesByCallId?.[result.callId] ?? null,
        failure_class: null,
        override: null,
      },
      raw_event_ref: {
        ...rawReference(result.completion, lifecycleSourceRef, result.completion.record.event, rawEventKind),
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
      raw_event_ref: rawReference(terminal, lifecycleSourceRef, terminal.record.event, rawEventKind),
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
    policy: { name: binding.policyName, version: binding.policyVersion },
    mode: binding.mode,
    completeness: complete ? "complete" : "partial",
    source: {
      format: binding.sourceFormat ?? "agent-belt-codex-lifecycle-v2",
      record_count: lifecycle.length + stream.length + (binding.policyDecisions?.length ?? 0),
      lifecycle_source_ref: lifecycleSourceRef,
      lifecycle_sha256: lifecycleDigest,
      stream_source_ref: streamSourceRef,
      stream_sha256: streamDigest,
      ...(binding.policyLedgerSourceRef === undefined ? {} : { policy_ledger_source_ref: binding.policyLedgerSourceRef }),
      ...(binding.policyLedgerSha256 === undefined ? {} : { policy_ledger_sha256: binding.policyLedgerSha256 }),
      outcome_sha256: outcomeSha256,
      scenario_definition_sha256: binding.scenarioDefinitionSha256,
      ...(binding.oracleDefinitionSha256 === undefined ? {} : { oracle_definition_sha256: binding.oracleDefinitionSha256 }),
      collector_sha256: binding.collectorSha256,
      ...(binding.workspaceRevision === undefined ? {} : { workspace_revision: binding.workspaceRevision }),
      ...(binding.sourceTree === undefined ? {} : { source_tree: binding.sourceTree }),
      initial_workspace_state_sha256: binding.initialStateSha256 ?? null,
      final_workspace_state_sha256: binding.finalStateSha256 ?? null,
      post_run_workspace_sha256: binding.postRunWorkspaceSha256 ?? null,
      workspace_state_changed: binding.workspaceStateChanged ?? null,
      initial_changed_files: initialChangedFiles.length,
      state_evidence_complete: stateWarnings.size === 0,
      outcome_files_modified: outcomeFileCount,
      ignored_generated_files: ignoredGeneratedFileCount,
    },
    warnings: warningList,
    events,
  };
  assertValidTrace(trace, { allowPartial: true });
  return trace;
}
