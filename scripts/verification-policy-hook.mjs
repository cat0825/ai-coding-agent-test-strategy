#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { codexHookResponse, evaluateVerificationPolicyHook } from "../src/verification-policy-hook.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readStdin() {
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk;
  return contents;
}

async function main() {
  const configPath = argument("--config");
  const statePath = argument("--state");
  const ledgerPath = argument("--ledger");
  if (!configPath || !statePath || !ledgerPath) {
    throw new Error("Usage: verification-policy-hook --config FILE --state FILE --ledger FILE");
  }
  const payload = JSON.parse(await readStdin());
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const result = await evaluateVerificationPolicyHook({ payload, config, statePath, ledgerPath });
  const response = codexHookResponse(result);
  if (Object.keys(response).length > 0) process.stdout.write(`${JSON.stringify(response)}\n`);
  if (result.decision === "deny") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
