#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateBenchmarkManifest, stableJson } from "./benchmark-preflight.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node src/benchmark-preflight-cli.mjs --repo <path> --spec <path> --output <path>\n`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--repo", "--spec", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
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
  for (const option of ["repo", "spec", "output"]) {
    if (!options[option]) throw new Error(`--${option} is required`);
  }
  const specPath = path.resolve(projectRoot, options.spec);
  const outputPath = path.resolve(projectRoot, options.output);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const manifest = await generateBenchmarkManifest({ repoRoot: path.resolve(options.repo), spec });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stableJson(manifest), "utf8");
  process.stdout.write(`${JSON.stringify({ status: manifest.conclusion.status, reasons: manifest.conclusion.reasons })}\n`);
  if (manifest.conclusion.status !== "eligible") process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
