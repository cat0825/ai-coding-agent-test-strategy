const TEST_RUNNER_RULES = Object.freeze([
  {
    pattern: /(?:^|[\s"';&|])(?:(uv)\s+run\s+)?(?:(python(?:3)?)\s+-m\s+)?(pytest)(?:\s|$)/i,
    normalize(match) {
      if (match[1]) return ["uv", "run", "pytest"];
      if (match[2]) return [match[2].toLowerCase(), "-m", "pytest"];
      return ["pytest"];
    },
  },
  {
    pattern: /(?:^|[\s"';&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|t)(?:\s|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), match[2].toLowerCase() === "t" ? "test" : match[2].toLowerCase()];
    },
  },
  {
    pattern: /(?:^|[\s"';&|])(?:(npx|pnpm\s+exec|yarn\s+dlx|bunx)\s+)?(vitest|jest|mocha|ava)(?:\s|$)/i,
    normalize(match) {
      return match[1]
        ? [...match[1].toLowerCase().split(/\s+/), match[2].toLowerCase()]
        : [match[2].toLowerCase()];
    },
  },
  {
    pattern: /(?:^|[\s"';&|])(node\s+--test|deno\s+test)(?:\s|$)/i,
    normalize(match) {
      return match[1].toLowerCase().split(/\s+/);
    },
  },
  {
    pattern: /(?:^|[\s"';&|])(go|cargo|dotnet)\s+test(?:\s|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), "test"];
    },
  },
  {
    pattern: /(?:^|[\s"';&|])((?:\.\/)?(?:mvnw?|gradlew?))\s+test(?:\s|$)/i,
    normalize(match) {
      return [match[1].toLowerCase(), "test"];
    },
  },
]);

export function normalizeTestRunnerCommand(command) {
  if (typeof command !== "string") return null;
  for (const rule of TEST_RUNNER_RULES) {
    const match = rule.pattern.exec(command);
    if (match) return rule.normalize(match);
  }
  return null;
}

export function isTestRunnerCommand(command) {
  return normalizeTestRunnerCommand(command) !== null;
}

export function canonicalTestCommandId(command) {
  return `baseline:${command.join(":")}`;
}
