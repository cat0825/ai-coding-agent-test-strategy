import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeVerificationTask, qualifyVerificationPilot } from "../src/verification-workspace.mjs";

async function checkedInputs() {
  const [plan, oracles, qualification] = await Promise.all([
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-plan.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-oracles.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../fixtures/benchmark/verification-policy-pilot-qualification.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  return { plan, oracles, qualification };
}

test("materializer exposes only the base snapshot and declared change", async (t) => {
  const { plan } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-materializer-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const materialized = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => materialized.cleanup());
  const second = await materializeVerificationTask({
    plan,
    taskId: "vp_local_correct_stop",
    sourceRepository: path.resolve("."),
    outputParent,
  });
  t.after(() => second.cleanup());
  assert.deepEqual(materialized.changed_files, ["src/trace.mjs"]);
  assert.equal(second.workspace_revision, materialized.workspace_revision);
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: materialized.workspace, encoding: "utf8" }).trim(), "1");
  assert.throws(
    () => execFileSync("git", ["cat-file", "-e", "27003e86236ae6a8a57dd621020f7874a67f4e64^{commit}"], { cwd: materialized.workspace, stdio: "ignore" }),
  );
  execFileSync("node", ["--test", "test/trace.test.mjs"], { cwd: materialized.workspace, stdio: "ignore" });
});

test("prepare CLI returns a runnable isolated workspace binding", async (t) => {
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-prepare-cli-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const stdout = execFileSync(process.execPath, [
    "src/verification-task-cli.mjs",
    "--plan", "fixtures/benchmark/verification-policy-pilot-plan.json",
    "--task", "vp_repeat_pass_stop",
    "--repo", ".",
    "--output-parent", outputParent,
  ], { cwd: path.resolve("."), encoding: "utf8" });
  const binding = JSON.parse(stdout);
  assert.equal(binding.task_id, "vp_repeat_pass_stop");
  assert.equal(binding.mode, "verify_only");
  assert.match(binding.workspace_revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    execFileSync("git", ["diff", "--name-only"], { cwd: binding.workspace, encoding: "utf8" }).trim().split(/\r?\n/).sort(),
    binding.changed_files.sort(),
  );
});

test("all six pilot states reproduce their declared pass and failure patterns", async (t) => {
  const { plan, oracles, qualification } = await checkedInputs();
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "verification-qualification-test-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const observed = await qualifyVerificationPilot({
    plan,
    oracles,
    sourceRepository: path.resolve("."),
    outputParent,
  });
  assert.deepEqual(observed, qualification);
  assert.equal(observed.conclusion.status, "fixture_ready");
  assert.equal(observed.counts.qualified_tasks, 6);
});
