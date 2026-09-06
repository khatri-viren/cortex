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
import { nativeWatcherPackage, prepareWatcherResource } from "../scripts/prepare-watcher.js";
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
    mainBinaryName?: string;
    build?: { beforeDevCommand?: string; devUrl?: string; beforeBuildCommand?: string };
    bundle?: { externalBin?: string[]; resources?: string[] | Record<string, string> };
  };
  expect(config.mainBinaryName).toBe("app");
  expect(config.build?.beforeDevCommand).toBe("bun run dev");
  expect(config.build?.devUrl).toBe("http://127.0.0.1:5175");
  expect(config.build?.beforeBuildCommand).toContain("desktop:sidecar");
  expect(config.build?.beforeBuildCommand).toContain("prepare-watcher.ts");
  expect(config.bundle?.externalBin).toContain("binaries/cortex-sidecar");
  expect(config.bundle?.resources).toEqual({ "../dist": "dist", "../../resources/chromium": "chromium", "../../resources/node_modules": "node_modules" });
});

test("desktop packaging prepares the active native watcher next to its JS module", () => {
  const nativePackage = nativeWatcherPackage();
  const target = join(mkdtempSync(join(tmpdir(), "cortex-watcher-resource-")), "node_modules");
  const prepared = prepareWatcherResource(resolve(root, "node_modules"), target);
  expect(prepared.nativePackage).toBe(nativePackage);
  expect(readFileSync(join(prepared.modulePath, "package.json"), "utf8")).toContain("@parcel/watcher");
  expect(readFileSync(prepared.nativePath).byteLength).toBeGreaterThan(0);
  expect(readFileSync(prepared.embeddedNativePath).byteLength).toBeGreaterThan(0);
  expect(prepared.runtimePackages).toEqual(expect.arrayContaining(["@parcel/watcher", "picomatch", "is-glob", "is-extglob"]));
  rmSync(target, { recursive: true, force: true });
});

test("desktop Cargo manifest defaults to the app and feature-gates the benchmark-only probe", () => {
  const cargo = readFileSync(resolve(root, "ui", "src-tauri", "Cargo.toml"), "utf8");
  expect(cargo).toContain('default-run = "app"');
  expect(cargo).toContain("projection-probe = []");
  expect(cargo).toContain("required-features = [\"projection-probe\"]");
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
  const nativePackage = nativeWatcherPackage();
  mkdirSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", "watcher"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", "watcher", "build", "Release"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", nativePackage), { recursive: true });
  const sidecar = join(bundle, "Contents", "MacOS", "cortex-sidecar");
  writeFileSync(sidecar, "sidecar");
  chmodSync(sidecar, 0o755);
  writeFileSync(join(bundle, "Contents", "Resources", "dist", "index.html"), "<html></html>");
  writeFileSync(join(bundle, "Contents", "Resources", "chromium", "Chromium.app", "Contents", "MacOS", "Google Chrome for Testing"), "chromium");
  writeFileSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", "watcher", "index.js"), "watcher");
  writeFileSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", "watcher", "build", "Release", "watcher.node"), "embedded-native");
  writeFileSync(join(bundle, "Contents", "Resources", "node_modules", "@parcel", nativePackage, "watcher.node"), "native");
  const result = verifyBundleLayout(bundle);
  expect(result.valid).toBe(true);
  expect(result.sidecarPath).toEndWith("Contents/MacOS/cortex-sidecar");
  expect(result.uiIndexPath).toEndWith("Contents/Resources/dist/index.html");
  rmSync(bundle, { recursive: true, force: true });
});
