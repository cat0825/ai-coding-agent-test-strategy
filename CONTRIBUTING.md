# Contributing

## Workflow

1. Start from an open issue with explicit acceptance criteria.
2. Use a feature branch; never commit directly to the default branch.
3. Keep one implementation issue per pull request.
4. Link the issue with `Fixes #<number>` or explain why the pull request must not close it.
5. Keep unrelated refactors and generated-file churn out of the change.

## Verification

Run the repository gate before pushing:

```sh
npm run check
```

For HTML or PDF changes, also render the latest artifact and inspect it at desktop and mobile widths. Include the checked page count or viewport sizes in the pull request.

## Evidence and claims

- Describe the behavior changed, the command run, and the observed result.
- Add regression coverage for behavior changes.
- Do not claim lower verification cost unless the measurement method and sample are included.
- Do not claim preserved quality when the final oracle or failure recall regresses.
- Keep external benchmarks and hard enforcement out of the Observatory MVP unless a roadmap issue explicitly expands the scope.
