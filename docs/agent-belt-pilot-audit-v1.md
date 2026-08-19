# Agent-belt pilot audit v1

The pilot auditor converts a completed agent-belt run into sanitized exploratory evidence:

```sh
npm run benchmark:pilot -- \
  --run /path/to/agent-belt-outcomes/run-id \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output output/benchmark/agent-belt-pilot-report.json
```

The input is bound to the qualified agent-belt revision through the benchmark card and environment manifest. Every declared scenario must have a structured `turn_0_output.json`, matching timing, a safe relative name, and a scenario definition digest. Missing, malformed, revision-mismatched, or caller-declared eligibility evidence is rejected.

The report retains scenario names, tags, relative changed files, durations, aggregate shell/test-runner counts, and SHA-256 source digests. It does not retain raw command argv, command output, absolute worktree paths, authentication signals, or credentials.

## Test-change classification

- `required`: the scenario has the explicit `test-required` tag and a test file changed.
- `missing`: the scenario has the explicit tag but no test file changed; the pilot stops.
- `unspecified`: a test file changed without the explicit tag. This is an observation, not a claim that the test was unnecessary.
- `none`: no test file changed and no explicit test requirement was present.

The initial budgets are the existing pilot defaults: at most one changed test file and at most two immediate test-runner shell invocations per task. Exceeding a budget is recorded for calibration; it does not by itself identify a bad test or authorize enforcement.

Agent-belt exposes scenario wall time but not a duration for each shell tool call in this outcome schema. The auditor can count non-zero test-runner invocations, but it cannot attribute the 489.63-second total to test execution, model reasoning, editing, or harness overhead.

## First real run

The pinned run `20260818-023916-8af90bb9` used Codex CLI 0.147.0 against the tasktracker fixture at `jfrog/agent-belt@90bd105b172adc41394f458e33b653dda2b199b0`:

- 5/5 scenarios and 32/32 rules checks passed.
- 63 shell invocations were observed, including 10 test-runner invocations.
- 6/10 test-runner invocations returned non-zero.
- 3 scenarios changed one test file; one was explicitly required and two were unspecified.
- 0 scenarios exceeded the one-test-file budget; 2 exceeded the two-invocation budget.
- Total agent execution time was 489.63 seconds.

The checked-in report is [agent-belt-pilot-report.json](../fixtures/benchmark/agent-belt-pilot-report.json). It returns `pilot_decision: go`, but its quality-claim status remains `evidence_insufficient`. These five exploratory tasks have no complete baseline VerifyTrace, independent oracle, or paired candidate run, so the baseline remains 0/30 and no efficiency or preserved-quality claim is allowed.
