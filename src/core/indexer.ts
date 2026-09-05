import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProjectGraph, walkProjectFiles } from "./project-graph.js";
import { repositoryRelativePath } from "./identity.js";
import { requireGitVault, scanVault, vaultFiles } from "./vault.js";
import { IndexStore, PROJECTION_VERSION, SCHEMA_VERSION } from "./index-store.js";
import type { Diagnostic } from "./types.js";
import type { IndexReport, IndexedMarkdown, IndexWorkMetrics } from "./index-types.js";

function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function now(): number {
  return performance.now();
}

export class VaultIndexer {
  readonly vaultRoot: string;
  readonly store: IndexStore;

  constructor(vaultRoot: string, dbPath?: string) {
    this.vaultRoot = requireGitVault(vaultRoot);
    this.store = new IndexStore(this.vaultRoot, dbPath ?? join(this.vaultRoot, ".cortex", "index.sqlite"));
  }

  close(): void {
    this.store.close();
  }

  /**
   * Validate the persisted projection without parsing Markdown or rebuilding
   * the graph. A warm read is only accepted when the projection metadata and
   * every source file's cheap filesystem snapshot still match. Any mismatch
   * deliberately falls back to the full rebuild oracle.
   */
  warmRead(): { valid: boolean; reason: string; checkedFiles: number } {
    if (this.store.getState("projection_schema_version") !== SCHEMA_VERSION) return { valid: false, reason: "schema-version", checkedFiles: 0 };
    if (this.store.getState("projection_version") !== PROJECTION_VERSION) return { valid: false, reason: "projection-version", checkedFiles: 0 };
    if (this.store.getState("projection_vault_root") !== this.vaultRoot) return { valid: false, reason: "vault-root", checkedFiles: 0 };
    if (this.store.getState("projection_generation_status") !== "complete") return { valid: false, reason: "generation-incomplete", checkedFiles: 0 };

    const indexed = this.store.fileSnapshots();
    const current = vaultFiles(this.vaultRoot).map((absolutePath) => ({ path: repositoryRelativePath(this.vaultRoot, absolutePath), absolutePath }));
    if (current.length !== indexed.length) return { valid: false, reason: "file-count", checkedFiles: 0 };
    const indexedByPath = new Map(indexed.map((file) => [file.path, file]));
    let checkedFiles = 0;
    for (const file of current) {
      const expected = indexedByPath.get(file.path);
      if (!expected) return { valid: false, reason: "file-set", checkedFiles };
      try {
        const stats = statSync(file.absolutePath);
        checkedFiles += 1;
        if (stats.size !== expected.size || stats.mtimeMs !== expected.mtimeMs) return { valid: false, reason: "file-snapshot", checkedFiles };
      } catch {
        return { valid: false, reason: "file-missing", checkedFiles };
      }
    }
    this.store.setState("last_warm_read", new Date().toISOString());
    return { valid: true, reason: "validated", checkedFiles };
  }

  private markdownRecord(
    absolutePath: string,
    parsedOverride?: ReturnType<typeof scanVault>["notes"][number],
    preloaded?: { content: string; mtimeMs: number },
  ): IndexedMarkdown {
    const content = preloaded?.content ?? readFileSync(absolutePath, "utf8");
    const parsed = parsedOverride ?? scanVault(this.vaultRoot).notes.find((note) => note.filePath === absolutePath);
    if (!parsed) throw new Error(`Could not parse Markdown file: ${absolutePath}`);
    const mtimeMs = preloaded?.mtimeMs ?? statSync(absolutePath).mtimeMs;
    return { path: repositoryRelativePath(this.vaultRoot, absolutePath), absolutePath, content, parsed, hash: hashContent(content), mtimeMs };
  }

  private insertNonMarkdownFiles(work: IndexWorkMetrics): void {
    for (const entry of walkProjectFiles(this.vaultRoot)) {
      if (entry.isDirectory || isMarkdown(entry.path)) continue;
      const content = readFileSync(entry.absolutePath);
      work.changedFilesRead += 1;
      work.projectionWrites += 1;
      const stats = statSync(entry.absolutePath);
      const kind = entry.path.endsWith("package.json") || entry.path.startsWith("tsconfig") || entry.path.includes(".config.") ? "configuration" : "file";
      this.store.insertFile(entry.path, kind, hashContent(content), stats.size, stats.mtimeMs);
    }
  }

  private addVaultDiagnostics(scanDiagnostics: Diagnostic[], parsedCodes: Set<string>): void {
    for (const diagnostic of scanDiagnostics) {
      if (parsedCodes.has(`${diagnostic.filePath}|${diagnostic.code}|${diagnostic.line ?? ""}|${diagnostic.message}`)) continue;
      this.store.insertDiagnostics(diagnostic.filePath ?? ".cortex/vault", [diagnostic]);
    }
  }

