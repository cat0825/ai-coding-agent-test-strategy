#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderTraceReplay } from "./replay.mjs";

function usage() {
  return "Usage: node src/replay-cli.mjs <trace.json> <replay.html>\n";
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (argv.length !== 2) throw new Error(usage().trim());

  const inputPath = path.resolve(argv[0]);
  const outputPath = path.resolve(argv[1]);
  const trace = JSON.parse(await readFile(inputPath, "utf8"));
  const html = renderTraceReplay(trace);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  process.stdout.write(`${outputPath}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
