import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../src/core/vault.js";
import {
  initializeWorkspaceManifest,
  loadWorkspaceConfig,
  removeWorkspaceRepository,
  repositoryRelativePath,
  type WorkspaceConfig,
} from "../src/core/workspace.js";
import { setupClaudeWorkspaceConfig } from "../src/core/claude-workspace.js";
import { WorkspaceIndexer, directoryId, fileId } from "../src/core/workspace-indexer.js";
import { requireAppliesToRepository, resolveWorkspaceAttachments } from "../src/core/workspace-attachments.js";
import { IndexStore } from "../src/core/index-store.js";
import { VaultRuntime } from "../src/mcp/service.js";

function tempVault(): string {
  return initVault(join(mkdtempSync(join(tmpdir(), "cortex-workspace-")), "vault"));
}

function tempWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), "cortex-workroot-"));
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function initRepo(root: string, name: string, files: Record<string, string>): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(root, "init", path);
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "user.name", "Test");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(path, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
  return path;
}

function newStore(vault: string): IndexStore {
  return new IndexStore(vault, join(mkdtempSync(join(tmpdir(), "cortex-workspace-db-")), "index.sqlite"));
}

describe("Claude workspace setup", () => {
  test("points generated commands at the Cortex install rather than the vault", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    const result = setupClaudeWorkspaceConfig(vault, workspaceRoot);

    const mcpConfig = JSON.parse(readFileSync(join(workspaceRoot, ".mcp.json"), "utf8"));
    const args: string[] = mcpConfig.mcpServers.cortex.args;
    const cliPath = args[1] ?? "";
    const settings = readFileSync(join(workspaceRoot, ".claude", "settings.json"), "utf8");

    // A vault holds Markdown only, so resolving scripts inside it yields paths that do not exist.
    expect(cliPath.startsWith(vault)).toBe(false);
    expect(existsSync(cliPath)).toBe(true);
    expect(settings).not.toContain(`${vault}/src/claude-hooks.ts`);
    expect(result.vaultRoot).toBe(vault);

    // The vault must still be passed explicitly rather than inferred from ambient environment.
    expect(args).toContain("--vault");
    expect(args).toContain(vault);
  });

  test("generated config contains no unexpanded shell or Claude variables", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    setupClaudeWorkspaceConfig(vault, workspaceRoot);

    // ${CLAUDE_PROJECT_DIR} is not expanded inside .mcp.json, which silently breaks the server.
    const mcpConfig = readFileSync(join(workspaceRoot, ".mcp.json"), "utf8");
    expect(mcpConfig).not.toContain("${");
  });
});

