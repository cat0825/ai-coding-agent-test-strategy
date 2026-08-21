import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function run(args) {
  return JSON.parse(execFileSync(process.execPath, ["src/prepare-repository-policy-hook.mjs", ...args], { cwd: path.resolve("."), encoding: "utf8" }));
}

test("repository hook generator infers conservative npm script tiers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repository-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const output = path.join(root, "policy");
  await writeFile(path.join(root, "package.json"), "{}\n");
  await (await import("node:fs/promises")).mkdir(repo);
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "sample", scripts: { test: "node --test", check: "npm test" } }));
  const result = run(["--repo", repo, "--output-dir", output]);
  assert.deepEqual(result.commands, { fast: ["npm", "run", "test"], affected: ["npm", "run", "test"], full: ["npm", "run", "check"] });
  const policy = JSON.parse(await readFile(result.policy, "utf8"));
  assert.equal(policy.allow_full_suite, false);
  assert.equal(policy.behavior_class, "repository_general");
});

test("repository hook generator requires an explicit fallback for missing tiers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repository-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await (await import("node:fs/promises")).mkdir(repo);
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  assert.throws(() => run(["--repo", repo, "--output-dir", path.join(root, "policy")]), /Cannot infer fast verification script/);
  const result = run(["--repo", repo, "--output-dir", path.join(root, "policy"), "--fast", "lint", "--affected", "lint", "--full", "lint"]);
  assert.deepEqual(result.commands.full, ["npm", "run", "lint"]);
});
