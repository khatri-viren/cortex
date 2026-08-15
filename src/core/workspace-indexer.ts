import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { workspaceDirectoryNodeId, workspaceFileNodeId } from "./identity.js";
import type { Diagnostic } from "./types.js";
import { buildProjectGraphFromSource, classifyProjectFile, walkProjectFiles, type GraphSource, type GraphSourcePolicy, type ProjectFile } from "./project-graph.js";
import type { WorkspaceRepository } from "./workspace.js";
import { isWorkspaceIgnored, repositoryRelativePath, type WorkspaceConfig, workspaceIgnorePatterns } from "./workspace.js";
import type { WorkspaceIndexReport } from "./index-types.js";
import { IndexStore } from "./index-store.js";

type WorkspaceFile = ProjectFile & { isDirectory: false; kind: string; hash: string; size: number; mtimeMs: number };

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function walkRepository(repository: WorkspaceRepository, config: WorkspaceConfig): WorkspaceFile[] {
  const patterns = workspaceIgnorePatterns(config.manifest);
  const files = walkProjectFiles(repository.absolutePath, {
    includeDirectories: false,
    relativePath: (absolutePath) => {
      try {
        return repositoryRelativePath(config.workspaceRoot, repository, absolutePath);
      } catch {
        return undefined;
      }
    },
    ignore: (path) => isWorkspaceIgnored(path, patterns),
    collectFileMetadata: (absolutePath, path) => {
      const content = readFileSync(absolutePath);
      const stats = statSync(absolutePath);
      return {
        kind: classifyProjectFile(path, false),
        hash: hash(content),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    },
  });
  return files as WorkspaceFile[];
}

export { workspaceDirectoryNodeId as directoryId, workspaceFileNodeId as fileId } from "./identity.js";

function workspaceGraphSource(repository: WorkspaceRepository, config: WorkspaceConfig, files: WorkspaceFile[]): GraphSource {
  const root = resolve(repository.absolutePath);
  const repositoryMetadata = { repository_id: repository.id };
  const policy: GraphSourcePolicy = {
    rootKind: "workspace",
    rootPath: root,
    rootNode: { nodeId: `repo:${repository.id}`, kind: "repository", path: repository.path, name: repository.id, metadata: repositoryMetadata },
    normalizePath: (absolutePath) => repositoryRelativePath(config.workspaceRoot, repository, absolutePath),
    directoryNodeId: (path) => workspaceDirectoryNodeId(repository.id, path),
    fileNodeId: (path) => workspaceFileNodeId(repository.id, path),
    packageNodeId: (name) => `package:${repository.id}:${name}`,
    ignore: (path) => isWorkspaceIgnored(path, workspaceIgnorePatterns(config.manifest)),
    includeMarkdownNotes: false,
    noteAttachmentPolicy: "none",
    repositoryNamespace: repository.id,
    packageNamespace: repository.id,
    allowJsToTsResolution: true,
    treatMarkdownAsFile: false,
    nodeMetadata: (kind, path) => kind === "package" ? repositoryMetadata : kind === "file" ? { ...repositoryMetadata, extension: extname(path) } : repositoryMetadata,
    edgeMetadata: (kind) => kind === "contains" ? {} : repositoryMetadata,
    diagnosticPath: (_absolutePath, path) => `${repository.id}:${path}`,
  };
  return { policy, files };
}

export class WorkspaceIndexer {
  readonly store: IndexStore;
  readonly config: WorkspaceConfig;

  constructor(store: IndexStore, config: WorkspaceConfig) {
    this.store = store;
    this.config = config;
  }

  fullRebuild(): WorkspaceIndexReport {
    const started = performance.now();
    if (!this.config.workspaceExists) return this.report("full", [], started);
    const active = new Set(this.config.repositories.map((repository) => repository.id));
    this.store.transaction(() => {
      for (const repository of this.config.repositories) {
        const files = walkRepository(repository, this.config);
        const graph = buildProjectGraphFromSource(workspaceGraphSource(repository, this.config, files));
        this.store.replaceWorkspaceRepository(repository.id, repository.path, files, graph, graph.diagnostics);
      }
      for (const previous of this.store.workspaceRepositories()) {
        if (!active.has(previous.repository_id)) this.store.markWorkspaceRepositoryMissing(previous.repository_id);
      }
      this.store.linkRepositoriesToProject(this.config.repositories.map((repository) => repository.id));
      this.store.setState("last_workspace_rebuild", new Date().toISOString());
    });
    return this.report("full", this.config.repositories.map((repository) => repository.id), started);
  }

  incrementalRebuild(repositoryId: string): WorkspaceIndexReport {
    const started = performance.now();
    const repository = this.config.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) return this.report("incremental", [], started);
    this.store.transaction(() => {
      const files = walkRepository(repository, this.config);
      const graph = buildProjectGraphFromSource(workspaceGraphSource(repository, this.config, files));
      this.store.replaceWorkspaceRepository(repository.id, repository.path, files, graph, graph.diagnostics);
      this.store.linkRepositoriesToProject(this.config.repositories.map((candidate) => candidate.id));
      this.store.setState("last_workspace_rebuild", new Date().toISOString());
    });
    return this.report("incremental", [repositoryId], started);
  }

  report(mode: "full" | "incremental", repositories: string[], started: number): WorkspaceIndexReport {
    const counts = this.store.workspaceCounts();
    return { mode, repositories, ...counts, diagnostics: this.store.workspaceDiagnostics(), durationMs: Math.round((performance.now() - started) * 100) / 100 };
  }
}
