import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BundleVerification {
  valid: boolean;
  bundlePath: string;
  sidecarPath: string;
  uiIndexPath: string;
  chromiumPath: string;
  errors: string[];
}

export function verifyBundleLayout(bundlePath: string): BundleVerification {
  const bundle = resolve(bundlePath);
  const sidecarPath = join(bundle, "Contents", "MacOS", "cortex-sidecar");
  const uiIndexPath = join(bundle, "Contents", "Resources", "dist", "index.html");
  const chromiumCandidates = process.platform === "darwin"
    ? [
        join(bundle, "Contents", "Resources", "chromium", "Chromium.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(bundle, "Contents", "Resources", "chromium", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]
    : [join(bundle, "Contents", "Resources", "chromium", process.platform === "win32" ? "chrome.exe" : "chrome")];
  const chromiumPath = chromiumCandidates.find((candidate) => existsSync(candidate)) ?? chromiumCandidates[0];
  const errors: string[] = [];
  if (!bundle.endsWith(".app")) errors.push("Bundle path must end with .app.");
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) errors.push("Cortex.app does not exist.");
  if (!existsSync(sidecarPath) || !statSync(sidecarPath).isFile()) errors.push("Packaged cortex-sidecar is missing.");
  else if ((statSync(sidecarPath).mode & 0o111) === 0) errors.push("Packaged cortex-sidecar is not executable.");
  if (!existsSync(uiIndexPath) || !statSync(uiIndexPath).isFile()) errors.push("Packaged UI dist/index.html is missing.");
  if (!existsSync(chromiumPath) || !statSync(chromiumPath).isFile()) errors.push("Packaged Chromium renderer is missing.");
  return { valid: errors.length === 0, bundlePath: bundle, sidecarPath, uiIndexPath, chromiumPath, errors };
}

if (import.meta.main) {
  const bundlePath = process.argv[2];
  if (!bundlePath) throw new Error("Usage: bun run scripts/verify-bundle.ts <Cortex.app>");
  const result = verifyBundleLayout(bundlePath);
  if (!result.valid) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }
  console.log(`Verified unsigned Cortex bundle: ${result.bundlePath}`);
  console.log(`Sidecar: ${result.sidecarPath}`);
  console.log(`UI: ${result.uiIndexPath}`);
  console.log(`Chromium: ${result.chromiumPath}`);
}
