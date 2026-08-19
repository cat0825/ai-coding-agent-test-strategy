import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateBenchmarkManifest, stableJson } from "../src/benchmark-preflight.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchmark-preflight-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "benchmark-artifact-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(artifactRoot, { recursive: true, force: true })]));
  const lockfile = '{"lockfileVersion":3}\n';
  const artifact = "verified artifact\n";
  await writeFile(path.join(root, "package-lock.json"), lockfile);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", ".package-lock.json"), lockfile);
  const artifactPath = path.join(artifactRoot, "dugite-native.tar.gz");
  await writeFile(artifactPath, artifact);
  command("git", ["init", "-q"], root);
  command("git", ["config", "user.name", "Benchmark Test"], root);
  command("git", ["config", "user.email", "benchmark@example.invalid"], root);
  command("git", ["add", "package-lock.json", ".gitignore"], root);
  command("git", ["commit", "-qm", "fixture"], root);
  const revision = command("git", ["rev-parse", "HEAD"], root);
  const npmVersion = command("npm", ["--version"], root);
  return {
    root,
    artifactPath,
    spec: {
      schema_version: 1,
      benchmark_id: "fixture-benchmark",
      repository: { identity: "fixture/project", expected_revision: revision, require_clean: true },
      runtime: {
        platform: os.platform(),
        arch: os.arch(),
        node_major: Number.parseInt(process.versions.node.split(".")[0], 10),
        npm_major: Number.parseInt(npmVersion.split(".")[0], 10),
      },
      install: {
        command: { argv: [process.execPath, "-e", "process.exit(0)", artifactPath] },
        lockfile: { path: "package-lock.json", sha256: sha256(lockfile) },
        required_paths: ["node_modules/.package-lock.json"],
        artifacts: [{ name: "dugite-native", path: artifactPath, sha256: sha256(artifact) }],
      },
      commands: [
        { id: "typecheck", argv: [process.execPath, "-e", "process.exit(0)"], prerequisites: ["build-test"] },
        { id: "build-test", argv: [process.execPath, "-e", "process.exit(0)"], prerequisites: [] },
      ],
    },
  };
}

test("produces a deterministic eligible manifest without absolute paths", async (t) => {
  const { root, artifactPath, spec } = await fixture(t);
  spec.repository.expected_revision = spec.repository.expected_revision.toUpperCase();
  const first = await generateBenchmarkManifest({ repoRoot: root, spec });
  const second = await generateBenchmarkManifest({ repoRoot: root, spec });
  assert.equal(first.conclusion.status, "eligible");
  assert.deepEqual(first.conclusion.reasons, []);
  assert.equal(first.repository.expected_revision, spec.repository.expected_revision.toLowerCase());
  assert.deepEqual(first.commands.map((entry) => entry.id), ["build-test", "typecheck"]);
  assert.deepEqual(first.commands.map((entry) => entry.status), ["passed", "passed"]);
  assert.match(first.install.definition_sha256, /^[0-9a-f]{64}$/);
  assert.match(first.commands[0].definition_sha256, /^[0-9a-f]{64}$/);
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(first.install.artifacts[0].file, path.basename(artifactPath));
  assert.doesNotMatch(stableJson(first), new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(stableJson(first), new RegExp(path.dirname(artifactPath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI writes an eligible manifest in one command", async (t) => {
  const { root, artifactPath, spec } = await fixture(t);
  const specPath = path.join(path.dirname(artifactPath), "spec.json");
  const outputPath = path.join(path.dirname(artifactPath), "environment.json");
  await writeFile(specPath, JSON.stringify(spec));
  const cliPath = fileURLToPath(new URL("../src/benchmark-preflight-cli.mjs", import.meta.url));
  const stdout = command(process.execPath, [cliPath, "--repo", root, "--spec", specPath, "--output", outputPath]);
  assert.deepEqual(JSON.parse(stdout), { status: "eligible", reasons: [] });
  const manifest = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(manifest.conclusion.status, "eligible");
  assert.doesNotMatch(stableJson(manifest), new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("blocks execution when repository or runtime foundations are ineligible", async (t) => {
  const { root, spec } = await fixture(t);
  const marker = path.join(root, "install-ran");
  await writeFile(path.join(root, "dirty.txt"), "dirty\n");
  spec.repository.expected_revision = "0".repeat(40);
  spec.runtime.node_major += 1;
  spec.install.command.argv = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker];
  const manifest = await generateBenchmarkManifest({ repoRoot: root, spec });
  assert.equal(manifest.conclusion.status, "ineligible");
  assert.equal(manifest.install.status, "blocked");
  assert.deepEqual(manifest.commands.map((entry) => entry.status), ["blocked", "blocked"]);
  await assert.rejects(() => access(marker));
  assert.deepEqual(manifest.conclusion.reasons, [
    "command_not_passed:build-test:blocked",
    "command_not_passed:typecheck:blocked",
    "command_prerequisite_unmet:typecheck:build-test",
    "install_blocked",
    "repository_dirty",
    "repository_revision_mismatch",
    "runtime_node_major_mismatch",
  ]);
});

test("observes install and command failures instead of accepting declared statuses", async (t) => {
  const { root, spec } = await fixture(t);
  spec.install.command.argv = [process.execPath, "-e", "process.exit(7)"];
  const installFailure = await generateBenchmarkManifest({ repoRoot: root, spec });
  assert.equal(installFailure.install.status, "failed");
  assert.equal(installFailure.install.exit_code, 7);
  assert.deepEqual(installFailure.commands.map((entry) => entry.status), ["blocked", "blocked"]);
  assert.ok(installFailure.conclusion.reasons.includes("install_failed"));

  spec.install.command.argv = [process.execPath, "-e", "process.exit(0)"];
  spec.commands.find((entry) => entry.id === "build-test").argv = [process.execPath, "-e", "process.exit(3)"];
  const commandFailure = await generateBenchmarkManifest({ repoRoot: root, spec });
  assert.deepEqual(commandFailure.commands.map((entry) => [entry.id, entry.status, entry.exit_code]), [
    ["build-test", "failed", 3],
    ["typecheck", "blocked", null],
  ]);
  assert.ok(commandFailure.conclusion.reasons.includes("command_not_passed:build-test:failed"));
  assert.ok(commandFailure.conclusion.reasons.includes("command_prerequisite_unmet:typecheck:build-test"));
});

test("rejects declared statuses and prerequisite cycles", async (t) => {
  const { root, spec } = await fixture(t);
  spec.install.status = "passed";
  await assert.rejects(() => generateBenchmarkManifest({ repoRoot: root, spec }), /status is not accepted/);
  delete spec.install.status;
  spec.commands.find((entry) => entry.id === "build-test").prerequisites = ["typecheck"];
  await assert.rejects(() => generateBenchmarkManifest({ repoRoot: root, spec }), /prerequisite cycle/);
});

test("rejects repository evidence paths that escape the worktree", async (t) => {
  const { root, spec } = await fixture(t);
  const marker = path.join(root, "install-ran");
  spec.install.command.argv = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker];
  spec.install.lockfile.path = "../package-lock.json";
  await assert.rejects(() => generateBenchmarkManifest({ repoRoot: root, spec }), /escapes the repository/);
  spec.install.lockfile.path = "package-lock.json";
  spec.install.required_paths = ["../node_modules"];
  await assert.rejects(() => generateBenchmarkManifest({ repoRoot: root, spec }), /escapes the repository/);
  await assert.rejects(() => access(marker));
});
