#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendRecommendationAudit, evaluateRecommendations } from "./recommendations.mjs";

function usage() {
  return `Usage: node src/recommend-cli.mjs <expert|simplified> <trace.json> [options]

Options:
  --audit-output <path>              Write a VerifyTrace with recommendation/decision events.
  --decision <id>=<outcome>:<reason> Record a user decision; repeat as needed.
  --help                             Show this help.
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseDecision(value) {
  const idSeparator = value.indexOf("=");
  const outcomeSeparator = value.indexOf(":", idSeparator + 1);
  if (idSeparator < 1 || outcomeSeparator < idSeparator + 2 || outcomeSeparator === value.length - 1) {
    throw new Error("--decision must use <id>=<outcome>:<reason>");
  }
  return {
    recommendationId: value.slice(0, idSeparator),
    outcome: value.slice(idSeparator + 1, outcomeSeparator),
    reason: value.slice(outcomeSeparator + 1),
  };
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.length < 2) throw new Error(usage().trim());
  const options = { mode: argv[0], input: argv[1], auditOutput: null, decisions: {} };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--audit-output") {
      options.auditOutput = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--decision") {
      const decision = parseDecision(takeValue(argv, index, argument));
      if (Object.hasOwn(options.decisions, decision.recommendationId)) {
        throw new Error(`Duplicate decision for ${decision.recommendationId}`);
      }
      options.decisions[decision.recommendationId] = {
        outcome: decision.outcome,
        reason: decision.reason,
      };
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const trace = JSON.parse(await readFile(path.resolve(options.input), "utf8"));
  const evaluation = evaluateRecommendations(trace, { mode: options.mode });
  const auditedTrace = appendRecommendationAudit(trace, evaluation, { decisions: options.decisions });
  let auditOutput = null;
  if (options.auditOutput) {
    auditOutput = path.resolve(options.auditOutput);
    await mkdir(path.dirname(auditOutput), { recursive: true });
    await writeFile(auditOutput, `${JSON.stringify(auditedTrace, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ ...evaluation, audited_trace: auditedTrace, audit_output: auditOutput }, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
