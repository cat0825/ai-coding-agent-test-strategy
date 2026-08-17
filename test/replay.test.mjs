import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderTraceReplay } from "../src/replay.mjs";

const execFileAsync = promisify(execFile);

function escapedJson(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fixture(...parts) {
  return JSON.parse(await readFile(path.resolve("fixtures", ...parts), "utf8"));
}

test("all canonical traces render every event into a self-contained replay", async () => {
  const names = ["success.json", "failed-retry.json", "conservative-escalation.json"];
  for (const name of names) {
    const trace = await fixture("traces", name);
    const html = renderTraceReplay(trace);

    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, /<(?:script|link)\b/i);
    assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
    assert.equal((html.match(/data-event-index=/g) ?? []).length, trace.events.length);
    for (const event of trace.events) {
      assert.match(html, new RegExp(`id="event-${event.event_index}"`));
      assert.ok(html.includes(escapedJson(event)), `complete event ${event.event_index} is present`);
    }
    assert.match(html, /Complete trace envelope/);
    assert.match(html, /Complete diagnostic result/);
    assert.match(html, /Trace complete/);
  }
});

test("replay CLI writes a nested output file", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "verifytrace-replay-"));
  const outputPath = path.join(temporaryRoot, "nested", "success.html");
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "src/replay-cli.mjs",
      "fixtures/traces/success.json",
      outputPath,
    ]);
    const html = await readFile(outputPath, "utf8");

    assert.equal(stdout.trim(), outputPath);
    assert.match(html, /fixture-success/);
    assert.match(html, /Verification stopped/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("diagnostic replay links the first waste point and all evidence", async () => {
  const trace = await fixture("diagnostics", "unattributed-retry.json");
  const html = renderTraceReplay(trace);

  assert.match(html, /First candidate waste point/);
  assert.match(html, /href="#event-6">Inspect event #6/);
  assert.match(html, /Exact repeat/);
  assert.match(html, /Unattributed retry/);
  for (const index of [3, 4, 5, 6]) assert.match(html, new RegExp(`href="#event-${index}"`));
});

test("partial traces surface missing stop evidence", async () => {
  const trace = await fixture("traces", "success.json");
  trace.events.pop();
  trace.completeness = "partial";
  trace.warnings = ["missing_stop_event"];
  const html = renderTraceReplay(trace);

  assert.match(html, /Incomplete evidence/);
  assert.match(html, /missing_stop_event/);
  assert.match(html, /Stop status<\/dt><dd>Missing/);
});

test("trace strings are escaped before insertion into HTML", async () => {
  const trace = await fixture("traces", "success.json");
  trace.task_id = '<img src=x onerror="alert(1)">';
  trace.events[0].data.changed_files = ["</style><script>alert(1)</script>"];
  const html = renderTraceReplay(trace);

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
