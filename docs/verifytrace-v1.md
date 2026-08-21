# VerifyTrace v1

VerifyTrace is the replay contract for the Observatory. It represents observed verification behavior as an ordered event stream. The converter must preserve source evidence and must not infer a retry, expansion, or stop decision that is absent from the ledger.

## Envelope

```json
{
  "schema_version": 1,
  "trace_id": "trace-<content hash>",
  "task_id": "stable task id",
  "run_id": "run id or null",
  "harness": "stable harness identifier or null",
  "model": "fixed model id or null",
  "repository": "repository reference or null",
  "repository_commit": "git sha or null",
  "policy": {"name": "policy name", "version": "policy hash"},
  "mode": "shadow|baseline",
  "completeness": "partial|complete",
  "source": {"format": "ledger-jsonl|fixture", "source_ref": "optional ref", "record_count": 0},
  "warnings": [],
  "events": []
}
```

`harness` 接受任意稳定、非空的执行器标识，不枚举或限制具体 coding agent。

`partial` is required when source evidence ends before an explicit `stop` event. Consumers must surface `missing_stop_event`; they must not treat it as a successful stop. A `complete` trace must end with `stop`.

## Event stream

Each event has `event_index` starting at zero, a UTC `timestamp`, type-specific `data`, and a `raw_event_ref` containing the source kind, source line, and source event name.

| Event | Required evidence |
| --- | --- |
| `diff` | `changed_files`, optional repository commit/state id, observed change kinds |
| `risk` | `risk_level`, reasons, fallback flag |
| `test_selection` | requested/selected phase, affected workspaces, canonical commands |
| `test_result` | canonical command id, argv, duration, exit code, nullable failure signature/class |
| `wait` | observed wait subject (`local_process`, `remote_ci`, or `network_resource`), positive duration, and evidence flag |
| `retry` | reason, attribution flag, and earlier source event index |
| `expand` | reason and earlier source event index |
| `recommendation` | recommendation id, diagnostic labels/reason codes, candidate/action, mode, risk, confidence, diagnostic/recommendation rule versions, and evidence indexes |
| `decision` | recommendation id, outcome, actor, and reason |
| `stop` | status and reason |

The policy-led lifecycle is:

```text
diff -> risk -> test_selection -> test_result
                                  -> test_result
                                  -> wait -> test_result
                                  -> retry -> diff -> risk -> test_selection
                                           -> test_selection
                                  -> expand -> test_selection
                                  -> recommendation -> decision -> retry|expand|test_selection
                                  -> stop
```

`retry` and `expand` always reference an earlier event. Multiple `test_result` events are allowed for one selection because a plan can contain several commands.

Observed baseline collectors may also insert `diff` directly after `test_selection`, `test_result`, or another observed `diff`. This records an externally observed file change or an explicit unknown-state boundary; it does not invent a policy retry. Such a `diff` may be followed by another observed `diff`, a `test_result`, or `stop`.

`recommendation` and `decision` events are optional audit records emitted by the recommendation modes. A recommendation must reference earlier diagnostic evidence. A decision must refer to an earlier recommendation, and can be made by `system` only when the simplified mode marks the action as automatic-eligible; expert and confirmation-required recommendations remain auditable until a `user` decision is recorded.

## Conversion rule

The existing JSONL ledger contains `plan` and `command` records. Conversion expands one `plan` into `diff`, `risk`, and `test_selection` events, and maps each `command` to `test_result`. It retains the original JSONL line in `raw_event_ref`. If one JSONL file contains multiple task ids, the caller must select one with `taskId`; conversion never merges tasks implicitly. If the selected task has no explicit stop, the result is partial and carries `missing_stop_event`; no synthetic lifecycle decision is added.

Canonical regression fixtures live in `fixtures/traces/`:

- `success.json`
- `failed-retry.json`
- `conservative-escalation.json`
