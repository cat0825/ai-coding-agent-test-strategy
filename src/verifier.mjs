import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function globToRegExp(pattern) {
  const normalized = normalizeRepoPath(pattern);
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }

  return new RegExp(`${source}$`);
}

export function matchesAny(filePath, patterns = []) {
  const normalized = normalizeRepoPath(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

async function findPackageDirectories(rootDirectory, currentDirectory = rootDirectory) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const packageDirectories = [];

  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    packageDirectories.push(currentDirectory);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || [".git", "node_modules", "dist", "build"].includes(entry.name)) {
      continue;
    }
    packageDirectories.push(
      ...(await findPackageDirectories(rootDirectory, path.join(currentDirectory, entry.name))),
    );
  }

  return packageDirectories;
}

async function expandWorkspaceEntry(repoRoot, entry) {
  if (!entry.includes("*") && !entry.includes("?")) return [normalizeRepoPath(entry)];

  const firstWildcard = entry.search(/[?*]/);
  const prefix = entry.slice(0, firstWildcard);
  const prefixDirectory = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  const searchRoot = path.join(repoRoot, prefixDirectory);
  const directories = await findPackageDirectories(searchRoot);

  return directories
    .map((directory) => normalizeRepoPath(path.relative(repoRoot, directory)))
    .filter((directory) => globToRegExp(entry).test(directory));
}

export async function discoverWorkspaces(repoRoot) {
  const rootManifest = await readJson(path.join(repoRoot, "package.json"));
  const workspaceEntries = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const directories = new Set();

  for (const entry of workspaceEntries) {
    for (const directory of await expandWorkspaceEntry(repoRoot, entry)) directories.add(directory);
  }

  const workspaces = [];
  for (const directory of [...directories].sort()) {
    const manifestPath = path.join(repoRoot, directory, "package.json");
    if (!(await pathExists(manifestPath))) continue;
    const manifest = await readJson(manifestPath);
    const dependencyNames = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) dependencyNames.add(name);
    }
    workspaces.push({
      directory,
      name: manifest.name ?? directory,
      scripts: manifest.scripts ?? {},
      dependencyNames,
    });
  }

  return workspaces;
}

function normalizeCommands(commands = []) {
  const values = Array.isArray(commands) ? commands : [commands];
  return values.filter(Boolean).map((command) => ({ id: command.id, argv: [...command.argv] }));
}

function npmScriptReference(argv) {
  if (!Array.isArray(argv) || argv[0] !== "npm") return null;

  let workspace = null;
  let command = null;
  let commandIndex = -1;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace" || argument === "-w") {
      workspace = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--workspace=")) {
      workspace = argument.slice("--workspace=".length);
    } else if (!argument.startsWith("-")) {
      command = argument;
      commandIndex = index;
      break;
    }
  }

  if (command === "run" || command === "run-script") {
    const script = argv.slice(commandIndex + 1).find((argument) => !argument.startsWith("-"));
    return script ? { script, workspace } : null;
  }
  if (["restart", "start", "stop", "test"].includes(command)) {
    return { script: command, workspace };
  }
  return null;
}

export async function validatePolicyCommands({ repoRoot, policy }) {
  const rootManifest = await readJson(path.join(repoRoot, "package.json"));
  const workspaces = await discoverWorkspaces(repoRoot);
  const workspaceByName = new Map(
    workspaces.flatMap((workspace) => [
      [workspace.name, workspace],
      [workspace.directory, workspace],
    ]),
  );
  const errors = [];

  for (const [group, configuredCommands] of Object.entries(policy.commands ?? {})) {
    for (const command of normalizeCommands(configuredCommands)) {
      const reference = npmScriptReference(command.argv);
      if (!reference) continue;

      const target = reference.workspace ? workspaceByName.get(reference.workspace) : null;
      if (reference.workspace && !target) {
        errors.push(`${group}/${command.id}: unknown npm workspace "${reference.workspace}"`);
        continue;
      }
      const scripts = target?.scripts ?? rootManifest.scripts ?? {};
      const location = target ? `workspace "${target.name}"` : "root package";
      if (!Object.hasOwn(scripts, reference.script)) {
        errors.push(
          `${group}/${command.id}: npm script "${reference.script}" does not exist in ${location}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid policy commands:\n- ${errors.join("\n- ")}`);
  }
}

function templateCommand(template, workspace) {
  const replace = (value) => value.replaceAll("{workspace}", workspace.name);
  return {
    id: replace(template.idTemplate),
    argv: template.argvTemplate.map(replace),
  };
}

function dependentClosure(workspaces, initialNames) {
  const selectedNames = new Set(initialNames);
  let changed = true;

  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      if (selectedNames.has(workspace.name)) continue;
      if ([...workspace.dependencyNames].some((name) => selectedNames.has(name))) {
        selectedNames.add(workspace.name);
        changed = true;
      }
    }
  }

  return selectedNames;
}

function commandPlan({ requestedPhase, selectedPhase, riskLevel, commands, changedFiles, ...rest }) {
  return {
    requestedPhase,
    selectedPhase,
    riskLevel,
    commands,
    changedFiles,
    fallback: false,
    reasons: [],
    warnings: [],
    affectedWorkspaces: [],
    ...rest,
  };
}

