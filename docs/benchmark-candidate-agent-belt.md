# Candidate qualification: agent-belt

## Scope

This is an environment qualification record for the first generic coding-agent benchmark candidate. It is not a baseline task result, agent quality result, or efficiency claim.

## Pinned evidence

- Repository: [jfrog/agent-belt](https://github.com/jfrog/agent-belt)
- Revision: `90bd105b172adc41394f458e33b653dda2b199b0`
- Official CI: [Build & Test run 30529568299](https://github.com/jfrog/agent-belt/actions/runs/30529568299), successful at the pinned revision
- Lockfile SHA-256: `a8e83d8bc6223229e1f142f12aa21fd72c8bfd13e7ced1b6645b40022dc85a3f`
- Local platform: macOS arm64, Python 3, uv 0

## Preflight result

The generic preflight ran in a detached clean worktree with `uv sync --locked`, lint, the full pytest suite, and `uv build`. All required gates passed and the resulting manifest is `eligible`: [agent-belt-environment.json](../fixtures/benchmark/agent-belt-environment.json). The exact spec is [agent-belt-preflight-spec.json](../fixtures/benchmark/agent-belt-preflight-spec.json).

The default proxy environment produced one classified infrastructure failure: the doctor provider test received HTTP 502 from the local Ollama check through the proxy, so that run was `ineligible`. With HTTP/HTTPS/ALL proxy variables removed and localhost direct, the isolated provider test passed 4/4 and the complete preflight passed. This distinction is retained as environment evidence, not hidden as a repository failure.

## Remaining evidence

- Real baseline VerifyTrace tasks: 4/30 quality-claim-eligible (the timestamped rerun is recorded in [agent-belt-baseline-report.json](../fixtures/benchmark/agent-belt-baseline-report.json))
- Candidate paired comparisons: 0/30
- Independent editing-task oracle results: 4 passed, 0 failed
- Eligible oracle failures for safety calibration: 0/10
- Agent authentication and scenario execution: verified by the exploratory pilot and the timestamped five-scenario rerun

## Current pilot result

Codex CLI 0.147.0 completed the five tasktracker scenarios in isolated git worktrees. State-aware run `20260818-162534-870bcfcf` passed all 5 scenarios and 32/32 rules checks. The deterministic audit observed 29 shell invocations, including 7 test-runner invocations with 3 non-zero results. Four scenarios changed test files: one was explicitly tagged `test-required`, while three were unspecified by scenario tags. Nine generated Python cache files were excluded from file budgets. `unspecified` is not an assertion that those regression tests were unnecessary.

The sanitized evidence is [agent-belt-pilot-report.json](../fixtures/benchmark/agent-belt-pilot-report.json), and its contract is [Agent-belt pilot audit v1](agent-belt-pilot-audit-v1.md). The state-aware evidence is [traces/report.json](../fixtures/benchmark/traces/report.json); all five traces are complete, command semantics are complete, four file changes are bound, and the four editing tasks pass independent oracles. The read-only task remains excluded, 26 distinct baseline tasks are still missing, and paired candidate runs have not started. Hard enforcement and overall efficiency claims remain disabled.
