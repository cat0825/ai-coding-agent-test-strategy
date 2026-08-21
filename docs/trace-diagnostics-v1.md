# Trace diagnostics v1

The v1 diagnostic rules consume a validated VerifyTrace and emit deterministic evidence labels. They do not use a model and do not classify contextual scope overshoot.

## Labels

| Label | Deterministic rule | Meaning |
| --- | --- | --- |
| `exact_repeat` | The same canonical command appears again with no observed relevant state change between results. | Candidate waste point. |
| `unattributed_retry` | A repeated failed command has the same non-null failure signature and no attributed retry. | Candidate waste point. |
| `necessary_revalidation` | A repeated command follows an observed code, test, fixture, configuration, or environment change. | Explicit negative label: the repetition is justified. |
| `polling` | The same command repeats after an explicit observed `wait` with no local state change. | Remote/local state polling, not a waste repeat. |

Documentation-only changes are not relevant state changes for these rules. A diff with a null `state_id` or empty `change_kinds` is treated as unknown; the rules emit no repeat label across that boundary.

Agent-belt lifecycle traces have an additional fail-closed requirement: `source.state_evidence_complete` must be true and both compared test results must carry complete `command_semantics`. Older traces and partial state evidence can still be replayed, but they cannot produce `exact_repeat` or `unattributed_retry` findings.

An explicit `wait` event suppresses `exact_repeat` and emits `polling`. Ambiguous waiting is not inferred, so it emits neither label.

Compound shell commands are decomposed before runner analysis. Separators inside quotes remain literal; `&&`, `||`, `;`, pipes, newlines, and parenthesized groups create command boundaries. A test runner inside command substitution or a command containing multiple runners is marked incomplete, so diagnostics emit no repeat label. `cd .` is identity-neutral, while a real directory change remains part of the canonical command identity.

## Output

Each finding includes:

- `ruleset_version`
- `label`
- the labeled `event_index`
- `canonical_command_id`
- a stable `reason_code`
- ordered `evidence_event_indexes`

`first_candidate_waste_event_index` points to the first exact repeat or unattributed retry. Necessary revalidation is never counted as waste.
