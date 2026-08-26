import { createHash } from "node:crypto";

// A test target names a path or a source file. Flag values that happen to match can only
// widen the selected set, never hide a file from it, so a permissive shape is safe here.
const PATH_LIKE = /\/|\.[cm]?[jt]sx?$/;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OPERATORS = new Set(["&&", "||", ";", "|", "(", ")", "$(", "\\n"]);
const DIGEST = /^[a-f0-9]{64}$/i;
const REDIRECTION = /^(?:\d*>>?|\d*<|&>>?)/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function executableName(value) {
  return value.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
}

function tokenizeShell(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\n") {
      flush();
      tokens.push("\\n");
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      flush();
      tokens.push("$(");
      index += 1;
      continue;
    }
    if (character === "(") {
      flush();
      tokens.push("(");
      continue;
    }
    if (character === ")") {
      flush();
      tokens.push(")");
      continue;
    }
    if (character === ";" || character === "|") {
      flush();
      if (command[index + 1] === character) {
        tokens.push(`${character}${character}`);
        index += 1;
      } else {
        tokens.push(character);
      }
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      flush();
      tokens.push("&&");
      index += 1;
      continue;
    }
    current += character;
  }
  if (escaped || quote) return null;
  flush();
  return tokens;
}

function unwrapShell(tokens) {
  if (tokens.length < 3 || !SHELLS.has(executableName(tokens[0]))) return tokens;
  const commandFlagIndex = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c[a-z]*$/i.test(token));
  if (commandFlagIndex < 0 || tokens.length !== commandFlagIndex + 2) return tokens;
  return tokenizeShell(tokens[commandFlagIndex + 1]);
}

function commandSegments(tokens) {
  const segments = [];
  let current = [];
  let groupingDepth = 0;
  let substitutionDepth = 0;
  let skipNextToken = false;
  const flush = () => {
    if (current.length > 0) segments.push({ tokens: current, nested: substitutionDepth > 0 });
    current = [];
  };
  for (const token of tokens) {
    if (token === "$(") {
      flush();
      substitutionDepth += 1;
      continue;
    }
    if (token === "(") {
      flush();
      groupingDepth += 1;
      continue;
    }
    if (token === ")") {
      flush();
      if (substitutionDepth > 0) substitutionDepth -= 1;
      else if (groupingDepth > 0) groupingDepth -= 1;
      else return null;
      continue;
    }
    if (OPERATORS.has(token)) {
      flush();
      continue;
    }
    if (REDIRECTION.test(token)) {
      // A redirection ends the argument list of the current command. Its target is
      // never a test-selection argument, so it must not enter the semantic digest.
      flush();
      if (/^(?:\d*>>?|\d*<|&>>?)$/.test(token)) skipNextToken = true;
      continue;
    }
    if (skipNextToken) {
      skipNextToken = false;
      continue;
    }
    current.push(token);
  }
  flush();
  if (groupingDepth !== 0 || substitutionDepth !== 0) return null;
  return segments;
}

export function decomposeShellCommand(command) {
  if (typeof command !== "string") return null;
  const outerTokens = tokenizeShell(command);
  if (!outerTokens) return null;
  const tokens = unwrapShell(outerTokens);
  if (!tokens) return null;
  const segments = commandSegments(tokens);
  return segments;
}

function environmentPrefix(segment) {
  const assignments = [];
  let index = segment[0] === "env" ? 1 : 0;
  while (index < segment.length) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(segment[index]);
    if (!match) break;
    assignments.push([match[1], match[2]]);
    index += 1;
  }
  return { assignments, index };
}

