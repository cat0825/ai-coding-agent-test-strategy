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

- Real baseline VerifyTrace tasks: 0/30
- Candidate paired comparisons: 0/30
- Independent editing-task oracle results: 4 passed, 0 failed
- Eligible oracle failures for safety calibration: 0/10
- Agent authentication and scenario execution: verified by a five-scenario exploratory pilot

## Exploratory pilot result

Codex CLI 0.147.0 completed the five tasktracker scenarios in isolated git worktrees. All 5 scenarios and 32/32 rules checks passed in 489.63 seconds. The deterministic audit observed 63 shell invocations, including 10 test-runner invocations with 6 non-zero results. Three scenarios changed one test file each: one was explicitly tagged `test-required`, while two were unspecified by scenario tags. `unspecified` is not an assertion that those regression tests were unnecessary.

The sanitized evidence is [agent-belt-pilot-report.json](../fixtures/benchmark/agent-belt-pilot-report.json), and its contract is [Agent-belt pilot audit v1](agent-belt-pilot-audit-v1.md). Separate independent functional oracles now pass for all four editing tasks; see [Agent-belt independent oracles v1](agent-belt-independent-oracles-v1.md). The read-only task remains excluded, and complete baseline VerifyTrace plus paired candidate runs are still missing. Hard enforcement and efficiency claims remain disabled.
