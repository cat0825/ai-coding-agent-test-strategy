# Agent-belt timestamped VerifyTrace collection

Issue #28 requires observed shell lifecycle evidence. Agent-belt 0.2.1 retains Codex NDJSON events, but its `TurnOutput` and `turn_N_stream.ndjson` do not retain the arrival time of each `item.started`, `item.completed`, or terminal event. Existing outcomes therefore cannot be upgraded after the fact.

## Integration decision

The implementation is a pinned local collector, not an agent-belt fork. `scripts/codex-lifecycle-wrapper.py` is copied into a private bin directory and placed before the real Codex binary on `PATH`. It forwards Codex stdout unchanged while synchronously recording a separate lifecycle sidecar. The collector digest is written into every sidecar and bound into every generated trace. Agent-belt remains pinned to the already qualified revision `90bd105b172adc41394f458e33b653dda2b199b0`.

The wrapper configuration is adjacent to the copied executable. This avoids `--allow-full-env` and does not introduce a collector environment variable into the agent process. The local configuration contains the real binary and output paths, so it belongs under ignored temporary storage and is never trace evidence.

## Collection

Prepare a private wrapper directory and lifecycle directory:

```sh
npm run benchmark:trace:prepare -- \
  --real-codex /opt/homebrew/bin/codex \
  --bin-dir /private/path/to/collector-bin \
  --lifecycle-dir /private/path/to/lifecycle
```

Run the pinned agent-belt evaluation with that directory first on `PATH`, streaming enabled, `--trials 1`, and an isolated outcomes directory. Do not use `--allow-full-env`:

```sh
PATH=/private/path/to/collector-bin:$PATH \
  uv run belt eval /path/to/scenarios \
  --agent codex --modes rules --allow-external-working-dir \
  --strict --strict-config --workers 1 --progress plain \
  --outcomes-dir /private/path/to/outcomes
```

Convert the run after agent-belt has written its benchmark card, streams, and structured outcomes:

```sh
npm run benchmark:trace -- \
  --run /private/path/to/outcomes/run-id \
  --lifecycle-dir /private/path/to/lifecycle \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output-dir /private/path/to/traces
```

Lifecycle files are matched to scenario streams by the observed Codex thread id. The converter rejects repeated trials, disabled streaming, an unqualified or dirty environment, and a run revision that differs from the environment manifest.

## Evidence boundary

Collector v2 retains collector version/digest, a digest of the starting working directory, sequence number, UTC observation time, monotonic elapsed nanoseconds, lifecycle event type, command call id, status, exit code, and completed file-change metadata. File paths are reduced to safe workspace-relative paths; an unsafe or outside-workspace path is replaced by a digest and makes the generated trace partial. The sidecar does not retain command text, command output, usage, reply text, raw working directories, environment values, or credentials.

The converter reads command text only from the existing private agent-belt stream. Public traces retain the runner identity plus SHA-256 digests for working directory, environment assignments, arguments, and the combined command semantics. The raw values are not copied. Commands with different targets, environment assignments, or working directories therefore do not share a canonical id.

Completed file changes are matched to the stream by call id, status, count, and change kind, then inserted into the trace at their observed lifecycle time. Their state id chains from the pinned repository state. A non-test shell command between two test results creates an unknown state boundary because the collector cannot prove that the command was read-only. The trace binds the qualified repository revision, run id, scenario definition digest, collector digest, source digests, and `mode: baseline`.

The converter also compares the union of completed file-change paths with the outcome's final `files_modified` list. A meaningful source/test/config file present on only one side makes the trace partial. Generated Python caches (`__pycache__`, `.pyc`, pytest/mypy/ruff caches) are counted separately and ignored for this comparison because they are runtime byproducts, not product edits.

`test_result.duration_ms` is the difference between the observed monotonic completion and start values. A `stop` event is emitted only for an observed `turn.completed` or `turn.failed`. It is never inferred from the final response or process exit.

## Fail-closed rules

Missing start, missing completion, missing terminal, duplicate call ids, reordered events, thread mismatch, source mismatch, exit-code mismatch, incomplete command semantics, or unmatched/unsafe file-change evidence makes the trace `partial`. Unpaired calls do not produce a synthetic `test_result`; no zero duration is filled in. A missing terminal never produces a `stop`. Partial traces validate only with `allowPartial: true` and remain quality-claim-ineligible.

Legacy collector-v1 traces remain readable, but they do not contain the state and command-semantic evidence required for `exact_repeat` or `unattributed_retry`. Diagnostics therefore emit neither label for those traces. They must be recollected with collector v2 before they can support repetition or efficiency claims.

The baseline trace uses a disclosed `unmanaged-coding-agent-baseline` policy envelope. Its `test_selection.commands` are a retrospective list of observed test-runner calls, marked by `selection_source: observed_test_runner_calls`; it is not presented as a policy decision made before execution.
