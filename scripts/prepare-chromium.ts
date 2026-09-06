import { chmodSync, cpSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const source = process.env.CORTEX_CHROMIUM_PATH?.trim();
const filename = process.platform === "win32" ? "chrome.exe" : "chrome";
const targetDirectory = join(projectRoot, "resources", "chromium");
const target = join(targetDirectory, filename);

if (!source) {
  throw new Error("Set CORTEX_CHROMIUM_PATH to a pinned Chromium executable before building the desktop bundle.");
}
if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Configured Chromium executable does not exist: ${source}`);
}

mkdirSync(targetDirectory, { recursive: true });
if (process.platform === "darwin") {
  let appRoot = source;
  while (!appRoot.endsWith(".app") && dirname(appRoot) !== appRoot) appRoot = dirname(appRoot);
  if (!appRoot.endsWith(".app")) throw new Error(`On macOS, CORTEX_CHROMIUM_PATH must point inside a Chromium .app bundle: ${source}`);
  const appTarget = join(targetDirectory, "Chromium.app");
  // A local developer may point at the already-prepared resource. Copying a
  // directory onto itself with cpSync can partially delete bundle files on
  // macOS, so treat that layout as already prepared.
  if (resolve(appRoot) !== resolve(appTarget)) cpSync(appRoot, appTarget, { recursive: true, force: true });
  console.log(`Prepared Chromium resource: ${appTarget} (executable: ${basename(source)})`);
} else {
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  console.log(`Prepared Chromium resource: ${target}`);
}
