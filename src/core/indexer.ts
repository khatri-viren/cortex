import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProjectGraph, walkProjectFiles } from "./project-graph.js";
import { repositoryRelativePath } from "./identity.js";
import { requireGitVault, scanVault } from "./vault.js";
import { IndexStore } from "./index-store.js";
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

  private markdownRecord(absolutePath: string, parsedOverride?: ReturnType<typeof scanVault>["notes"][number]): IndexedMarkdown {
    const content = readFileSync(absolutePath, "utf8");
    const parsed = parsedOverride ?? scanVault(this.vaultRoot).notes.find((note) => note.filePath === absolutePath);
    if (!parsed) throw new Error(`Could not parse Markdown file: ${absolutePath}`);
    const stats = statSync(absolutePath);
    return { path: repositoryRelativePath(this.vaultRoot, absolutePath), absolutePath, content, parsed, hash: hashContent(content), mtimeMs: stats.mtimeMs };
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
    });
    return this.report("full", scan.files, started, work);
  }

  incrementalRebuild(paths: string[]): IndexReport {
    const started = now();
    const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
    const graphRelevant = uniquePaths.some((path) => !isMarkdown(path));
    const scan = scanVault(this.vaultRoot);
    const work: IndexWorkMetrics = {
      scanFiles: scan.files.length,
      scanNotes: scan.notes.length,
      changedPaths: uniquePaths.length,
      changedFilesRead: 0,
      projectionWrites: 0,
      projectionDeletes: 0,
      projectionResets: 0,
      graphRebuilds: 0,
      linkResolutionRuns: 1,
      wikilinkEdgeRefreshes: 1,
    };
    this.store.transaction(() => {
      for (const absolutePath of uniquePaths) {
        const relativePath = repositoryRelativePath(this.vaultRoot, absolutePath);
        try {
          const stats = statSync(absolutePath);
          if (stats.isFile() && isMarkdown(absolutePath)) {
            work.changedFilesRead += 1;
            work.projectionDeletes += 1;
            work.projectionWrites += 1;
            this.store.replaceMarkdown(this.markdownRecord(absolutePath));
          }
          else if (stats.isFile()) {
            this.store.removePath(relativePath);
            const content = readFileSync(absolutePath);
            work.changedFilesRead += 1;
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
      if (graphRelevant || uniquePaths.some((path) => isMarkdown(path))) {
        work.graphRebuilds += 1;
        const graph = buildProjectGraph(this.vaultRoot, scan.notes);
        this.store.replaceGraph(graph);
      }
      this.store.resolveLinks();
      this.store.refreshWikilinkEdges();
      this.store.setState("last_incremental_rebuild", new Date().toISOString());
    });
    return this.report("incremental", uniquePaths.map((path) => repositoryRelativePath(this.vaultRoot, path)), started, work);
  }

  report(mode: "full" | "incremental", changedPaths: string[], started: number, work: IndexWorkMetrics): IndexReport {
    const counts = this.store.counts();
    return { mode, changedPaths, ...counts, diagnostics: this.store.diagnostics(), durationMs: Math.round((now() - started) * 100) / 100, work };
  }
}
