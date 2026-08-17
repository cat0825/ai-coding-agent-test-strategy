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
- Eligible oracle failures: 0/10
- Agent authentication and scenario execution: not yet verified

The next step is to run a small five-task go/no-go pilot with a generic coding agent and the repository's real scenarios. Until that produces complete traces and oracle evidence, hard enforcement and efficiency claims remain disabled.
