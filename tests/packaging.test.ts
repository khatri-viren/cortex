import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SIDECAR_BASENAME,
  bunTargetForRustTarget,
  buildCommand,
  parseArguments,
  sidecarOutputPath,
  targetTriple,
} from "../scripts/build-sidecar.js";
import { buildManifest, parseManifestArguments } from "../scripts/build-update-manifest.js";
import { verifyBundleLayout } from "../scripts/verify-bundle.js";
import { loggerOptions } from "../src/logger.js";

const root = resolve(import.meta.dir, "..");

test("packaged logger options do not require a dynamic pretty transport", () => {
  expect(loggerOptions(true)).toEqual({ level: "info" });
  expect(loggerOptions(false)).toMatchObject({
    level: "info",
    transport: { target: "pino-pretty" },
  });
});

test("desktop packaging names the sidecar for the active Rust target", () => {
  const target = targetTriple();
  expect(sidecarOutputPath(target)).toEndWith(`${SIDECAR_BASENAME}-${target}`);
  expect(bunTargetForRustTarget(target)).toMatch(/^bun-/);
  expect(buildCommand(target)).toEqual([
    "build",
    "--compile",
    "--production",
    "--target",
    bunTargetForRustTarget(target),
    "--external",
    "@parcel/watcher",
    resolve(root, "src", "cli.ts"),
    "--outfile",
    sidecarOutputPath(target),
  ]);
});

test("desktop sidecar arguments support a deterministic dry run", () => {
  expect(parseArguments(["--dry-run", "--target=aarch64-apple-darwin"])).toEqual({
    dryRun: true,
    target: "aarch64-apple-darwin",
  });
});

test("Tauri release config packages the UI resource and external sidecar", () => {
  const config = JSON.parse(readFileSync(resolve(root, "ui", "src-tauri", "tauri.conf.json"), "utf8")) as {
    build?: { beforeDevCommand?: string; devUrl?: string; beforeBuildCommand?: string };
    bundle?: { externalBin?: string[]; resources?: string[] | Record<string, string> };
  };
  expect(config.build?.beforeDevCommand).toBe("bun run dev");
  expect(config.build?.devUrl).toBe("http://127.0.0.1:5175");
  expect(config.build?.beforeBuildCommand).toContain("desktop:sidecar");
  expect(config.bundle?.externalBin).toContain("binaries/cortex-sidecar");
  expect(config.bundle?.resources).toEqual({ "../dist": "dist", "../../resources/chromium": "chromium" });
});

test("update manifest tooling accepts deterministic release metadata", () => {
  const args = parseManifestArguments([
    "--artifact=/tmp/Cortex.app.tar.gz",
    "--output=/tmp/update.json",
    "--version=0.2.0",
    "--architecture=x86_64",
    "--channel=nightly",
  ]);
  expect(args).toMatchObject({
    output: "/tmp/update.json",
    version: "0.2.0",
    path: "Cortex.app.tar.gz",
    architecture: "x86_64",
    channel: "nightly",
  });
});

test("bundle verification requires the unsigned app layout to contain sidecar and UI resources", () => {
  const bundle = join(mkdtempSync(join(tmpdir(), "cortex-bundle-test-")), "Cortex.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "dist"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "chromium", "Chromium.app", "Contents", "MacOS"), { recursive: true });
  const sidecar = join(bundle, "Contents", "MacOS", "cortex-sidecar");
  writeFileSync(sidecar, "sidecar");
  chmodSync(sidecar, 0o755);
  writeFileSync(join(bundle, "Contents", "Resources", "dist", "index.html"), "<html></html>");
  writeFileSync(join(bundle, "Contents", "Resources", "chromium", "Chromium.app", "Contents", "MacOS", "Google Chrome for Testing"), "chromium");
  const result = verifyBundleLayout(bundle);
  expect(result.valid).toBe(true);
  expect(result.sidecarPath).toEndWith("Contents/MacOS/cortex-sidecar");
  expect(result.uiIndexPath).toEndWith("Contents/Resources/dist/index.html");
  rmSync(bundle, { recursive: true, force: true });
});
