import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendLedger,
  createVerificationPlan,
  globToRegExp,
  readLedger,
  validatePolicyCommands,
} from "../src/verifier.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const policy = {
  name: "fixture-policy",
  commands: {
    docsOnly: [{ id: "docs", argv: ["npm", "run", "format:check"] }],
    fast: [{ id: "fast", argv: ["npm", "run", "typecheck"] }],
    affectedFallback: [{ id: "affected-fallback", argv: ["npm", "run", "test:fast"] }],
    full: [{ id: "full", argv: ["npm", "run", "test:full"] }],
  },
  rules: {
    docsOnly: ["**/*.md", "docs/**"],
    full: ["package-lock.json", "scripts/**", "**/package.json"],
    highRisk: ["packages/storage/**"],
  },
  workspace: {
    includeDependents: true,
    testCommand: {
      idTemplate: "workspace:{workspace}:test",
      argvTemplate: ["npm", "--workspace", "{workspace}", "test"],
    },
  },
};

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-test-strategy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "package.json"), {
    name: "fixture-root",
    private: true,
    workspaces: ["packages/core", "apps/ui", "packages/storage"],
    scripts: {
      "format:check": "node --check fixture.mjs",
      typecheck: "node --check fixture.mjs",
      "test:fast": "node --test",
      "test:full": "node --test",
      test: "node --test",
    },
  });
  await writeJson(path.join(root, "packages/core/package.json"), {
    name: "@fixture/core",
    scripts: { test: "node --test" },
  });
  await writeJson(path.join(root, "apps/ui/package.json"), {
    name: "@fixture/ui",
    dependencies: { "@fixture/core": "workspace:*" },
    scripts: { test: "node --test" },
  });
  await writeJson(path.join(root, "packages/storage/package.json"), {
    name: "@fixture/storage",
    scripts: { test: "node --test" },
  });
  return root;
}

test("glob matcher handles root and nested double-star paths", () => {
  assert.equal(globToRegExp("**/*.md").test("README.md"), true);
  assert.equal(globToRegExp("**/*.md").test("docs/guide.md"), true);
  assert.equal(globToRegExp("scripts/**").test("scripts/check.mjs"), true);
  assert.equal(globToRegExp("scripts/**").test("packages/scripts/check.mjs"), false);
});

test("docs-only changes select the minimal formatting command", async (t) => {
  const repoRoot = await createFixture(t);
  const plan = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: ["README.md", "docs/guide.md"],
  });

  assert.equal(plan.selectedPhase, "fast");
  assert.equal(plan.riskLevel, "off");
  assert.deepEqual(plan.commands.map((command) => command.id), ["docs"]);
});

test("root configuration and high-risk changes conservatively select full", async (t) => {
  const repoRoot = await createFixture(t);
  const rootPlan = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: ["package-lock.json"],
  });
  const highRiskPlan = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: ["packages/storage/src/migration.ts"],
  });

  assert.equal(rootPlan.selectedPhase, "full");
  assert.equal(rootPlan.fallback, true);
  assert.equal(highRiskPlan.selectedPhase, "full");
  assert.deepEqual(highRiskPlan.reasons, ["high_risk_rule"]);
});

test("affected workspace planning includes direct dependents", async (t) => {
  const repoRoot = await createFixture(t);
  const plan = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: ["packages/core/src/settings.ts"],
  });

  assert.equal(plan.selectedPhase, "affected");
  assert.equal(plan.fallback, false);
  assert.deepEqual(plan.affectedWorkspaces, ["@fixture/ui", "@fixture/core"]);
  assert.deepEqual(
    plan.commands.map((command) => command.id),
    ["workspace:@fixture/ui:test", "workspace:@fixture/core:test"],
  );
});

test("unmapped files fall back to full and no-change plans remain empty", async (t) => {
  const repoRoot = await createFixture(t);
  const unmapped = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: ["unknown.config"],
  });
  const empty = await createVerificationPlan({
    repoRoot,
    policy,
    requestedPhase: "affected",
    changedFiles: [],
  });

  assert.equal(unmapped.selectedPhase, "full");
  assert.deepEqual(unmapped.reasons, ["unmapped_change"]);
  assert.deepEqual(empty.commands, []);
  assert.deepEqual(empty.warnings, ["no_changed_files"]);
});

test("policy validation rejects npm scripts that do not exist", async (t) => {
  const repoRoot = await createFixture(t);
  const invalidPolicy = structuredClone(policy);
  invalidPolicy.commands.full = [
    { id: "missing-full", argv: ["npm", "run", "missing:full"] },
  ];

  await assert.rejects(
    validatePolicyCommands({ repoRoot, policy: invalidPolicy }),
    /npm script "missing:full" does not exist in root package/,
  );
  await assert.doesNotReject(
    validatePolicyCommands({
      repoRoot,
      policy: {
        commands: {
          full: [{ id: "root-test", argv: ["npm", "test"] }],
        },
      },
    }),
  );
});

test("ledger appends JSONL events and the CLI writes a shadow plan", async (t) => {
  const repoRoot = await createFixture(t);
  const ledgerPath = path.join(repoRoot, "output", "ledger.jsonl");
  const policyPath = path.join(repoRoot, "policy.json");
  await writeJson(policyPath, policy);

  await appendLedger(ledgerPath, { event: "seed", task_id: "seed" });
  assert.deepEqual(await readLedger(ledgerPath), [{ event: "seed", task_id: "seed" }]);

  const result = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "src/cli.mjs"),
      "affected",
      "--repo",
      repoRoot,
      "--policy",
      policyPath,
      "--ledger",
      ledgerPath,
      "--task-id",
      "cli-task",
      "--mode",
      "baseline",
      "--changed-file",
      "packages/core/src/settings.ts",
      "--json",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.selectedPhase, "affected");
  assert.deepEqual(output.affectedWorkspaces, ["@fixture/ui", "@fixture/core"]);

  const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, "plan");
  assert.equal(events[1].mode, "baseline");
  assert.equal(events[1].task_id, "cli-task");
});
