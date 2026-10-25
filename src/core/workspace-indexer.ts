import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, relative } from "node:path";
import { workspaceDirectoryNodeId, workspaceFileNodeId } from "./identity.js";
import { buildProjectGraphFromSource, classifyProjectFile, extractModuleSpecifiers, walkProjectFiles, type GraphSource, type GraphSourcePolicy, type ProjectFile } from "./project-graph.js";
import type { WorkspaceRepository } from "./workspace.js";
import { isWorkspaceIgnored, repositoryRelativePath, type WorkspaceConfig, workspaceIgnorePatterns } from "./workspace.js";
import type { WorkspaceIndexReport } from "./index-types.js";
import { IndexStore } from "./index-store.js";

type WorkspaceFile = ProjectFile & { isDirectory: false; kind: string; hash: string; size: number; mtimeMs: number };
type Facts = { moduleSpecifiers?: string[]; packageJson?: string };
function parseFacts(value: string | null): Facts | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const facts = parsed as Facts;
    if (facts.moduleSpecifiers !== undefined && (!Array.isArray(facts.moduleSpecifiers) || !facts.moduleSpecifiers.every(item => typeof item === "string"))) return undefined;
    if (facts.packageJson !== undefined && typeof facts.packageJson !== "string") return undefined;
    return facts;
  } catch { return undefined; }
}
type CachedFile = { path: string; kind: string; hash: string; size: number; mtimeMs: number; facts: Facts };
const MODULES = new Set([".ts", ".tsx", ".js", ".jsx"]);

export { workspaceDirectoryNodeId as directoryId, workspaceFileNodeId as fileId } from "./identity.js";

function workspaceGraphSource(repository: WorkspaceRepository, config: WorkspaceConfig, files: WorkspaceFile[]): GraphSource {
  const repositoryMetadata = { repository_id: repository.id };
  const policy: GraphSourcePolicy = {
    rootKind: "workspace", rootPath: resolve(repository.absolutePath),
    rootNode: { nodeId: `repo:${repository.id}`, kind: "repository", path: repository.path, name: repository.id, metadata: repositoryMetadata },
    normalizePath: absolutePath => repositoryRelativePath(config.workspaceRoot, repository, absolutePath),
    directoryNodeId: path => workspaceDirectoryNodeId(repository.id, path),
    fileNodeId: path => workspaceFileNodeId(repository.id, path),
    packageNodeId: name => `package:${repository.id}:${name}`,
    ignore: path => isWorkspaceIgnored(path, workspaceIgnorePatterns(config.manifest)),
    includeMarkdownNotes: false, noteAttachmentPolicy: "none",
    repositoryNamespace: repository.id, packageNamespace: repository.id,
    allowJsToTsResolution: true, treatMarkdownAsFile: false,
    nodeMetadata: (kind, path) => kind === "package" ? repositoryMetadata : kind === "file" ? { ...repositoryMetadata, extension: extname(path) } : repositoryMetadata,
    edgeMetadata: kind => kind === "contains" ? {} : repositoryMetadata,
    diagnosticPath: (_absolutePath, path) => `${repository.id}:${path}`,
  };
  return { policy, files };
}

export class WorkspaceIndexer {
  private filesRead = 0;
  private graphRebuilds = 0;
  constructor(readonly store: IndexStore, readonly config: WorkspaceConfig) {}

