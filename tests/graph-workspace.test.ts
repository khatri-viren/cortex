import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProjectGraphFromSource, walkProjectFiles, type GraphSource } from "../src/core/project-graph.js";
import { workspaceDirectoryNodeId, workspaceFileNodeId } from "../src/core/identity.js";
import { resolveWorkspaceAttachments } from "../src/core/workspace-attachments.js";
import { repositoryRelativePath, type WorkspaceConfig, type WorkspaceRepository } from "../src/core/workspace.js";
import type { NoteFrontmatter, ParsedNote } from "../src/core/types.js";

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function workspaceSource(rootPath: string, files = walkProjectFiles(rootPath)): GraphSource {
  const root = resolve(rootPath);
  const repositoryId = "fixture";
  const repositoryMetadata = { repository_id: repositoryId };
  return {
    files,
    policy: {
      rootKind: "workspace",
      rootPath: root,
      rootNode: { nodeId: `repo:${repositoryId}`, kind: "repository", path: repositoryId, name: repositoryId, metadata: repositoryMetadata },
      normalizePath: (absolutePath) => repositoryRelativePath(root, { id: repositoryId, path: repositoryId, absolutePath: root, exists: true }, absolutePath),
      directoryNodeId: (path) => workspaceDirectoryNodeId(repositoryId, path),
      fileNodeId: (path) => workspaceFileNodeId(repositoryId, path),
      packageNodeId: (name) => `package:${repositoryId}:${name}`,
      ignore: () => false,
      includeMarkdownNotes: false,
      noteAttachmentPolicy: "none",
      repositoryNamespace: repositoryId,
      packageNamespace: repositoryId,
      allowJsToTsResolution: true,
      treatMarkdownAsFile: false,
      nodeMetadata: (kind) => kind === "package" ? repositoryMetadata : repositoryMetadata,
      edgeMetadata: (kind) => kind === "contains" ? {} : repositoryMetadata,
      diagnosticPath: (_absolutePath, path) => `${repositoryId}:${path}`,
    },
  };
}

function note(filePath: string, id: string, title: string, target: string): ParsedNote {
  const frontmatter: NoteFrontmatter = {
    id,
    title,
    type: "note",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    aliases: [],
    tags: [],
    applies_to: [{ target, relation: "documents" }],
    extra: {},
  };
  return { filePath, frontmatter, wikilinks: [], sections: [], tables: [], diagnostics: [], body: "" };
}

function workspaceConfig(workspaceRoot: string, repository: WorkspaceRepository): WorkspaceConfig {
  return {
    vaultRoot: temporaryDirectory("cortex-graph-vault-"),
    manifestPath: join(workspaceRoot, "workspace.yaml"),
    manifest: {
      version: 1,
      workspace_root: workspaceRoot,
      discovery: { mode: "immediate-git-repositories", include: [], exclude: [] },
      ignore: [],
    },
    workspaceRoot,
    workspaceExists: true,
    repositories: [repository],
    diagnostics: [],
  };
}