function runnerAt(tokens, index) {
  const first = executableName(tokens[index] ?? "");
  const second = (tokens[index + 1] ?? "").toLowerCase();
  const third = executableName(tokens[index + 2] ?? "");

  if (first === "uv" && second === "run" && third === "pytest") {
    return { command: ["uv", "run", "pytest"], argumentsIndex: index + 3 };
  }
  if (/^python3?$/.test(first) && second === "-m" && third === "pytest") {
    return { command: [first, "-m", "pytest"], argumentsIndex: index + 3 };
  }
  if (first === "pytest") return { command: ["pytest"], argumentsIndex: index + 1 };

  if (["npm", "pnpm", "yarn", "bun"].includes(first)) {
    const scriptIndex = second === "run" ? index + 2 : index + 1;
    const script = (tokens[scriptIndex] ?? "").toLowerCase();
    if (script === "test" || script === "t") {
      return { command: [first, "test"], argumentsIndex: scriptIndex + 1 };
    }
    if (script === "check") {
      return { command: [first, "run", "check"], argumentsIndex: scriptIndex + 1 };
    }
  }

  const wrapperLength = first === "npx" || first === "bunx" ? 1
    : ((first === "pnpm" && second === "exec") || (first === "yarn" && second === "dlx") ? 2 : 0);
  const tool = executableName(tokens[index + wrapperLength] ?? "");
  if (["vitest", "jest", "mocha", "ava"].includes(tool)) {
    return {
      command: wrapperLength === 0 ? [tool] : [...tokens.slice(index, index + wrapperLength).map(executableName), tool],
      argumentsIndex: index + wrapperLength + 1,
    };
  }

  if (first === "node" && second === "--test") return { command: ["node", "--test"], argumentsIndex: index + 2 };
  if (first === "deno" && second === "test") return { command: ["deno", "test"], argumentsIndex: index + 2 };
  if (["go", "cargo", "dotnet"].includes(first) && second === "test") {
    return { command: [first, "test"], argumentsIndex: index + 2 };
  }
  if (/^(?:mvnw?|gradlew?)$/.test(first.replace(/^\.\//, "")) && second === "test") {
    return { command: [first, "test"], argumentsIndex: index + 2 };
  }
  return null;
}

function incompleteAnalysis(command, normalized, reason) {
  const semanticDigest = sha256(JSON.stringify({ raw_command: command }));
  return {
    command: normalized,
    canonicalId: canonicalTestCommandId(normalized ?? ["unidentified"], semanticDigest),
    selection: { bounded: false, reason: "incomplete_semantics", targets: [] },
    semantics: {
      version: 1,
      complete: false,
      reason,
      cwd_sha256: null,
      environment_sha256: null,
      arguments_sha256: null,
      semantic_sha256: semanticDigest,
    },
  };
}

// There is exactly one notion of "invokes a test runner": a segment whose executable, after any
// env-assignment prefix, is a runner per `runnerAt`. Both the policy decision and the pilot audit
// derive from this segment decomposition. A runner name appearing inside an argument — a search
// pattern, an echo string — is not an invocation, and no whole-string matcher may say otherwise:
// that second, looser reading is what spent denials on `rg 'pytest' src/` in the six-task pilot.
function segmentRunner(segment) {
  const prefix = environmentPrefix(segment);
  const runner = runnerAt(segment, prefix.index);
  return runner ? { runner, prefix } : null;
}

export function analyzeTestRunnerCommand(command, { cwdSha256 = null } = {}) {
  if (typeof command !== "string") return null;
  const decomposed = decomposeShellCommand(command);
  // An unparseable command cannot be shown not to invoke a runner, so it fails closed rather
  // than being waved through as non-test.
  if (!decomposed) return incompleteAnalysis(command, null, "unparseable_shell_command");

  let effectiveCwdSha256 = DIGEST.test(cwdSha256 ?? "") ? cwdSha256.toLowerCase() : null;
  const matches = [];
  for (const { tokens: segment, nested } of decomposed) {
    const prefix = environmentPrefix(segment);
    const executable = executableName(segment[prefix.index] ?? "");
    if (executable === "cd" && segment.length === prefix.index + 2) {
      const directory = segment[prefix.index + 1];
      if (directory === "." || directory === "./") continue;
      effectiveCwdSha256 = effectiveCwdSha256
        ? sha256(JSON.stringify({ base: effectiveCwdSha256, directory }))
        : null;
      continue;
    }
    const runner = runnerAt(segment, prefix.index);
    if (runner) {
      if (nested) return incompleteAnalysis(command, runner.command, "nested_runner_structure_unrecognized");
      matches.push({
        command: runner.command,
        arguments: segment.slice(runner.argumentsIndex),
        environment: prefix.assignments,
        cwdSha256: effectiveCwdSha256,
      });
    }
  }
  // No segment invokes a runner, so this is not a test command at all — regardless of which
  // runner names its arguments happen to mention.
  if (matches.length === 0) return null;
  if (matches.length > 1) return incompleteAnalysis(command, null, "multiple_runner_commands");

  const match = matches[0];
  if (!match.cwdSha256) return incompleteAnalysis(command, match.command, "missing_working_directory_evidence");
  const positional = match.arguments.filter((argument) => !argument.startsWith("-"));
  const globTarget = positional.find((argument) => /[*?[]/.test(argument));
  const environment = [...match.environment].sort(([left], [right]) => left.localeCompare(right));
  const environmentSha256 = sha256(JSON.stringify(environment));
  const argumentsSha256 = sha256(JSON.stringify(match.arguments));
  const semanticDigest = sha256(JSON.stringify({
    command: match.command,
    cwd_sha256: match.cwdSha256,
    environment,
    arguments: match.arguments,
  }));
  return {
    command: match.command,
    canonicalId: canonicalTestCommandId(match.command, semanticDigest),
    // Selection scope is decision input only. It never enters the trace or the ledger,
    // because it would carry raw argument text. `targets` lets a policy compare the
    // selected files against the set the full suite would run.
    selection: globTarget
      ? { bounded: false, reason: "glob_target", targets: [] }
      : { bounded: true, reason: null, targets: positional.filter((argument) => PATH_LIKE.test(argument)) },
    semantics: {
      version: 1,
      complete: true,
      reason: null,
      cwd_sha256: match.cwdSha256,
      environment_sha256: environmentSha256,
      arguments_sha256: argumentsSha256,
      semantic_sha256: semanticDigest,
    },
  };
}

export function isTestRunnerCommand(command) {
  if (typeof command !== "string") return false;
  const decomposed = decomposeShellCommand(command);
  // Fail closed on unparseable shell: it cannot be shown not to invoke a runner.
  if (!decomposed) return true;
  return decomposed.some(({ tokens }) => segmentRunner(tokens) !== null);
}

export function canonicalTestCommandId(command, semanticDigest = null) {
  const runner = `baseline:${command.join(":")}`;
  return semanticDigest ? `${runner}:semantic:${semanticDigest}` : runner;
}
