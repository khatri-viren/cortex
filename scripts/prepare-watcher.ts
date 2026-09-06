import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

export type PreparedWatcherResource = {
  modulePath: string;
  embeddedNativePath: string;
  nativePackage: string;
  nativePath: string;
  runtimePackages: string[];
  targetRoot: string;
};

function packagePath(nodeModules: string, packageName: string): string {
  return join(nodeModules, ...packageName.split("/"));
}

function copyRuntimePackage(
  packageName: string,
  sourceNodeModules: string,
  targetNodeModules: string,
  copied: Set<string>,
): void {
  if (copied.has(packageName)) return;
  const source = packagePath(sourceNodeModules, packageName);
  const manifestPath = join(source, "package.json");
  if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Runtime dependency ${packageName} is missing at ${source}.`);
  }
  copied.add(packageName);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    copyRuntimePackage(dependency, sourceNodeModules, targetNodeModules, copied);
  }
  const target = packagePath(targetNodeModules, packageName);
  mkdirSync(resolve(target, ".."), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

export function nativeWatcherPackage(
  platform = process.platform,
  architecture = process.arch,
  parcelDirectory = resolve(projectRoot, "node_modules", "@parcel"),
): string {
  const prefix = `watcher-${platform}-${architecture}`;
  const candidates = readdirSync(parcelDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === prefix || entry.name.startsWith(`${prefix}-`)))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected one installed native @parcel watcher package for ${platform}/${architecture}, found: ${candidates.join(", ") || "none"}.`);
  }
  return candidates[0];
}

export function prepareWatcherResource(
  sourceNodeModules = resolve(projectRoot, "node_modules"),
  targetNodeModules = resolve(projectRoot, "resources", "node_modules"),
): PreparedWatcherResource {
  const sourceParcel = join(sourceNodeModules, "@parcel");
  const sourceModule = join(sourceParcel, "watcher");
  if (!statSync(sourceModule, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Installed @parcel/watcher module is missing at ${sourceModule}.`);
  }

  const nativePackage = nativeWatcherPackage(process.platform, process.arch, sourceParcel);
  const sourceNative = join(sourceParcel, nativePackage);
  const targetParcel = join(targetNodeModules, "@parcel");
  const modulePath = join(targetParcel, "watcher");
  const nativePackagePath = join(targetParcel, nativePackage);
  const runtimePackages = new Set<string>();
  copyRuntimePackage("@parcel/watcher", sourceNodeModules, targetNodeModules, runtimePackages);
  mkdirSync(targetParcel, { recursive: true });
  cpSync(sourceNative, nativePackagePath, { recursive: true, force: true });

  const nativePath = join(nativePackagePath, "watcher.node");
  const embeddedNativePath = join(modulePath, "build", "Release", "watcher.node");
  mkdirSync(resolve(embeddedNativePath, ".."), { recursive: true });
  copyFileSync(nativePath, embeddedNativePath);
  if (!existsSync(join(modulePath, "index.js")) || !existsSync(nativePath) || !existsSync(embeddedNativePath)) {
    throw new Error("Prepared @parcel/watcher resource is incomplete.");
  }
  return { modulePath, embeddedNativePath, nativePackage, nativePath, runtimePackages: [...runtimePackages].sort(), targetRoot: targetNodeModules };
}

if (import.meta.main) {
  const prepared = prepareWatcherResource();
  console.log(`Prepared native watcher resource: ${prepared.nativePackage} at ${prepared.targetRoot}`);
}