describe("graph/workspace remediation", () => {
  test("extracts only syntax-level imports, not import-shaped strings or comments", () => {
    const root = temporaryDirectory("cortex-graph-imports-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "target.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "src", "dynamic.ts"), "export const dynamic = 2;\n");
    writeFileSync(join(root, "src", "main.ts"), [
      `const string = "import './missing-from-string'";`,
      "/* require('./missing-from-comment') */",
      "// export { value } from './missing-from-comment';",
      `import { value } from "./target";`,
      "const loaded = import(`./dynamic`);",
      "export const result = value;",
    ].join("\n"));

    const graph = buildProjectGraphFromSource(workspaceSource(root));
    const imports = graph.edges.filter((edge) => edge.kind === "imports");

    expect(imports).toHaveLength(2);
    expect(imports.map((edge) => edge.toId)).toEqual([
      workspaceFileNodeId("fixture", "src/dynamic.ts"),
      workspaceFileNodeId("fixture", "src/target.ts"),
    ]);
    expect(graph.diagnostics.filter((diagnostic) => diagnostic.code === "unresolved-import")).toEqual([]);
  });

  test("maps a workspace attachment target of '.' to the repository node", () => {
    const workspaceRoot = temporaryDirectory("cortex-graph-root-");
    const repositoryPath = join(workspaceRoot, "alpha");
    mkdirSync(repositoryPath, { recursive: true });
    const repository: WorkspaceRepository = { id: "alpha", path: "alpha", absolutePath: repositoryPath, exists: true, gitRoot: repositoryPath };
    const config = workspaceConfig(workspaceRoot, repository);

    expect(repositoryRelativePath(workspaceRoot, repository, ".")).toBe(".");
    const result = resolveWorkspaceAttachments(config, [
      { noteId: "note-1", path: "notes/one.md", appliesTo: [{ target: ".", relation: "documents", repository: "alpha" }] },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.edges).toEqual([{
      fromId: "note:note-1",
      toId: "repo:alpha",
      kind: "documents",
      metadata: { repository: "alpha", target: "." },
    }]);
  });

  test("assembles attachment edges deterministically and never returns a dangling endpoint", () => {
    const root = temporaryDirectory("cortex-graph-closure-");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    const firstPath = join(root, "notes", "first.md");
    const secondPath = join(root, "notes", "second.md");
    writeFileSync(firstPath, "");
    writeFileSync(secondPath, "");

    const first = note(firstPath, "11111111-1111-4111-8111-111111111111", "First", "src/a.ts");
    const second = note(secondPath, "22222222-2222-4222-8222-222222222222", "Second", "src/b.ts");
    const files = walkProjectFiles(root);
    const graph = buildProjectGraphFromSource({
      ...workspaceSource(root, files),
      policy: {
        ...workspaceSource(root, files).policy,
        rootKind: "vault",
        rootNode: { nodeId: "project:root", kind: "project", name: "fixture", metadata: {} },
        normalizePath: (absolutePath) => repositoryRelativePath(root, { id: "fixture", path: "fixture", absolutePath: root, exists: true }, absolutePath),
        directoryNodeId: (path) => `dir:${path}`,
        fileNodeId: (path) => `file:${path}`,
        includeMarkdownNotes: true,
        noteAttachmentPolicy: "vault",
      },
      notes: [second, first],
    });
    const reversed = buildProjectGraphFromSource({
      ...workspaceSource(root, files),
      policy: {
        ...workspaceSource(root, files).policy,
        rootKind: "vault",
        rootNode: { nodeId: "project:root", kind: "project", name: "fixture", metadata: {} },
        normalizePath: (absolutePath) => repositoryRelativePath(root, { id: "fixture", path: "fixture", absolutePath: root, exists: true }, absolutePath),
        directoryNodeId: (path) => `dir:${path}`,
        fileNodeId: (path) => `file:${path}`,
        includeMarkdownNotes: true,
        noteAttachmentPolicy: "vault",
      },
      notes: [first, second],
    });

    expect(graph).toEqual(reversed);
    const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.fromId)).toBe(true);
      expect(nodeIds.has(edge.toId)).toBe(true);
    }

    const omittedTarget = join(root, "src", "omitted.ts");
    writeFileSync(omittedTarget, "export const omitted = true;\n");
    const orphan = note(join(root, "notes", "orphan.md"), "33333333-3333-4333-8333-333333333333", "Orphan", "src/omitted.ts");
    const closed = buildProjectGraphFromSource({
      ...workspaceSource(root, files),
      policy: {
        ...workspaceSource(root, files).policy,
        rootKind: "vault",
        rootNode: { nodeId: "project:root", kind: "project", name: "fixture", metadata: {} },
        normalizePath: (absolutePath) => repositoryRelativePath(root, { id: "fixture", path: "fixture", absolutePath: root, exists: true }, absolutePath),
        directoryNodeId: (path) => `dir:${path}`,
        fileNodeId: (path) => `file:${path}`,
        includeMarkdownNotes: true,
        noteAttachmentPolicy: "vault",
      },
      notes: [orphan],
    });
    const closedNodeIds = new Set(closed.nodes.map((node) => node.nodeId));
    expect(closed.edges.every((edge) => closedNodeIds.has(edge.fromId) && closedNodeIds.has(edge.toId))).toBe(true);
  });
});