describe("Workspace configuration", () => {
  test("discovers immediate child git repositories and skips non-repository directories", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "index.ts": "export const value = 1;\n" });
    initRepo(workspaceRoot, "beta", { "index.ts": "export const value = 2;\n" });
    mkdirSync(join(workspaceRoot, "not-a-repo"), { recursive: true });
    writeFileSync(join(workspaceRoot, "not-a-repo", "notes.txt"), "plain directory, no .git");

    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    expect(config.workspaceExists).toBe(true);
    expect(config.repositories.map((repository) => repository.id).sort()).toEqual(["alpha", "beta"]);
    expect(config.diagnostics.some((item) => item.code === "non-repository-directory")).toBe(true);
  });

  test("an include allowlist restricts discovery and ignores unrelated sibling repositories", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "cortex", { "index.ts": "export const value = 1;\n" });
    initRepo(workspaceRoot, "cortex-notes", { "note.md": "# note\n" });
    initRepo(workspaceRoot, "unrelated-work", { "secret.ts": "export const value = 3;\n" });

    const config = initializeWorkspaceManifest(vault, workspaceRoot, ["cortex", "cortex-notes"]);
    expect(config.repositories.map((repository) => repository.id).sort()).toEqual(["cortex", "cortex-notes"]);
    expect(config.diagnostics.some((item) => item.code === "non-repository-directory")).toBe(false);
  });

  test("a repository added after initialization is not discovered while an allowlist is set", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "cortex", { "index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot, ["cortex"]);

    // The hazard an allowlist exists to prevent: a new sibling repo silently joining the graph.
    initRepo(workspaceRoot, "brand-new-project", { "index.ts": "export const value = 9;\n" });

    const config = loadWorkspaceConfig(vault);
    expect(config.repositories.map((repository) => repository.id)).toEqual(["cortex"]);
  });

  test("reports an included repository that is missing from the workspace root", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "cortex", { "index.ts": "export const value = 1;\n" });

    const config = initializeWorkspaceManifest(vault, workspaceRoot, ["cortex", "typo-in-name"]);
    const missing = config.diagnostics.find((item) => item.code === "missing-included-repository");
    expect(missing?.path).toBe("typo-in-name");
  });

  test("an empty allowlist keeps discovering every child repository", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "index.ts": "export const value = 1;\n" });
    initRepo(workspaceRoot, "beta", { "index.ts": "export const value = 2;\n" });

    const config = initializeWorkspaceManifest(vault, workspaceRoot, []);
    expect(config.repositories.map((repository) => repository.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("falls back to notes-only mode when the workspace root does not exist", () => {
    const vault = tempVault();
    const missingRoot = join(tempWorkspaceRoot(), "does-not-exist");
    const config = loadWorkspaceConfig(vault, missingRoot);
    expect(config.workspaceExists).toBe(false);
    expect(config.repositories).toEqual([]);
    expect(config.diagnostics.some((item) => item.code === "missing-workspace-root")).toBe(true);
  });

  test("honors CORTEX_WORKSPACE_ROOT when no explicit override is given", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "gamma", { "index.ts": "export const value = 3;\n" });
    const previous = process.env.CORTEX_WORKSPACE_ROOT;
    process.env.CORTEX_WORKSPACE_ROOT = workspaceRoot;
    try {
      const config = loadWorkspaceConfig(vault);
      expect(config.workspaceExists).toBe(true);
      expect(config.repositories.map((repository) => repository.id)).toEqual(["gamma"]);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_WORKSPACE_ROOT;
      else process.env.CORTEX_WORKSPACE_ROOT = previous;
    }
  });

  test("workspace:remove-repository excludes a repository from future discovery", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot);

    removeWorkspaceRepository(vault, "alpha");
    const config = loadWorkspaceConfig(vault, workspaceRoot);
    expect(config.repositories).toEqual([]);
  });

  test("rejects attachment targets that escape the repository or the workspace", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "index.ts": "export const value = 1;\n" });
    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    const repository = config.repositories[0]!;

    expect(repositoryRelativePath(config.workspaceRoot, repository, "index.ts")).toBe("index.ts");
    expect(() => repositoryRelativePath(config.workspaceRoot, repository, "../beta/index.ts")).toThrow();
    expect(() => repositoryRelativePath(config.workspaceRoot, repository, "/etc/passwd")).toThrow();
    expect(() => repositoryRelativePath(config.workspaceRoot, repository, "../../../etc/passwd")).toThrow();
  });
});

