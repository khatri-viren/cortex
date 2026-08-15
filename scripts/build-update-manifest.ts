import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createUpdateArtifact,
  createUpdateManifest,
  type UpdateArchitecture,
  type UpdateChannel,
  type UpdatePlatform,
} from "../src/core/update-manifest.js";

export interface ManifestArguments {
  artifact: string;
  output: string;
  version: string;
  path: string;
  platform: UpdatePlatform;
  architecture: UpdateArchitecture;
  channel: UpdateChannel;
}

export function parseManifestArguments(args: string[]): ManifestArguments {
  const values = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [key, value] = arg.slice(2).split("=", 2);
    if (!value) throw new Error(`Argument --${key} requires a value.`);
    values.set(key, value);
  }
  const artifact = values.get("artifact");
  const output = values.get("output");
  const version = values.get("version");
  if (!artifact || !output || !version) throw new Error("Usage: bun run scripts/build-update-manifest.ts --artifact=<path> --output=<path> --version=<semver> [--path=<relative-artifact-name>] [--platform=macos] [--architecture=aarch64|x86_64] [--channel=stable|nightly]");
  const platform = (values.get("platform") ?? "macos") as UpdatePlatform;
  const architecture = (values.get("architecture") ?? "aarch64") as UpdateArchitecture;
  const channel = (values.get("channel") ?? "stable") as UpdateChannel;
  if (platform !== "macos") throw new Error("Only macos update artifacts are supported currently.");
  if (architecture !== "aarch64" && architecture !== "x86_64") throw new Error("Architecture must be aarch64 or x86_64.");
  if (channel !== "stable" && channel !== "nightly") throw new Error("Channel must be stable or nightly.");
  return {
    artifact,
    output,
    version,
    path: values.get("path") ?? artifact.split(/[\\/]/).at(-1)!,
    platform,
    architecture,
    channel,
  };
}

export function buildManifest(args: ManifestArguments) {
  const artifact = createUpdateArtifact({
    artifactPath: resolve(args.artifact),
    path: args.path,
    version: args.version,
    target: { platform: args.platform, architecture: args.architecture },
  });
  return createUpdateManifest({ artifacts: [artifact], channel: args.channel });
}

if (import.meta.main) {
  const args = parseManifestArguments(process.argv.slice(2));
  writeFileSync(resolve(args.output), `${JSON.stringify(buildManifest(args), null, 2)}\n`);
  console.log(`Wrote Cortex ${args.channel} update manifest to ${resolve(args.output)}`);
}
