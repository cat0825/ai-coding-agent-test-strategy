import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function resolveManifestPath(value, manifestDirectory) {
  return path.isAbsolute(value) ? value : path.resolve(manifestDirectory, value);
}

export async function verifyCollectorProvenance({ collector, collectorManifestPath, controlledCollectorPath }) {
  const manifestPath = await realpath(collectorManifestPath);
  const manifestDirectory = path.dirname(manifestPath);
  let implementationPath;
  if (typeof collector.wrapper_path === "string" && collector.wrapper_path.length > 0) {
    implementationPath = resolveManifestPath(collector.wrapper_path, manifestDirectory);
  } else if (typeof collector.bin_dir === "string" && collector.bin_dir.length > 0) {
    implementationPath = path.join(resolveManifestPath(collector.bin_dir, manifestDirectory), "codex");
  } else if (collector.schema_version === 1) {
    implementationPath = path.join(manifestDirectory, "codex");
  } else {
    throw new Error("Collector manifest does not identify the wrapper implementation");
  }

  const [implementation, controlledImplementation] = await Promise.all([
    readFile(await realpath(implementationPath)),
    readFile(await realpath(controlledCollectorPath)),
  ]);
  const implementationSha256 = sha256(implementation);
  const controlledSha256 = sha256(controlledImplementation);
  if (implementationSha256 !== collector.collector_sha256) {
    throw new Error("Collector manifest digest does not match the wrapper implementation");
  }
  if (implementationSha256 !== controlledSha256) {
    throw new Error("Collector wrapper does not match the controlled project implementation");
  }
  return { collector_sha256: implementationSha256 };
}