export async function createVerificationPlan({ repoRoot, policy, requestedPhase, changedFiles = [] }) {
  if (!["fast", "affected", "full"].includes(requestedPhase)) {
    throw new Error(`Unsupported phase: ${requestedPhase}`);
  }

  const normalizedFiles = [...new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))].sort();
  const configuredCommands = policy.commands ?? {};

  if (requestedPhase === "fast") {
    return commandPlan({
      requestedPhase,
      selectedPhase: "fast",
      riskLevel: "smoke",
      commands: normalizeCommands(configuredCommands.fast),
      changedFiles: normalizedFiles,
      reasons: ["explicit_fast_phase"],
    });
  }

  if (requestedPhase === "full") {
    return commandPlan({
      requestedPhase,
      selectedPhase: "full",
      riskLevel: "thorough",
      commands: normalizeCommands(configuredCommands.full),
      changedFiles: normalizedFiles,
      reasons: ["explicit_full_phase"],
    });
  }

  if (normalizedFiles.length === 0) {
    return commandPlan({
      requestedPhase,
      selectedPhase: "affected",
      riskLevel: "off",
      commands: [],
      changedFiles: [],
      warnings: ["no_changed_files"],
    });
  }

  const rules = policy.rules ?? {};
  if (normalizedFiles.every((file) => matchesAny(file, rules.docsOnly))) {
    return commandPlan({
      requestedPhase,
      selectedPhase: "fast",
      riskLevel: "off",
      commands: normalizeCommands(configuredCommands.docsOnly ?? configuredCommands.fast),
      changedFiles: normalizedFiles,
      reasons: ["docs_only_change"],
    });
  }

  const fullMatches = normalizedFiles.filter((file) => matchesAny(file, rules.full));
  const highRiskMatches = normalizedFiles.filter((file) => matchesAny(file, rules.highRisk));
  if (fullMatches.length > 0 || highRiskMatches.length > 0) {
    return commandPlan({
      requestedPhase,
      selectedPhase: "full",
      riskLevel: "thorough",
      commands: normalizeCommands(configuredCommands.full),
      changedFiles: normalizedFiles,
      fallback: true,
      reasons: [
        ...(fullMatches.length > 0 ? ["full_scope_rule"] : []),
        ...(highRiskMatches.length > 0 ? ["high_risk_rule"] : []),
      ],
    });
  }

  const workspaces = await discoverWorkspaces(repoRoot);
  const directlyAffected = workspaces.filter((workspace) =>
    normalizedFiles.some(
      (file) => file === workspace.directory || file.startsWith(`${workspace.directory}/`),
    ),
  );
  const unmatchedFiles = normalizedFiles.filter(
    (file) =>
      !matchesAny(file, rules.docsOnly) &&
      !workspaces.some(
        (workspace) => file === workspace.directory || file.startsWith(`${workspace.directory}/`),
      ),
  );

  if (unmatchedFiles.length > 0) {
    return commandPlan({
      requestedPhase,
      selectedPhase: "full",
      riskLevel: "thorough",
      commands: normalizeCommands(configuredCommands.full),
      changedFiles: normalizedFiles,
      fallback: true,
      reasons: ["unmapped_change"],
      warnings: unmatchedFiles.map((file) => `unmapped:${file}`),
    });
  }

  const directlyAffectedNames = new Set(directlyAffected.map((workspace) => workspace.name));
  const selectedNames = policy.workspace?.includeDependents
    ? dependentClosure(workspaces, directlyAffectedNames)
    : directlyAffectedNames;
  const selectedWorkspaces = workspaces.filter((workspace) => selectedNames.has(workspace.name));
  const commandTemplate = policy.workspace?.testCommand;
  let commands = commandTemplate
    ? selectedWorkspaces
        .filter((workspace) => workspace.scripts.test)
        .map((workspace) => templateCommand(commandTemplate, workspace))
    : [];

  let fallback = false;
  const reasons = ["workspace_mapping"];
  if (commands.length === 0) {
    commands = normalizeCommands(configuredCommands.affectedFallback ?? configuredCommands.fast);
    fallback = true;
    reasons.push("no_workspace_test_command");
  }

  return commandPlan({
    requestedPhase,
    selectedPhase: "affected",
    riskLevel: "standard",
    commands,
    changedFiles: normalizedFiles,
    fallback,
    reasons,
    affectedWorkspaces: selectedWorkspaces.map((workspace) => workspace.name),
  });
}

function runGit(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.status === 0 ? result.stdout.trim() : "";
}

export function readRepositoryCommit(repoRoot) {
  return runGit(repoRoot, ["rev-parse", "HEAD"], { allowFailure: true }) || null;
}

export function collectChangedFiles(repoRoot, baseRef) {
  const commands = [];
  if (baseRef) commands.push(["diff", "--name-only", `${baseRef}...HEAD`, "--"]);
  commands.push(
    ["diff", "--name-only", "HEAD", "--"],
    ["diff", "--cached", "--name-only", "HEAD", "--"],
    ["ls-files", "--others", "--exclude-standard"],
  );

  const files = new Set();
  for (const args of commands) {
    const output = runGit(repoRoot, args);
    for (const line of output.split("\n")) {
      const normalized = normalizeRepoPath(line.trim());
      if (normalized) files.add(normalized);
    }
  }
  return [...files].sort();
}

export async function loadPolicy(policyPath) {
  const resolvedPath = await realpath(policyPath);
  const contents = await readFile(resolvedPath);
  return {
    path: resolvedPath,
    value: JSON.parse(contents.toString("utf8")),
    version: createHash("sha256").update(contents).digest("hex"),
  };
}

export async function readLedger(ledgerPath) {
  try {
    const contents = await readFile(ledgerPath, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendLedger(ledgerPath, event) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(event)}\n`, { flag: "a" });
}
