import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  selectUpdate,
  stageVerifiedUpdate,
  validateUpdateManifest,
  verifyUpdateArtifact,
  type UpdateManifest,
} from "../src/core/update-manifest.js";

function validManifest(hash: string, size: number): UpdateManifest {
  return {
    schemaVersion: 1,
    product: "cortex",
    channel: "stable",
    generatedAt: "2026-08-14T00:00:00.000Z",
    artifacts: [
      {
        version: "0.2.0",
        platform: "macos",
        architecture: "aarch64",
        path: "Cortex-0.2.0-aarch64.app.tar.gz",
        sha256: hash,
        size,
      },
    ],
  };
}

test("update manifests reject unsafe artifact paths and duplicate targets", () => {
  const invalid = validManifest("a".repeat(64), 12);
  invalid.artifacts.push({ ...invalid.artifacts[0], version: "0.2.1", path: "../outside.app" });
  const result = validateUpdateManifest(invalid);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain("Manifest contains duplicate target macos:aarch64.");
  expect(result.errors).toContain("Artifact 1 has an unsafe relative path.");
});

test("update selection only returns a newer artifact for the active target", () => {
  const manifest = validManifest("a".repeat(64), 12);
  manifest.artifacts.push({ ...manifest.artifacts[0], architecture: "x86_64", version: "0.4.0" });
  expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
  expect(selectUpdate(manifest, { platform: "macos", architecture: "aarch64" }, "0.2.0")).toBeUndefined();
  expect(selectUpdate(manifest, { platform: "macos", architecture: "x86_64" }, "0.3.0")?.version).toBe("0.4.0");
});

test("verified updates stage outside the vault and preserve vault source data", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-update-test-"));
  const vault = join(root, "vault");
  const staging = join(root, "staging");
  const artifactPath = join(root, "Cortex.app.tar.gz");
  mkdirSync(vault, { recursive: true });
  const markdown = "# Durable note\n\nThe vault is the source of truth.\n";
  writeFileSync(join(vault, "note.md"), markdown);
  writeFileSync(join(vault, ".git-marker"), "history");
  writeFileSync(artifactPath, "app payload");
  const hash = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  const artifact = validManifest(hash, readFileSync(artifactPath).byteLength).artifacts[0];

  expect(verifyUpdateArtifact(artifactPath, artifact).valid).toBe(true);
  const staged = stageVerifiedUpdate({ artifactPath, artifact, stagingRoot: staging });
  expect(readFileSync(staged, "utf8")).toBe("app payload");
  expect(readFileSync(join(vault, "note.md"), "utf8")).toBe(markdown);
  expect(readFileSync(join(vault, ".git-marker"), "utf8")).toBe("history");
  rmSync(root, { recursive: true, force: true });
});
