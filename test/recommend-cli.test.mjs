import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateTrace } from "../src/trace.mjs";

const execFileAsync = promisify(execFile);

test("recommendation CLI emits evidence and writes automatic or user decisions", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "recommendation-cli-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const trace = JSON.parse(await readFile(path.resolve("fixtures/diagnostics/exact-repeat.json"), "utf8"));
  trace.events.find((event) => event.event_type === "risk").data.risk_level = "smoke";
  const inputPath = path.join(temporaryRoot, "input.json");
  await writeFile(inputPath, JSON.stringify(trace), "utf8");

  const automaticPath = path.join(temporaryRoot, "automatic", "trace.json");
  const automaticResult = await execFileAsync(process.execPath, [
    "src/recommend-cli.mjs",
    "simplified",
    inputPath,
    "--audit-output",
    automaticPath,
  ]);
  const automaticEvaluation = JSON.parse(automaticResult.stdout);
  const automaticTrace = JSON.parse(await readFile(automaticPath, "utf8"));
  assert.equal(automaticEvaluation.recommendations[0].automatic_eligible, true);
  assert.deepEqual(automaticEvaluation.audited_trace, automaticTrace);
  assert.equal(automaticTrace.events.find((event) => event.event_type === "decision").data.actor, "system");
  assert.equal(validateTrace(automaticTrace).valid, true);

  const userPath = path.join(temporaryRoot, "user", "trace.json");
  await execFileAsync(process.execPath, [
    "src/recommend-cli.mjs",
    "expert",
    inputPath,
    "--audit-output",
    userPath,
    "--decision",
    "rec-4-exact_repeat=rejected:retain duplicate evidence",
  ]);
  const userTrace = JSON.parse(await readFile(userPath, "utf8"));
  const userDecision = userTrace.events.find((event) => event.event_type === "decision");
  assert.equal(userDecision.data.actor, "user");
  assert.equal(userDecision.data.outcome, "rejected");
  assert.equal(userDecision.data.reason, "retain duplicate evidence");
  assert.equal(validateTrace(userTrace).valid, true);
});
