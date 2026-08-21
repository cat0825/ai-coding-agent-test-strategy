import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTestRunnerCommand, decomposeShellCommand } from "../src/test-command.mjs";

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

test("quoted npm test commands count as verification commands", () => {
  const analysis = analyzeTestRunnerCommand("/bin/zsh -lc 'npm test'", { cwdSha256 });

  assert.deepEqual(analysis.command, ["npm", "test"]);
  assert.equal(analysis.semantics.complete, true);
});

test("compound commands decompose without splitting quoted separators", () => {
  const segments = decomposeShellCommand('echo "a && b" && cd . && npm test\n');

  assert.deepEqual(segments, [
    { tokens: ["echo", "a && b"], nested: false },
    { tokens: ["cd", "."], nested: false },
    { tokens: ["npm", "test"], nested: false },
  ]);
});

test("grouped test commands remain analyzable and cd dot is identity-neutral", () => {
  const grouped = analyzeTestRunnerCommand("(cd . && npm test)", { cwdSha256 });
  const plain = analyzeTestRunnerCommand("npm test", { cwdSha256 });

  assert.equal(grouped.semantics.complete, true);
  assert.equal(grouped.canonicalId, plain.canonicalId);
});

test("a test runner inside command substitution fails closed", () => {
  const analysis = analyzeTestRunnerCommand("echo $(npm test)", { cwdSha256 });

  assert.equal(analysis.semantics.complete, false);
  assert.equal(analysis.semantics.reason, "nested_runner_structure_unrecognized");
  assert.doesNotMatch(JSON.stringify(analysis), /npm test|echo \$\(/);
});

test("multiple test runners in a compound command fail closed", () => {
  const analysis = analyzeTestRunnerCommand("npm test && node --test", { cwdSha256 });

  assert.equal(analysis.semantics.complete, false);
  assert.equal(analysis.semantics.reason, "multiple_runner_commands");
});

test("missing cwd and ambiguous command chains fail closed", () => {
  const missingCwd = analyzeTestRunnerCommand("pytest");
  const ambiguous = analyzeTestRunnerCommand("pytest && pytest", { cwdSha256 });

  assert.equal(missingCwd.semantics.complete, false);
  assert.equal(missingCwd.semantics.reason, "missing_working_directory_evidence");
  assert.equal(ambiguous.semantics.complete, false);
  assert.equal(ambiguous.semantics.reason, "multiple_runner_commands");
});

test("output redirection does not change test selection identity", () => {
  const plain = analyzeTestRunnerCommand("npm test", { cwdSha256 });
  const piped = analyzeTestRunnerCommand("npm test 2>&1 | tail -60", { cwdSha256 });
  const redirected = analyzeTestRunnerCommand("npm test > run.log 2>&1", { cwdSha256 });

  assert.equal(piped.semantics.complete, true);
  assert.equal(redirected.semantics.complete, true);
  assert.equal(piped.semantics.arguments_sha256, plain.semantics.arguments_sha256);
  assert.equal(redirected.semantics.arguments_sha256, plain.semantics.arguments_sha256);

  const targeted = analyzeTestRunnerCommand("node --test test/a.test.mjs", { cwdSha256 });
  const targetedPiped = analyzeTestRunnerCommand("node --test test/a.test.mjs 2>&1 | tail -5", { cwdSha256 });
  assert.equal(targetedPiped.semantics.arguments_sha256, targeted.semantics.arguments_sha256);
  assert.notEqual(targeted.semantics.arguments_sha256, plain.semantics.arguments_sha256);
});
