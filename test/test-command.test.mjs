import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTestRunnerCommand } from "../src/test-command.mjs";

const cwdSha256 = "c".repeat(64);

test("semantic command identity preserves environment, target, and cwd differences", () => {
  const plain = analyzeTestRunnerCommand("pytest", { cwdSha256 });
  const environment = analyzeTestRunnerCommand("PYTHONPATH=/workspace pytest", { cwdSha256 });
  const target = analyzeTestRunnerCommand("pytest tests/test_api.py", { cwdSha256 });
  const subdirectory = analyzeTestRunnerCommand("cd packages/api && pytest", { cwdSha256 });

  assert.deepEqual(plain.command, ["pytest"]);
  assert.equal(plain.semantics.complete, true);
  assert.equal(new Set([
    plain.canonicalId,
    environment.canonicalId,
    target.canonicalId,
    subdirectory.canonicalId,
  ]).size, 4);
});

test("environment assignment order does not change semantic command identity", () => {
  const left = analyzeTestRunnerCommand("A=1 B=2 pytest -q", { cwdSha256 });
  const right = analyzeTestRunnerCommand("B=2 A=1 pytest -q", { cwdSha256 });

  assert.equal(left.canonicalId, right.canonicalId);
  assert.equal(left.semantics.environment_sha256, right.semantics.environment_sha256);
});

test("shell wrapper parsing keeps raw values out of semantic evidence", () => {
  const analysis = analyzeTestRunnerCommand(
    "/bin/zsh -lc 'TOKEN=secret PYTHONPATH=/private/tmp/work pytest -q'",
    { cwdSha256 },
  );

  assert.deepEqual(analysis.command, ["pytest"]);
  assert.equal(analysis.semantics.complete, true);
  assert.doesNotMatch(JSON.stringify(analysis), /secret|private|TOKEN|PYTHONPATH/);
});

test("project check scripts count as verification commands", () => {
  const analysis = analyzeTestRunnerCommand("/bin/zsh -lc 'npm run check'", { cwdSha256 });

  assert.deepEqual(analysis.command, ["npm", "run", "check"]);
  assert.equal(analysis.semantics.complete, true);
});

test("missing cwd and ambiguous command chains fail closed", () => {
  const missingCwd = analyzeTestRunnerCommand("pytest");
  const ambiguous = analyzeTestRunnerCommand("pytest && pytest", { cwdSha256 });

  assert.equal(missingCwd.semantics.complete, false);
  assert.equal(missingCwd.semantics.reason, "missing_working_directory_evidence");
  assert.equal(ambiguous.semantics.complete, false);
  assert.equal(ambiguous.semantics.reason, "multiple_runner_commands");
});