  private project(repository: WorkspaceRepository, changedPaths?: string[]): boolean {
    const cached = this.store.db.query<CachedFile & { facts_json: string | null }, [string]>(
      "SELECT f.path, f.kind, f.content_hash AS hash, f.size, f.mtime_ms AS mtimeMs, c.facts_json FROM workspace_files f LEFT JOIN workspace_file_facts c ON c.repository_id=f.repository_id AND c.path=f.path AND c.content_hash=f.content_hash WHERE f.repository_id=?"
    ).all(repository.id);
    const previous = new Map(cached.map(file => [file.path, { ...file, facts: parseFacts(file.facts_json) }]));
    const patterns = workspaceIgnorePatterns(this.config.manifest);
    const materialize = (absolutePath: string, path: string, force = false): WorkspaceFile => {
      const stats = statSync(absolutePath);
      const old = previous.get(path);
      if (!force && old?.facts && old.size === stats.size && old.mtimeMs === stats.mtimeMs) {
        return { ...old, ...old.facts, absolutePath, isDirectory: false };
      }
      const bytes = readFileSync(absolutePath);
      this.filesRead++;
      const hash = createHash("sha256").update(bytes).digest("hex");
      const facts: Facts = old?.hash === hash && old.facts ? old.facts : {
        ...(MODULES.has(extname(path).toLowerCase()) ? { moduleSpecifiers: extractModuleSpecifiers(bytes.toString("utf8")) } : {}),
        ...(path === "package.json" ? { packageJson: bytes.toString("utf8") } : {}),
      };
      return { absolutePath, path, isDirectory: false, kind: classifyProjectFile(path, false), hash, size: stats.size, mtimeMs: stats.mtimeMs, ...facts };
    };
    let files: WorkspaceFile[];
    // File events reuse the persisted inventory. Directory creates/renames,
    // deletes and cache migration use the full inventory oracle.
    const paths = changedPaths?.map(path => resolve(repository.absolutePath, path));
    const policy = JSON.stringify({ root: repository.absolutePath, ignore: patterns });
    const policyKey = "workspace_policy:" + repository.id;
    const fileEvents = paths?.length && this.store.getState(policyKey) === policy && previous.size && [...previous.values()].every(file => file.facts) && paths.every(path => {
      const local = relative(repository.absolutePath, path).replaceAll("\\", "/");
      if (local === ".." || local.startsWith("../")) throw new Error("Workspace event escaped its repository.");
      if (isWorkspaceIgnored(local, patterns)) return true;
      try { return statSync(path).isFile(); } catch { return previous.has(local); }
    });
    if (fileEvents) {
      const next = new Map<string, WorkspaceFile>([...previous].map(([path, file]) => [path, {
        ...file, ...file.facts, absolutePath: resolve(repository.absolutePath, path), isDirectory: false,
      }]));
      for (const absolutePath of paths!) {
        const path = relative(repository.absolutePath, absolutePath).replaceAll("\\", "/");
        if (isWorkspaceIgnored(path, patterns)) continue;
        try { next.set(path, materialize(absolutePath, path, true)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") next.delete(path); else throw error; }
      }
      files = [...next.values()].sort((a, b) => a.path.localeCompare(b.path));
    } else {
      files = walkProjectFiles(repository.absolutePath, {
        includeDirectories: false,
        relativePath: path => repositoryRelativePath(this.config.workspaceRoot, repository, path),
        ignore: path => isWorkspaceIgnored(path, patterns),
        collectFileMetadata: (absolutePath, path) => materialize(absolutePath, path),
      }) as WorkspaceFile[];
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({
      version: 1, root: repository.absolutePath, ignore: patterns,
      files: files.map(file => [file.path, file.hash]).sort((a, b) => a[0].localeCompare(b[0])),
    })).digest("hex");
    const key = "workspace_projection:" + repository.id;
    const contentChanged = this.store.getState(key) !== fingerprint;
    // Parse/graph planning happens before the short publishing transaction.
    const graph = contentChanged ? buildProjectGraphFromSource(workspaceGraphSource(repository, this.config, files)) : undefined;
    if (graph) this.graphRebuilds++;
    this.store.transaction(() => {
      if (this.store.getState(policyKey) !== policy) this.store.setState(policyKey, policy);
      if (graph) {
        this.store.replaceWorkspaceRepository(repository.id, repository.path, files, graph, graph.diagnostics);
        this.store.setState(key, fingerprint);
      }
      const upsert = this.store.db.query("INSERT INTO workspace_file_facts (repository_id,path,content_hash,facts_json) VALUES (?,?,?,?) ON CONFLICT(repository_id,path) DO UPDATE SET content_hash=excluded.content_hash,facts_json=excluded.facts_json WHERE content_hash!=excluded.content_hash OR facts_json!=excluded.facts_json");
      for (const file of files) {
        upsert.run(repository.id, file.path, file.hash, JSON.stringify({ ...(file.moduleSpecifiers ? { moduleSpecifiers: file.moduleSpecifiers } : {}), ...(file.packageJson !== undefined ? { packageJson: file.packageJson } : {}) }));
        // A same-byte save updates verification metadata without graph writes.
        if (!graph) this.store.db.query("UPDATE workspace_files SET size=?,mtime_ms=? WHERE repository_id=? AND path=? AND (size!=? OR mtime_ms!=?)").run(file.size, file.mtimeMs, repository.id, file.path, file.size, file.mtimeMs);
      }
      this.store.db.query("DELETE FROM workspace_file_facts WHERE repository_id=? AND path NOT IN (SELECT path FROM workspace_files WHERE repository_id=?)").run(repository.id, repository.id);
    });
    return contentChanged;
  }

  fullRebuild(): WorkspaceIndexReport {
    const started = performance.now();
    this.filesRead = 0; this.graphRebuilds = 0;
    if (!this.config.workspaceExists) return this.report("full", [], started);
    const changed: string[] = [];
    for (const repository of this.config.repositories) if (this.project(repository)) changed.push(repository.id);
    const active = new Set(this.config.repositories.map(repository => repository.id));
    this.store.transaction(() => {
      for (const previous of this.store.workspaceRepositories()) if (!active.has(previous.repository_id)) this.store.markWorkspaceRepositoryMissing(previous.repository_id);
      if (changed.length) {
        this.store.linkRepositoriesToProject(this.config.repositories.map(repository => repository.id));
        this.store.setState("last_workspace_rebuild", new Date().toISOString());
      }
    });
    return this.report("full", changed, started);
  }

  incrementalRebuild(repositoryId: string, paths?: string[]): WorkspaceIndexReport {
    const started = performance.now();
    this.filesRead = 0; this.graphRebuilds = 0;
    const repository = this.config.repositories.find(candidate => candidate.id === repositoryId);
    const changed = repository && this.project(repository, paths);
    if (changed) {
      this.store.linkRepositoriesToProject(this.config.repositories.map(candidate => candidate.id));
      this.store.setState("last_workspace_rebuild", new Date().toISOString());
    }
    return this.report("incremental", changed ? [repositoryId] : [], started);
  }

  report(mode: "full" | "incremental", repositories: string[], started: number): WorkspaceIndexReport {
    return { mode, repositories, ...this.store.workspaceCounts(), diagnostics: this.store.workspaceDiagnostics(), durationMs: Math.round((performance.now() - started) * 100) / 100, work: { filesRead: this.filesRead, graphRebuilds: this.graphRebuilds } };
  }
}
