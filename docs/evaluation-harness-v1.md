# Evaluation harness v1

Run the local canonical calibration cohort:

```sh
npm run evaluate
```

The command writes `output/evaluation/mvp-evaluation-v1.json`. The report is deterministic for the same cohort and trace inputs: it contains a report version, stable input digest, explicit thresholds, each metric's numerator/denominator/definition, gate statuses, per-trace evidence, pairwise cost measurements, and a conclusion.

The local cohort is deliberately marked `canonical_fixture`, has zero quality-claim-eligible comparisons, and defers external P1/P2 benchmarks. Calibration failures are reported separately from eligible oracle-failure evidence. Its expected result is `evidence_insufficient`, even when structural checks or a small paired comparison pass. A failed final-oracle or candidate failure-recall gate takes precedence and produces `rejected` with `efficiency_claim: blocked`; no positive efficiency claim can be emitted in that state.

Quality gates:

- event completeness, canonical command normalization, diagnostic precision, replay correctness, and task-pair integrity;
- candidate final-oracle match and failure-recall non-regression against baseline;
- median observed duration and command-execution reductions;
- minimum quality-eligible comparison count and independent oracle-failure count.

The manifest keeps diagnostic labels and oracle failure signatures independent from the evaluator output. This is a calibration harness, not a benchmark claim.
