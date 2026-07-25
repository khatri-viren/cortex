import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Diagnostic } from "./types.js";
import type { GraphBuild, GraphEdge, GraphNode, WorkspaceIndexReport } from "./index-types.js";
import { IndexStore } from "./index-store.js";
import { isWorkspaceIgnored, repositoryRelativePath, type WorkspaceConfig, type WorkspaceRepository, workspaceIgnorePatterns } from "./workspace.js";

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const TEST_RE = /(^|[./])(?:__tests__|[^/]+\.(?:test|spec))\.[^.]+$/i;
const IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+|)|export\s+[\s\S]*?\s+from\s+|require\s*\()(["'])([^"']+)\1/g;

type WorkspaceFile = { absolutePath: string; path: string; kind: string; hash: string; size: number; mtimeMs: number };

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileKind(path: string): string {
  const name = basename(path);
  if (TEST_RE.test(path)) return "test";
  if (name === "package.json" || name.startsWith("tsconfig") || name.includes(".config.")) return "configuration";
  if (MODULE_EXTENSIONS.has(extname(name).toLowerCase())) return "module";
  return "file";
}

function walkRepository(repository: WorkspaceRepository, config: WorkspaceConfig): WorkspaceFile[] {
  const patterns = workspaceIgnorePatterns(config.manifest);
  const files: WorkspaceFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      let path: string;
      try {
        path = repositoryRelativePath(config.workspaceRoot, repository, absolutePath);
      } catch {
        continue;
      }
      if (isWorkspaceIgnored(path, patterns)) continue;
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const content = readFileSync(absolutePath);
        const stats = statSync(absolutePath);
        files.push({ absolutePath, path, kind: fileKind(path), hash: hash(content), size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  };
  visit(repository.absolutePath);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function directoryId(repositoryId: string, path: string): string {
  return `dir:${repositoryId}:${path}`;
}

export function fileId(repositoryId: string, path: string): string {
  return `file:${repositoryId}:${path}`;
}

function addNode(nodes: GraphNode[], node: GraphNode): void {
  if (!nodes.some((existing) => existing.nodeId === node.nodeId)) nodes.push(node);
}

function addEdge(edges: GraphEdge[], fromId: string, toId: string, kind: string, metadata: Record<string, unknown> = {}): void {
  edges.push({ fromId, toId, kind, metadata });
}

function candidatePaths(repository: WorkspaceRepository, sourcePath: string, importPath: string, knownPaths: Set<string>): string[] {
  const base = resolve(repository.absolutePath, dirname(sourcePath), importPath);
  const extensions = Array.from(MODULE_EXTENSIONS);
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))];

  // TypeScript ESM writes './vault.js' for a file stored as 'vault.ts', so the
  // specifier's extension must also be swapped before declaring the import unresolved.
  const specifierExtension = extname(base).toLowerCase();
  if (MODULE_EXTENSIONS.has(specifierExtension)) {
    const withoutExtension = base.slice(0, -specifierExtension.length);
    candidates.push(...extensions.map((extension) => `${withoutExtension}${extension}`));
  }

  return candidates.map((candidate) => repositoryRelativePath(repository.absolutePath, repository, candidate)).filter((candidate) => knownPaths.has(candidate));
}

function buildGraph(repository: WorkspaceRepository, files: WorkspaceFile[]): GraphBuild {
  const nodes: GraphNode[] = [{ nodeId: `repo:${repository.id}`, kind: "repository", path: repository.path, name: repository.id, metadata: { repository_id: repository.id } }];
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const paths = new Set(files.map((file) => file.path));
  const pathToNode = new Map<string, string>();

  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const path = parts.slice(0, index).join("/");
      const id = directoryId(repository.id, path);
      pathToNode.set(path, id);
      addNode(nodes, { nodeId: id, kind: "directory", path, name: basename(path), metadata: { repository_id: repository.id } });
      const parent = index === 1 ? `repo:${repository.id}` : directoryId(repository.id, parts.slice(0, index - 1).join("/"));
      addEdge(edges, parent, id, "contains");
    }
    const id = fileId(repository.id, file.path);
    pathToNode.set(file.path, id);
    addNode(nodes, { nodeId: id, kind: file.kind, path: file.path, name: basename(file.path), metadata: { repository_id: repository.id, extension: extname(file.path) } });
    const parentPath = dirname(file.path);
    addEdge(edges, parentPath === "." ? `repo:${repository.id}` : directoryId(repository.id, parentPath), id, "contains");
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files.filter((candidate) => MODULE_EXTENSIONS.has(extname(candidate.path).toLowerCase()))) {
    const sourceId = pathToNode.get(file.path);
    if (!sourceId) continue;
    const content = readFileSync(file.absolutePath, "utf8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const importPath = match[2];
      if (!importPath.startsWith(".")) continue;
      let targetPath: string | undefined;
      try {
        targetPath = candidatePaths(repository, file.path, importPath, new Set(filesByPath.keys()))[0];
      } catch {
        targetPath = undefined;
      }
      if (!targetPath) {
        diagnostics.push({ severity: "warning", code: "unresolved-import", message: `Could not resolve relative import '${importPath}'.`, filePath: `${repository.id}:${file.path}` });
        continue;
      }
      const targetId = pathToNode.get(targetPath);
      if (!targetId) continue;
      addEdge(edges, sourceId, targetId, "imports", { specifier: importPath, repository_id: repository.id });
      if (file.kind === "test") addEdge(edges, targetId, sourceId, "tested_by", { specifier: importPath, repository_id: repository.id });
    }
  }

  const packageJson = filesByPath.get("package.json");
  if (packageJson) {
    try {
      const manifest = JSON.parse(readFileSync(packageJson.absolutePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const packageNodeId = pathToNode.get("package.json");
      for (const [section, dependencies] of [["dependencies", manifest.dependencies], ["devDependencies", manifest.devDependencies]] as const) {
        if (!dependencies || !packageNodeId) continue;
        for (const [name, version] of Object.entries(dependencies)) {
          const nodeId = `package:${repository.id}:${name}`;
          addNode(nodes, { nodeId, kind: "package", name, metadata: { repository_id: repository.id, version, section } });
          addEdge(edges, packageNodeId, nodeId, "depends_on", { repository_id: repository.id, version, section });
        }
      }
    } catch (cause) {
      diagnostics.push({ severity: "error", code: "invalid-package-json", message: cause instanceof Error ? cause.message : String(cause), filePath: `${repository.id}:package.json` });
    }
  }

  return { nodes, edges, diagnostics };
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
        const graph = buildGraph(repository, files);
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
      const graph = buildGraph(repository, files);
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
