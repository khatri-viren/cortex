import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export const UPDATE_MANIFEST_SCHEMA_VERSION = 1;

export type UpdatePlatform = "macos";
export type UpdateArchitecture = "aarch64" | "x86_64";
export type UpdateChannel = "stable" | "nightly";

export interface UpdateTarget {
  platform: UpdatePlatform;
  architecture: UpdateArchitecture;
}

export interface UpdateArtifact extends UpdateTarget {
  version: string;
  path: string;
  sha256: string;
  size: number;
}

export interface UpdateManifest {
  schemaVersion: typeof UPDATE_MANIFEST_SCHEMA_VERSION;
  product: "cortex";
  channel: UpdateChannel;
  generatedAt: string;
  artifacts: UpdateArtifact[];
}

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
}

export interface ArtifactVerification {
  valid: boolean;
  reason?: string;
  actualSha256?: string;
  actualSize?: number;
}

function validVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function unsafeArtifactPath(path: string): boolean {
  if (!path || isAbsolute(path)) return true;
  return path.replaceAll("\\", "/").split("/").some((part) => part === "..");
}

/** Validate the untrusted metadata before it is used to select or stage an update. */
export function validateUpdateManifest(manifest: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") return { valid: false, errors: ["Manifest must be an object."] };

  const candidate = manifest as Partial<UpdateManifest>;
  if (candidate.schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) errors.push("Unsupported manifest schema version.");
  if (candidate.product !== "cortex") errors.push("Manifest product must be cortex.");
  if (candidate.channel !== "stable" && candidate.channel !== "nightly") errors.push("Manifest channel is invalid.");
  if (typeof candidate.generatedAt !== "string" || Number.isNaN(Date.parse(candidate.generatedAt))) errors.push("Manifest generatedAt must be an ISO date.");
  if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length === 0) {
    errors.push("Manifest must contain at least one artifact.");
    return { valid: errors.length === 0, errors };
  }

  const targets = new Set<string>();
  candidate.artifacts.forEach((artifact, index) => {
    if (!artifact || typeof artifact !== "object") {
      errors.push(`Artifact ${index} must be an object.`);
      return;
    }
    const item = artifact as Partial<UpdateArtifact>;
    if (typeof item.version !== "string" || !validVersion(item.version)) errors.push(`Artifact ${index} has an invalid version.`);
    if (item.platform !== "macos") errors.push(`Artifact ${index} has an unsupported platform.`);
    if (item.architecture !== "aarch64" && item.architecture !== "x86_64") errors.push(`Artifact ${index} has an unsupported architecture.`);
    if (typeof item.path !== "string" || unsafeArtifactPath(item.path)) errors.push(`Artifact ${index} has an unsafe relative path.`);
    if (typeof item.sha256 !== "string" || !validHash(item.sha256)) errors.push(`Artifact ${index} has an invalid SHA-256 hash.`);
    if (!Number.isSafeInteger(item.size) || (item.size ?? -1) < 0) errors.push(`Artifact ${index} has an invalid size.`);

    const target = `${item.platform ?? ""}:${item.architecture ?? ""}`;
    if (targets.has(target)) errors.push(`Manifest contains duplicate target ${target}.`);
    targets.add(target);
  });

  return { valid: errors.length === 0, errors };
}

function versionParts(version: string): number[] {
  return version.split(/[+-]/, 1)[0].split(".").map((part) => Number(part));
}

/** Return a positive number when `left` is newer than `right`. */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectUpdate(manifest: UpdateManifest, target: UpdateTarget, currentVersion: string): UpdateArtifact | undefined {
  const validation = validateUpdateManifest(manifest);
  if (!validation.valid) throw new Error(`Invalid update manifest: ${validation.errors.join(" ")}`);
  return manifest.artifacts
    .filter((artifact) => artifact.platform === target.platform && artifact.architecture === target.architecture)
    .filter((artifact) => compareVersions(artifact.version, currentVersion) > 0)
    .sort((left, right) => compareVersions(right.version, left.version))[0];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createUpdateArtifact(input: {
  artifactPath: string;
  path: string;
  version: string;
  target: UpdateTarget;
}): UpdateArtifact {
  const stats = statSync(input.artifactPath);
  if (!stats.isFile()) throw new Error("Update artifact path is not a regular file.");
  const artifact: UpdateArtifact = {
    version: input.version,
    platform: input.target.platform,
    architecture: input.target.architecture,
    path: input.path,
    sha256: sha256File(input.artifactPath),
    size: stats.size,
  };
  const validation = validateUpdateManifest({
    schemaVersion: UPDATE_MANIFEST_SCHEMA_VERSION,
    product: "cortex",
    channel: "stable",
    generatedAt: new Date().toISOString(),
    artifacts: [artifact],
  });
  if (!validation.valid) throw new Error(`Invalid update artifact: ${validation.errors.join(" ")}`);
  return artifact;
}

export function createUpdateManifest(input: {
  artifacts: UpdateArtifact[];
  channel?: UpdateChannel;
  generatedAt?: string;
}): UpdateManifest {
  const manifest: UpdateManifest = {
    schemaVersion: UPDATE_MANIFEST_SCHEMA_VERSION,
    product: "cortex",
    channel: input.channel ?? "stable",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    artifacts: input.artifacts,
  };
  const validation = validateUpdateManifest(manifest);
  if (!validation.valid) throw new Error(`Invalid update manifest: ${validation.errors.join(" ")}`);
  return manifest;
}

export function verifyUpdateArtifact(path: string, artifact: UpdateArtifact): ArtifactVerification {
  if (!existsSync(path)) return { valid: false, reason: "Artifact does not exist." };
  const stats = statSync(path);
  if (!stats.isFile()) return { valid: false, reason: "Artifact path is not a regular file." };
  const actualSize = stats.size;
  if (actualSize !== artifact.size) return { valid: false, reason: `Artifact size mismatch: expected ${artifact.size}, got ${actualSize}.`, actualSize };
  const actualSha256 = sha256File(path);
  if (actualSha256.toLowerCase() !== artifact.sha256.toLowerCase()) return { valid: false, reason: "Artifact SHA-256 mismatch.", actualSha256, actualSize };
  return { valid: true, actualSha256, actualSize };
}

/**
 * Copy a verified artifact into an app-only staging directory. The staging
 * directory is deliberately caller-owned and never derived from a vault path;
 * applying an update must not write to Markdown or `.cortex` data.
 */
export function stageVerifiedUpdate(input: {
  artifactPath: string;
  artifact: UpdateArtifact;
  stagingRoot: string;
}): string {
  const verification = verifyUpdateArtifact(input.artifactPath, input.artifact);
  if (!verification.valid) throw new Error(`Cannot stage update: ${verification.reason}`);
  const destinationDirectory = resolve(input.stagingRoot, "cortex-update", input.artifact.version, `${input.artifact.platform}-${input.artifact.architecture}`);
  mkdirSync(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, basename(input.artifact.path));
  copyFileSync(input.artifactPath, destination);
  return destination;
}