describe("Workspace indexing", () => {
  test("builds repo/dir/file graph nodes for each discovered repository", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", {
      "src/index.ts": "export const value = 1;\n",
      "src/index.test.ts": "import { value } from './index';\ntest('value', () => value);\n",
    });
    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    const store = newStore(vault);
    try {
      const indexer = new WorkspaceIndexer(store, config);
      const report = indexer.fullRebuild();
      expect(report.repositories).toEqual(["alpha"]);
      expect(report.fileCount).toBeGreaterThanOrEqual(2);

      expect(store.unifiedNode("repo:alpha")?.kind).toBe("repository");
      expect(store.unifiedNode(directoryId("alpha", "src"))?.kind).toBe("directory");
      expect(store.unifiedNode(fileId("alpha", "src/index.ts"))).toBeDefined();
      expect(store.unifiedEdgesFrom(fileId("alpha", "src/index.test.ts")).some((edge) => edge.kind === "imports")).toBe(true);
      expect(store.unifiedEdgesFrom(fileId("alpha", "src/index.ts")).some((edge) => edge.kind === "tested_by")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("resolves TypeScript ESM imports that carry a .js specifier for a .ts file", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", {
      "src/vault.ts": "export const value = 1;\n",
      // TypeScript NodeNext requires the .js suffix even though only vault.ts exists on disk.
      "src/cli.ts": "import { value } from './vault.js';\nexport const doubled = value * 2;\n",
    });
    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    const store = newStore(vault);
    try {
      const report = new WorkspaceIndexer(store, config).fullRebuild();
      expect(report.diagnostics.filter((item) => item.code === "unresolved-import")).toEqual([]);

      const imports = store.unifiedEdgesFrom(fileId("alpha", "src/cli.ts")).filter((edge) => edge.kind === "imports");
      expect(imports.map((edge) => edge.to_id)).toContain(fileId("alpha", "src/vault.ts"));
    } finally {
      store.close();
    }
  });

  test("still prefers a real .js file over the .ts fallback", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", {
      "src/helper.js": "export const value = 1;\n",
      "src/helper.ts": "export const value = 2;\n",
      "src/main.ts": "import { value } from './helper.js';\nexport const used = value;\n",
    });
    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    const store = newStore(vault);
    try {
      new WorkspaceIndexer(store, config).fullRebuild();
      const imports = store.unifiedEdgesFrom(fileId("alpha", "src/main.ts")).filter((edge) => edge.kind === "imports");
      expect(imports.map((edge) => edge.to_id)).toContain(fileId("alpha", "src/helper.js"));
    } finally {
      store.close();
    }
  });

  test("keeps a stale graph for repositories that disappear until they are explicitly removed", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "index.ts": "export const value = 1;\n" });
    initRepo(workspaceRoot, "beta", { "index.ts": "export const value = 2;\n" });
    const config = initializeWorkspaceManifest(vault, workspaceRoot);
    const store = newStore(vault);
    try {
      const indexer = new WorkspaceIndexer(store, config);
      indexer.fullRebuild();
      expect(store.workspaceRepositories().map((repository) => repository.repository_id).sort()).toEqual(["alpha", "beta"]);

      removeWorkspaceRepository(vault, "beta");
      const nextConfig = loadWorkspaceConfig(vault, workspaceRoot);
      const nextIndexer = new WorkspaceIndexer(store, nextConfig);
      nextIndexer.fullRebuild();

      const repositories = store.workspaceRepositories();
      expect(repositories.find((repository) => repository.repository_id === "alpha")?.status).toBe("ready");
      expect(repositories.find((repository) => repository.repository_id === "beta")?.status).toBe("stale");
      expect(store.unifiedNode("repo:beta")).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe("Workspace note attachments", () => {
  function baseConfig(vault: string, workspaceRoot: string): WorkspaceConfig {
    return initializeWorkspaceManifest(vault, workspaceRoot);
  }

  test("resolves repository-tagged applies_to targets into workspace graph edges", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    const config = baseConfig(vault, workspaceRoot);

    const result = resolveWorkspaceAttachments(config, [
      { noteId: "note-1", path: "notes/one.md", appliesTo: [{ target: "src/index.ts", relation: "documents", repository: "alpha" }] },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ fromId: "note:note-1", toId: fileId("alpha", "src/index.ts"), kind: "documents" });
  });

  test("skips applies_to entries without a repository field", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    const config = baseConfig(vault, workspaceRoot);

    const result = resolveWorkspaceAttachments(config, [
      { noteId: "note-1", path: "notes/one.md", appliesTo: [{ target: "src/index.ts", relation: "documents" }] },
    ]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects attachments to an unknown repository or an out-of-bounds target", () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    initRepo(workspaceRoot, "beta", { "src/index.ts": "export const value = 2;\n" });
    const config = baseConfig(vault, workspaceRoot);

    const result = resolveWorkspaceAttachments(config, [
      { noteId: "note-1", path: "notes/one.md", appliesTo: [{ target: "src/index.ts", relation: "documents", repository: "ghost" }] },
      { noteId: "note-2", path: "notes/two.md", appliesTo: [{ target: "../beta/src/index.ts", relation: "documents", repository: "alpha" }] },
    ]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "unknown-workspace-repository")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "invalid-workspace-attachment-target")).toBe(true);
  });

  test("requireAppliesToRepository throws when a repository field is missing", () => {
    expect(() => requireAppliesToRepository([{ target: "src/index.ts", relation: "documents" }])).toThrow(/requires an explicit 'repository' field/);
    expect(() => requireAppliesToRepository([{ target: "src/index.ts", relation: "documents", repository: "alpha" }])).not.toThrow();
  });
});

