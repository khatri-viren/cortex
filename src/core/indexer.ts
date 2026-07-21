import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProjectGraph, walkProjectFiles } from "./project-graph.js";
import { repositoryRelativePath } from "./identity.js";
import { requireGitVault, scanVault } from "./vault.js";
import { IndexStore } from "./index-store.js";
import type { Diagnostic } from "./types.js";
import type { IndexReport, IndexedMarkdown } from "./index-types.js";

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

  private insertNonMarkdownFiles(): void {
    for (const entry of walkProjectFiles(this.vaultRoot)) {
      if (entry.isDirectory || isMarkdown(entry.path)) continue;
      const content = readFileSync(entry.absolutePath);
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
    this.store.transaction(() => {
      this.store.resetProjection();
      for (const note of scan.notes) {
        if (!note.filePath) continue;
        this.store.replaceMarkdown(this.markdownRecord(note.filePath, note));
      }
      this.insertNonMarkdownFiles();
      const graph = buildProjectGraph(this.vaultRoot, scan.notes);
      this.store.replaceGraph(graph);
      const parsedCodes = new Set(scan.notes.flatMap((note) => note.diagnostics.map((item) => `${item.filePath}|${item.code}|${item.line ?? ""}|${item.message}`)));
      this.addVaultDiagnostics(scan.diagnostics, parsedCodes);
      this.store.resolveLinks();
      this.store.refreshWikilinkEdges();
      this.store.setState("last_full_rebuild", new Date().toISOString());
    });
    return this.report("full", scan.files, started);
  }

  incrementalRebuild(paths: string[]): IndexReport {
    const started = now();
    const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
    const graphRelevant = uniquePaths.some((path) => !isMarkdown(path));
    const scan = scanVault(this.vaultRoot);
    this.store.transaction(() => {
      for (const absolutePath of uniquePaths) {
        const relativePath = repositoryRelativePath(this.vaultRoot, absolutePath);
        try {
          const stats = statSync(absolutePath);
          if (stats.isFile() && isMarkdown(absolutePath)) this.store.replaceMarkdown(this.markdownRecord(absolutePath));
          else if (stats.isFile()) {
            this.store.removePath(relativePath);
            const content = readFileSync(absolutePath);
            const kind = relativePath.endsWith("package.json") || relativePath.startsWith("tsconfig") || relativePath.includes(".config.") ? "configuration" : "file";
            this.store.insertFile(relativePath, kind, hashContent(content), stats.size, stats.mtimeMs);
          }
        } catch {
          this.store.removePath(relativePath);
        }
      }
      if (graphRelevant || uniquePaths.some((path) => isMarkdown(path))) {
        const graph = buildProjectGraph(this.vaultRoot, scan.notes);
        this.store.replaceGraph(graph);
      }
      this.store.resolveLinks();
      this.store.refreshWikilinkEdges();
      this.store.setState("last_incremental_rebuild", new Date().toISOString());
    });
    return this.report("incremental", uniquePaths.map((path) => repositoryRelativePath(this.vaultRoot, path)), started);
  }

  report(mode: "full" | "incremental", changedPaths: string[], started: number): IndexReport {
    const counts = this.store.counts();
    return { mode, changedPaths, ...counts, diagnostics: this.store.diagnostics(), durationMs: Math.round((now() - started) * 100) / 100 };
  }
}