  fullRebuild(): IndexReport {
    const started = now();
    const scan = scanVault(this.vaultRoot);
    const work: IndexWorkMetrics = {
      scanFiles: scan.files.length,
      scanNotes: scan.notes.length,
      changedPaths: scan.files.length,
      changedFilesRead: scan.files.length,
      projectionWrites: 0,
      projectionDeletes: 0,
      projectionResets: 1,
      graphRebuilds: 1,
      linkResolutionRuns: 1,
      wikilinkEdgeRefreshes: 1,
    };
    this.store.setState("projection_generation_status", "building");
    const nextGeneration = (Number(this.store.getState("projection_generation") ?? "0") || 0) + 1;
    this.store.transaction(() => {
      this.store.resetProjection();
      for (const note of scan.notes) {
        if (!note.filePath) continue;
        this.store.replaceMarkdown(this.markdownRecord(note.filePath, note));
        work.projectionWrites += 1;
      }
      this.insertNonMarkdownFiles(work);
      const graph = buildProjectGraph(this.vaultRoot, scan.notes);
      this.store.replaceGraph(graph);
      const parsedCodes = new Set(scan.notes.flatMap((note) => note.diagnostics.map((item) => `${item.filePath}|${item.code}|${item.line ?? ""}|${item.message}`)));
      this.addVaultDiagnostics(scan.diagnostics, parsedCodes);
      this.store.resolveLinks();
      this.store.refreshWikilinkEdges();
      this.store.setState("last_full_rebuild", new Date().toISOString());
      this.store.setState("projection_schema_version", SCHEMA_VERSION);
      this.store.setState("projection_version", PROJECTION_VERSION);
      this.store.setState("projection_vault_root", this.vaultRoot);
      this.store.setState("projection_generation_status", "complete");
      this.store.setState("projection_generation", String(nextGeneration));
    });
    return this.report("full", scan.files, started, work);
  }

  incrementalRebuild(paths: string[]): IndexReport {
    const started = now();
    const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
    const work: IndexWorkMetrics = {
      scanFiles: 0,
      scanNotes: 0,
      changedPaths: uniquePaths.length,
      changedFilesRead: 0,
      projectionWrites: 0,
      projectionDeletes: 0,
      projectionResets: 0,
      graphRebuilds: 0,
      linkResolutionRuns: 1,
      wikilinkEdgeRefreshes: 1,
    };

    // Watchers can report an update when a writer rewrites identical bytes.
    // Hash the event paths first and return without scanning or mutating the
    // projection when every observed version is already indexed. This keeps
    // duplicate watcher echoes cheap while still detecting deletes and new
    // files without trusting mtime/size alone.
    const preloaded = new Map<string, { content: string | Buffer; hash: string; mtimeMs: number; exists: boolean }>();
    const changedPaths: string[] = [];
    for (const absolutePath of uniquePaths) {
      const relativePath = repositoryRelativePath(this.vaultRoot, absolutePath);
      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile()) continue;
        const content = isMarkdown(absolutePath) ? readFileSync(absolutePath, "utf8") : readFileSync(absolutePath);
        const hash = hashContent(content);
        preloaded.set(absolutePath, { content, hash, mtimeMs: stats.mtimeMs, exists: true });
        work.changedFilesRead += 1;
        if (this.store.fileHash(relativePath) !== hash) changedPaths.push(absolutePath);
      } catch {
        preloaded.set(absolutePath, { content: "", hash: "", mtimeMs: 0, exists: false });
        if (this.store.fileHash(relativePath) !== undefined) changedPaths.push(absolutePath);
      }
    }
    if (changedPaths.length === 0) {
      work.linkResolutionRuns = 0;
      work.wikilinkEdgeRefreshes = 0;
      return this.report("incremental", uniquePaths.map((path) => repositoryRelativePath(this.vaultRoot, path)), started, work);
    }

    const scan = scanVault(this.vaultRoot);
    work.scanFiles = scan.files.length;
    work.scanNotes = scan.notes.length;
    const parsedByPath = new Map(scan.notes.filter((note) => note.filePath).map((note) => [resolve(note.filePath!), note]));
    const graphRelevant = changedPaths.some((path) => !isMarkdown(path));
    const markdownChanged = changedPaths.some((path) => isMarkdown(path));
    this.store.transaction(() => {
      for (const absolutePath of changedPaths) {
        const relativePath = repositoryRelativePath(this.vaultRoot, absolutePath);
        try {
          const preloadedFile = preloaded.get(absolutePath);
          const stats = statSync(absolutePath);
          if (stats.isFile() && isMarkdown(absolutePath)) {
            work.projectionDeletes += 1;
            work.projectionWrites += 1;
            const content = typeof preloadedFile?.content === "string" ? preloadedFile.content : readFileSync(absolutePath, "utf8");
            this.store.replaceMarkdown(this.markdownRecord(absolutePath, parsedByPath.get(resolve(absolutePath)), { content, mtimeMs: stats.mtimeMs }));
          }
          else if (stats.isFile()) {
            this.store.removePath(relativePath);
            const content = Buffer.isBuffer(preloadedFile?.content) ? preloadedFile.content : readFileSync(absolutePath);
            work.projectionDeletes += 1;
            work.projectionWrites += 1;
            const kind = relativePath.endsWith("package.json") || relativePath.startsWith("tsconfig") || relativePath.includes(".config.") ? "configuration" : "file";
            this.store.insertFile(relativePath, kind, hashContent(content), stats.size, stats.mtimeMs);
          }
        } catch {
          this.store.removePath(relativePath);
          work.projectionDeletes += 1;
        }
      }
      if (graphRelevant || markdownChanged) {
        work.graphRebuilds += 1;
        const graph = buildProjectGraph(this.vaultRoot, scan.notes);
        this.store.replaceGraph(graph);
      }
      if (markdownChanged) {
        this.store.resolveLinks();
        this.store.refreshWikilinkEdges();
      } else {
        work.linkResolutionRuns = 0;
        work.wikilinkEdgeRefreshes = 0;
      }
      this.store.setState("last_incremental_rebuild", new Date().toISOString());
    });
    return this.report("incremental", changedPaths.map((path) => repositoryRelativePath(this.vaultRoot, path)), started, work);
  }

  report(mode: "full" | "incremental", changedPaths: string[], started: number, work: IndexWorkMetrics): IndexReport {
    const counts = this.store.counts();
    return { mode, changedPaths, ...counts, diagnostics: this.store.diagnostics(), durationMs: Math.round((now() - started) * 100) / 100, work };
  }
}
