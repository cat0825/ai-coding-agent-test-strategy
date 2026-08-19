# Static trace replay

Generate a self-contained HTML replay from a validated VerifyTrace file:

```sh
npm run replay -- fixtures/traces/failed-retry.json output/replay/failed-retry.html
```

The generated file can be opened directly without a server or network access. It includes the complete trace envelope, every event and raw source reference, the complete deterministic diagnostic result, total observed test duration, and an explicit warning when the source lacks a stop event.

The timeline uses native HTML disclosure controls so raw event data remains keyboard accessible. Layout and color are local CSS; the output has no scripts, remote fonts, trackers, or runtime dependencies.
