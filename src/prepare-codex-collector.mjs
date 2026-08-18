#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return "Usage: node src/prepare-codex-collector.mjs --real-codex <binary> --bin-dir <private-dir> --lifecycle-dir <output-dir>\n";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--real-codex", "--bin-dir", "--lifecycle-dir"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replaceAll("-", "_")] = value;
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
  for (const option of ["real_codex", "bin_dir", "lifecycle_dir"]) {
    if (!options[option]) throw new Error(`--${option.replaceAll("_", "-")} is required`);
  }

  const realCodex = path.resolve(options.real_codex);
  const binDir = path.resolve(options.bin_dir);
  const lifecycleDir = path.resolve(options.lifecycle_dir);
  await access(realCodex, constants.X_OK);
  if (realCodex === path.join(binDir, "codex")) throw new Error("--real-codex must not point at the collector wrapper");

  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/codex-lifecycle-wrapper.py");
  const source = await readFile(sourcePath);
  const collectorSha256 = createHash("sha256").update(source).digest("hex");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await mkdir(lifecycleDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  await chmod(lifecycleDir, 0o700);
  const wrapperPath = path.join(binDir, "codex");
  await copyFile(sourcePath, wrapperPath);
  await chmod(wrapperPath, 0o700);
  const configPath = path.join(binDir, "codex-lifecycle-config.json");
  await writeFile(configPath, `${JSON.stringify({
    schema_version: 1,
    real_codex: realCodex,
    lifecycle_dir: lifecycleDir,
    collector_sha256: collectorSha256,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
  process.stdout.write(`${JSON.stringify({ bin_dir: binDir, lifecycle_dir: lifecycleDir, collector_sha256: collectorSha256 })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
