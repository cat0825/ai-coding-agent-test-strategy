# Agent-belt independent oracles v1

The tasktracker oracle bundle verifies product behavior after the agent turn. It is stored outside the target worktree, is not referenced by the agent prompt, and does not invoke tests authored or executed by the agent.

```sh
npm run benchmark:oracle -- \
  --task l2_fix_formatter_bug \
  --repo /path/to/post-agent-worktree \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output output/benchmark/oracles/l2_fix_formatter_bug.json \
  --allow-host
```

Host execution is denied unless `--allow-host` is explicit. The current runner gives the child process a temporary home and only passes `PATH`, locale, the target `PYTHONPATH`, and deterministic Python controls; provider keys, proxy variables, the user's Python path, and other parent environment variables are not forwarded. Host mode is still not a sandbox: it is suitable only for reviewed/reconstructed pilot worktrees. Unreviewed agent output requires an isolated execution provider before collection at scale.

## Covered behavior

- `l2_add_completed_at`: default value, serialization, backward-compatible deserialization, completion timestamp, and persistence.
- `l2_fix_formatter_bug`: long title/project values remain present and every rendered table line has aligned width.
- `l3_add_delete_command`: storage deletion, missing-ID integrity, CLI success flow, and missing-ID exit status.
- `l3_add_json_format`: JSON payload, default table behavior, and rejection of unsupported formats.

`l1_find_bug` is read-only and has no stable independent response oracle, so it is excluded from the editing cohort.

Each report binds the task to the qualified agent-belt revision, environment manifest digest, oracle definition digest, and a digest of `src/tasktracker`. It emits only `passed` or stable failure signatures. Missing/malformed output, an unknown task, an ineligible environment, caller-declared eligibility, timeout, or inconsistent exit status fails closed.

## Real pilot evidence

The four saved reports under [fixtures/benchmark/oracles](../fixtures/benchmark/oracles) were produced from isolated worktrees reconstructed by applying each real pilot outcome's captured `git_diff` to the pinned tasktracker fixture. The oracle bundle was not present during the agent runs. All four functional oracles passed.

This closes the independent-oracle gap only for the four editing tasks. Their reports intentionally retain `baseline_quality_claim_eligible: false` because the original outcomes lack complete timestamped baseline VerifyTrace evidence. The quality-claim baseline therefore remains 0/30.
