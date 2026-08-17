# Recommendation modes v1

Both user experiences consume the same `diagnoseTrace()` output and emit the same versioned recommendation shape. The mode changes authorization, not evidence.

| Mode | Low-risk exact/equivalent repeat | Contextual or high-risk finding |
| --- | --- | --- |
| `expert` | Show the complete candidate and evidence; never auto-apply | Show candidate; confirmation required |
| `simplified` | Auto-eligible only when confidence is high and trace risk is `off` or `smoke` | Advisory only; confirmation required |

`necessary_revalidation` is always contextual. `standard` or `thorough` risk, any fallback, and unknown context are never automatically applied. A simplified automatic action is recorded as a `decision` with `actor: "system"`; a human response is recorded with `actor: "user"` and one of `accepted`, `rejected`, or `deferred`.

When one event has both `exact_repeat` and `unattributed_retry`, the engine emits one `duplicate_verification` recommendation containing both labels and reason codes. This prevents duplicate actions while preserving the full deterministic evidence.

## API

```js
import { evaluateRecommendations, appendRecommendationAudit } from "./src/recommendations.mjs";

const evaluation = evaluateRecommendations(trace, { mode: "simplified" });
const auditedTrace = appendRecommendationAudit(trace, evaluation, {
  decisions: { "rec-6-exact_repeat": { outcome: "rejected", reason: "keep evidence" } },
});
```

The returned trace remains VerifyTrace v1 and can be rendered by the static replay CLI. Recommendation events preserve the diagnostic rule version and evidence event indexes; decision events preserve the actor and reason.

## CLI

Inspect candidates and receive a new audited trace on stdout without changing the input file:

```sh
npm run recommend -- expert fixtures/diagnostics/exact-repeat.json
```

Write automatic simplified decisions and any explicit user decisions into a new trace:

```sh
npm run recommend -- simplified fixtures/diagnostics/exact-repeat.json \
  --audit-output output/replay/audited-trace.json \
  --decision 'rec-4-exact_repeat=rejected:retain duplicate evidence'
```

The CLI always returns `audited_trace`, rejects decisions for unknown recommendation ids, and does not modify the source trace. `--audit-output` persists that same trace to a separate file.
