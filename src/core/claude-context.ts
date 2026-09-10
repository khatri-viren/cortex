import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitAdapter } from "./git.js";
import { repositoryRelativePath } from "./identity.js";
import { VaultIndexer } from "./indexer.js";
import { RUNTIME_DIRECTORY } from "./vault.js";

const DEFAULT_TOKEN_CAP = 600;
const HARD_TOKEN_CAP = 800;
const RETRY_DELAY_MS = 100;

export type SessionContext = {
  context: string;
  tokenEstimate: number;
  rebuilt: boolean;
};

export type ReindexResult = {
  status: "reindexed" | "skipped" | "rebuilt";
  path?: string;
  reason?: string;
  changedPaths?: string[];
};

function tokenEstimate(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 3));
  return bytes.toString("utf8") + "...";
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isIgnored(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(".git/") ||
    relativePath === RUNTIME_DIRECTORY || relativePath.startsWith(RUNTIME_DIRECTORY + "/") ||
    relativePath === "node_modules" || relativePath.startsWith("node_modules/");
}

function safeVaultPath(vaultRoot: string, inputPath: string): { absolute: string; relative: string } {
  const absolute = resolve(vaultRoot, inputPath);
  const relativePath = repositoryRelativePath(vaultRoot, absolute);
  if (relativePath === "." || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error("Changed path is outside the configured vault.");
  }
  return { absolute, relative: relativePath };
}

function indexExists(vaultRoot: string): boolean {
  return existsSync(join(vaultRoot, RUNTIME_DIRECTORY, "index.sqlite"));
}

function topLevelAreas(indexer: VaultIndexer, limit: number): string[] {
  const rows = indexer.store.graphPaths();
  const values = new Set<string>();
  for (const row of rows) {
    if (!row.path) continue;
    values.add(row.path.split("/")[0] ?? row.name);
    if (values.size >= limit) break;
  }
  return [...values].sort();
}

function diagnosticsSummary(indexer: VaultIndexer, limit: number): string[] {
  return indexer.store.diagnostics().slice(0, limit).map((item) => {
    const path = item.filePath ? " (" + item.filePath + ")" : "";
    return item.severity + ": " + item.code + path;
  });
}

function workspaceSummaryLine(indexer: VaultIndexer): string | undefined {
  const repositories = indexer.store.workspaceRepositories();
  if (repositories.length === 0) return undefined;
  const ready = repositories.filter((repository) => repository.status === "ready").map((repository) => repository.repository_id);
  const stale = repositories.filter((repository) => repository.status !== "ready").map((repository) => repository.repository_id);
  const parts = [ready.length + " repositor" + (ready.length === 1 ? "y" : "ies") + " (" + (ready.join(", ") || "none") + ")"];
  if (stale.length > 0) parts.push(stale.length + " stale (" + stale.join(", ") + ")");
  return "Workspace: " + parts.join("; ") + ".";
}

function renderSummary(indexer: VaultIndexer, vaultRoot: string, tokenCap: number, rebuilt: boolean): string {
  const counts = indexer.store.counts();
  const gitStatus = new GitAdapter(vaultRoot).status();
  const gitState = gitStatus.length === 0 ? "clean" : String(gitStatus.length) + " changed path(s)";
  const lastRebuild = indexer.store.getState("last_full_rebuild") ?? "never";
  const areas = topLevelAreas(indexer, 12);
  const diagnostics = diagnosticsSummary(indexer, 6);
  const workspaceLine = workspaceSummaryLine(indexer);
  const lines = [
    "Cortex project: " + (vaultRoot.split("/").filter(Boolean).at(-1) ?? vaultRoot),
    "Index: " + (rebuilt ? "rebuilt" : "current") + "; full rebuild " + lastRebuild + "; Git " + gitState + ".",
    "Counts: " + counts.noteCount + " notes, " + counts.sectionCount + " sections, " + counts.linkCount + " links, " + counts.graphNodeCount + " graph nodes.",
    "Project areas: " + (areas.length > 0 ? areas.join(", ") : "none indexed") + ".",
    ...(workspaceLine ? [workspaceLine] : []),
    diagnostics.length > 0 ? "Diagnostics: " + diagnostics.join("; ") + "." : "Diagnostics: none.",
    "Cortex MCP project_map/get_context: ground with project_map({node:\"repo:cortex\",depth:1,limit:20}) and get_context({node:\"repo:cortex\"}); discover notes with search, then get_note({note:\"notes/example.md\"}) and get_section({note:\"notes/example.md\",section_id:\"sec-...\"}). Use namespaced graph IDs, never absolute paths; preserve applies_to.repository. On writable:false use ensure_marker:true explicitly or replace_note; on conflicts reread and reapply with the new revision/hash.",
  ];
  const capBytes = Math.min(tokenCap, HARD_TOKEN_CAP) * 4;
  const context = lines.join("\n");
  return Buffer.byteLength(context, "utf8") > capBytes ? bounded(context, capBytes) : context;
}

export function buildSessionContext(vaultRoot: string, requestedTokenCap = DEFAULT_TOKEN_CAP): SessionContext {
  const root = resolve(vaultRoot);
  const tokenCap = Math.max(1, Math.min(Math.floor(requestedTokenCap), HARD_TOKEN_CAP));
  const wasIndexed = indexExists(root);
  const indexer = new VaultIndexer(root);
  try {
    const rebuilt = !wasIndexed || !indexer.store.getState("last_full_rebuild");
    if (rebuilt) indexer.fullRebuild();
    const context = renderSummary(indexer, root, tokenCap, rebuilt);
    return { context, tokenEstimate: tokenEstimate(context), rebuilt };
  } finally {
    indexer.close();
  }
}

function indexedHash(indexer: VaultIndexer, relativePath: string): string | undefined {
  return indexer.store.fileHash(relativePath);
}

export function reindexChangedPath(vaultRoot: string, inputPath: string): ReindexResult {
  const root = resolve(vaultRoot);
  const target = safeVaultPath(root, inputPath);
  if (isIgnored(target.relative)) {
    return { status: "skipped", path: target.relative, reason: "ignored-path" };
  }
  const indexer = new VaultIndexer(root);
  try {
    if (!indexExists(root) || !indexer.store.getState("last_full_rebuild")) {
      const report = indexer.fullRebuild();
      return { status: "rebuilt", path: target.relative, changedPaths: report.changedPaths };
    }

    if (existsSync(target.absolute) && statSync(target.absolute).isFile()) {
      const currentHash = hashFile(target.absolute);
      if (indexedHash(indexer, target.relative) === currentHash) {
        return { status: "skipped", path: target.relative, reason: "content-unchanged" };
      }
    } else if (!indexedHash(indexer, target.relative)) {
      return { status: "skipped", path: target.relative, reason: "path-not-indexed" };
    }

    const report = indexer.incrementalRebuild([target.absolute]);
    return { status: "reindexed", path: target.relative, changedPaths: report.changedPaths };
  } finally {
    indexer.close();
  }
}

export async function retryOnce<T>(callback: () => T): Promise<T> {
  try {
    return callback();
  } catch (firstError) {
    await Bun.sleep(RETRY_DELAY_MS);
    try {
      return callback();
    } catch {
      throw firstError;
    }
  }
}