describe("VaultRuntime workspace integration", () => {
  test("activates workspace mode and reports discovered repositories through workspaceStatus", async () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot);

    const runtime = await VaultRuntime.start(vault, { workspaceRoot });
    try {
      const status = runtime.workspaceStatus();
      expect(status.active).toBe(true);
      expect(status.workspaceExists).toBe(true);
      expect(status.repositories.map((repository) => repository.id)).toEqual(["alpha"]);
      expect(status.repositories[0]?.status).toBe("ready");
    } finally {
      await runtime.close();
    }
  });

  test("returns repository-scoped Git history and diff, and refuses an unconfirmed or dirty restore", async () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot);

    const runtime = await VaultRuntime.start(vault, { workspaceRoot });
    try {
      const history = runtime.getRepoHistory("alpha", "src/index.ts");
      expect(history.commits.length).toBeGreaterThanOrEqual(1);

      const diff = runtime.getRepoDiff("alpha", "src/index.ts");
      expect(diff.diff).toBe("");

      await expect(runtime.restoreRepoPath("alpha", "src/index.ts", history.commits[0]!.hash, false)).rejects.toThrow();

      writeFileSync(join(workspaceRoot, "alpha", "src", "index.ts"), "export const value = 2; // dirty\n");
      await expect(runtime.restoreRepoPath("alpha", "src/index.ts", history.commits[0]!.hash, true)).rejects.toThrow(/dirty/);
    } finally {
      await runtime.close();
    }
  });

  test("restores a clean repository path when confirmed", async () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    const repoPath = initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot);

    const runtime = await VaultRuntime.start(vault, { workspaceRoot });
    try {
      const history = runtime.getRepoHistory("alpha", "src/index.ts");
      const firstHash = history.commits[0]!.hash;

      writeFileSync(join(repoPath, "src", "index.ts"), "export const value = 2;\n");
      git(repoPath, "add", ".");
      git(repoPath, "commit", "-m", "second");

      const result = await runtime.restoreRepoPath("alpha", "src/index.ts", firstHash, true);
      expect(result.repository).toBe("alpha");
      // git restore only updates the working tree, not the index/HEAD, so the restored
      // content is expected to show up as an uncommitted diff awaiting explicit review.
      expect(readFileSync(join(repoPath, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
      expect(runtime.getRepoDiff("alpha", "src/index.ts").diff).toContain("value = 1");
    } finally {
      await runtime.close();
    }
  });

  test("requires an explicit repository field on applies_to entries once workspace mode is active", async () => {
    const vault = tempVault();
    const workspaceRoot = tempWorkspaceRoot();
    initRepo(workspaceRoot, "alpha", { "src/index.ts": "export const value = 1;\n" });
    initializeWorkspaceManifest(vault, workspaceRoot);

    const runtime = await VaultRuntime.start(vault, { workspaceRoot });
    try {
      await expect(runtime.createNote({
        title: "Missing repository",
        type: "note",
        applies_to: [{ target: "src/index.ts", relation: "documents" }],
      })).rejects.toThrow();

      const created = await runtime.createNote({
        title: "Has repository",
        type: "note",
        applies_to: [{ target: "src/index.ts", relation: "documents", repository: "alpha" }],
      });
      expect(created.id).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});
