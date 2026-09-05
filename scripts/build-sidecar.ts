import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SIDECAR_BASENAME = "cortex-sidecar";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(scriptRoot, "..");
export const sidecarEntry = resolve(projectRoot, "src", "cli.ts");
export const sidecarOutputDirectory = resolve(projectRoot, "ui", "src-tauri", "binaries");

function rustcHost(): string {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to determine the Rust target triple: ${result.stderr || "rustc failed"}`);
  }
  const host = result.stdout.match(/^host:\s*(\S+)\s*$/m)?.[1];
  if (!host) throw new Error("rustc -vV did not report a host target triple.");
  return host;
}

export function targetTriple(explicit?: string): string {
  return explicit ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? rustcHost();
}

export function sidecarOutputPath(target: string): string {
  return join(sidecarOutputDirectory, `${SIDECAR_BASENAME}-${target}`);
}

export function bunTargetForRustTarget(target: string): string {
  const targets: Record<string, string> = {
    "aarch64-apple-darwin": "bun-darwin-arm64",
    "x86_64-apple-darwin": "bun-darwin-x64",
    "aarch64-unknown-linux-gnu": "bun-linux-arm64",
    "x86_64-unknown-linux-gnu": "bun-linux-x64",
    "aarch64-unknown-linux-musl": "bun-linux-arm64-musl",
    "x86_64-unknown-linux-musl": "bun-linux-x64-musl",
    "aarch64-pc-windows-msvc": "bun-windows-arm64",
    "x86_64-pc-windows-msvc": "bun-windows-x64",
  };
  const bunTarget = targets[target];
  if (!bunTarget) throw new Error(`No Bun compile target mapping exists for Rust target ${target}.`);
  return bunTarget;
}

export function buildCommand(target: string, outputPath = sidecarOutputPath(target)): string[] {
  return [
    "build",
    "--compile",
    "--production",
    "--target",
    bunTargetForRustTarget(target),
    "--external",
    "@parcel/watcher",
    sidecarEntry,
    "--outfile",
    outputPath,
  ];
}

export function parseArguments(args: string[]): { dryRun: boolean; target?: string } {
  let dryRun = false;
  let target: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--target") target = args[++index];
    else if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/build-sidecar.ts [--dry-run] [--target <rust-target-triple>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { dryRun, target };
}

export function buildSidecar(target = targetTriple()): string {
  const outputPath = sidecarOutputPath(target);
  mkdirSync(sidecarOutputDirectory, { recursive: true });
  const result = spawnSync(process.execPath, buildCommand(target, outputPath), {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Bun sidecar compilation failed with exit code ${result.status ?? "unknown"}.`);
  return outputPath;
}

if (import.meta.main) {
  const { dryRun, target: explicitTarget } = parseArguments(process.argv.slice(2));
  const target = targetTriple(explicitTarget);
  const outputPath = sidecarOutputPath(target);
  const command = buildCommand(target, outputPath);
  if (dryRun) {
    console.log(JSON.stringify({ target, outputPath, entrypoint: sidecarEntry, command }, null, 2));
  } else {
    const builtPath = buildSidecar(target);
    console.log(`Cortex sidecar built for ${target}: ${builtPath}`);
  }
}
