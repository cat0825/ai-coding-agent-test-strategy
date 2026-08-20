import { createHash } from "node:crypto";

const TEST_RUNNER_RULES = Object.freeze([
  {
    pattern: /(?:^|[\s"';&|()\n])(?:(uv)\s+run\s+)?(?:(python(?:3)?)\s+-m\s+)?(pytest)(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      if (match[1]) return ["uv", "run", "pytest"];
      if (match[2]) return [match[2].toLowerCase(), "-m", "pytest"];
      return ["pytest"];
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|t)(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), match[2].toLowerCase() === "t" ? "test" : match[2].toLowerCase()];
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(check)(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), "run", match[2].toLowerCase()];
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])(?:(npx|pnpm\s+exec|yarn\s+dlx|bunx)\s+)?(vitest|jest|mocha|ava)(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return match[1]
        ? [...match[1].toLowerCase().split(/\s+/), match[2].toLowerCase()]
        : [match[2].toLowerCase()];
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])(node\s+--test|deno\s+test)(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return match[1].toLowerCase().split(/\s+/);
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])(go|cargo|dotnet)\s+test(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), "test"];
    },
  },
  {
    pattern: /(?:^|[\s"';&|()\n])((?:\.\/)?(?:mvnw?|gradlew?))\s+test(?=[\s"';&|()\n]|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), "test"];
    },
  },
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OPERATORS = new Set(["&&", "||", ";", "|", "(", ")", "$(", "\\n"]);
const DIGEST = /^[a-f0-9]{64}$/i;

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
    canonicalId: canonicalTestCommandId(normalized, semanticDigest),
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

export function normalizeTestRunnerCommand(command) {
  if (typeof command !== "string") return null;
  for (const rule of TEST_RUNNER_RULES) {
    const match = rule.pattern.exec(command);
    if (match) return rule.normalize(match);
  }
  return null;
}

export function analyzeTestRunnerCommand(command, { cwdSha256 = null } = {}) {
  const normalized = normalizeTestRunnerCommand(command);
  if (!normalized) return null;
  const decomposed = decomposeShellCommand(command);
  if (!decomposed) return incompleteAnalysis(command, normalized, "unparseable_shell_command");

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
  if (matches.length !== 1) {
    return incompleteAnalysis(command, normalized, matches.length === 0 ? "runner_structure_unrecognized" : "multiple_runner_commands");
  }

  const match = matches[0];
  if (!match.cwdSha256) return incompleteAnalysis(command, match.command, "missing_working_directory_evidence");
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
  return normalizeTestRunnerCommand(command) !== null;
}

export function canonicalTestCommandId(command, semanticDigest = null) {
  const runner = `baseline:${command.join(":")}`;
  return semanticDigest ? `${runner}:semantic:${semanticDigest}` : runner;
}
