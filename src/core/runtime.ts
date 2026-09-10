import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addMissingSectionMarkers, findSections, getReadableSectionBody, getSectionBody, insertSectionMarker, parseMarkdown, replaceSectionBody } from "./markdown.js";
import { createFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { repositoryRelativePath, projectNodeId, noteNodeId } from "./identity.js";
import { VaultIndexer } from "./indexer.js";
import { scanVault, vaultHasExpectedGitIgnore } from "./vault.js";
import { GitAdapter } from "./git.js";
import { RUNTIME_DIRECTORY } from "./vault.js";
import type { Diagnostic, NoteFrontmatter, Section } from "./types.js";
import { ServiceError } from "./errors.js";
import type { DiffResult, GraphDirection, GraphEdgeRecord, GraphNodeRecord, GraphQueryResult, HealthResult, HistoryResult, IndexPhase, IndexRefreshResult, NoteCreateInput, NoteLinkSuggestion, NoteRecord, NoteSelector, NoteSource, NoteUpdateInput, RepositoryDiffResult, RepositoryHistoryResult, RepositoryRestoreResult, SectionReadResult, VaultChangeEvent, VaultChangeScope, VaultChangeSet, VaultCheckResult, VaultTree, VaultTreeNode, WorkspaceStatus, WriteResult } from "./runtime-types.js";
import type { IndexReport } from "./index-types.js";
import { startWatcher, type WatcherHandle } from "./watcher.js";
import { isWorkspaceIgnored, loadWorkspaceConfig, workspaceIgnorePatterns, workspaceManifestPath, repositoryRelativePath as workspaceRepositoryRelativePath, workspaceRepositoryMatches, type WorkspaceConfig, type WorkspaceRepository } from "./workspace.js";
import { WorkspaceIndexer } from "./workspace-indexer.js";
import { resolveWorkspaceAttachments, type NoteAttachmentInput } from "./workspace-attachments.js";
import { PdfExportJobManager, type PdfExportArtifact } from "./pdf-export-jobs.js";

const MAX_SEARCH_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_GRAPH_LIMIT = 100;
const MAX_CONTEXT_BYTES = 6_000;
// Graph neighborhoods are navigational context, not document transport. Keep
// the core/API budget materially smaller than the old generic 512 KiB ceiling;
// the MCP projection applies its stricter provider-facing cap afterwards.
const MAX_GRAPH_RESPONSE_BYTES = 64_000;
const MAX_CONFLICT_BODY_BYTES = 8_000;
const MAX_SECTION_BODY_BYTES = 16_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const MAX_CHANGE_HISTORY = 128;
const MAX_PENDING_WRITES = 256;

type NoteListCursor = { updatedAt: string; path: string };
type SectionBodyCursor = { noteId: string; sectionKey: string; revision: string; offset: number };
type TextPageCursor = { key: string; offset: number };

function decodeNoteCursor(value: string | undefined): NoteListCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<NoteListCursor>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.path !== "string") throw new Error("invalid cursor");
    return { updatedAt: parsed.updatedAt, path: parsed.path };
  } catch {
    throw new ServiceError("INVALID_INPUT", "Note list cursor is invalid.");
  }
}

function encodeNoteCursor(cursor: NoteListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSectionCursor(value: string | undefined): SectionBodyCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SectionBodyCursor>;
    if (typeof parsed.noteId !== "string" || typeof parsed.sectionKey !== "string" || typeof parsed.revision !== "string" || typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid cursor");
    const offset = parsed.offset;
    return { noteId: parsed.noteId, sectionKey: parsed.sectionKey, revision: parsed.revision, offset };
  } catch {
    throw new ServiceError("INVALID_INPUT", "Section body cursor is invalid.");
  }
}

function encodeSectionCursor(cursor: SectionBodyCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTextCursor(value: string | undefined): TextPageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TextPageCursor>;
    if (typeof parsed.key !== "string" || typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid cursor");
    return { key: parsed.key, offset: parsed.offset };
  } catch {
    throw new ServiceError("INVALID_INPUT", "Text page cursor is invalid.");
  }
}

function encodeTextCursor(cursor: TextPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function pageText(value: string, key: string, limit?: number, cursor?: string): { value: string; truncated?: boolean; next_cursor?: string } {
  const decoded = decodeTextCursor(cursor);
  if (decoded && decoded.key !== key) throw new ServiceError("CONFLICT", "The text changed while paging.", { recovery: "Refetch the diff without the cursor and restart paging." });
  const chunk = takeUtf8Chunk(value, decoded?.offset ?? 0, pageLimit(limit, MAX_SECTION_BODY_BYTES));
  return {
    value: chunk.body,
    ...(chunk.truncated ? { truncated: true, next_cursor: encodeTextCursor({ key, offset: chunk.nextOffset }) } : {}),
  };
}

function takeUtf8Chunk(value: string, offset: number, maxBytes: number): { body: string; nextOffset: number; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (offset > bytes.length) throw new ServiceError("INVALID_INPUT", "Section body cursor is beyond the current body.");
  if (bytes.length - offset <= maxBytes) return { body: bytes.subarray(offset).toString("utf8"), nextOffset: bytes.length, truncated: false };
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  // A single UTF-8 code point can be wider than a caller's requested page.
  // Include that complete code point rather than returning replacement
  // characters and a cursor that starts in the middle of it.
  if (end === offset) {
    end = Math.min(bytes.length, offset + 1);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  return { body: bytes.subarray(offset, end).toString("utf8"), nextOffset: end, truncated: end < bytes.length };
}

function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function indexSyncFailure(relative: string, contentHash: string | undefined, cause: unknown): ServiceError {
  return new ServiceError(
    "INDEX_SYNC_FAILED",
    `File '${relative}' was persisted but indexing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    {
      persisted: true,
      path: relative,
      ...(contentHash ? { content_hash: contentHash } : {}),
      index_status: "failed",
      recovery: "Inspect the index diagnostics and rebuild the Cortex projection before relying on graph or search results.",
    },
  );
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function pageLimit(value: number | undefined, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? maximum
    : Math.max(1, Math.min(Math.floor(value), maximum));
}

function jsonMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function slugify(value: string): string {
  const slug = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "untitled-note";
}

function diagnosticsHaveErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function trimPayload<T>(payload: T, maxBytes = MAX_CONTEXT_BYTES): { value: T; truncated: boolean } {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) <= maxBytes) return { value: payload, truncated: false };
  if (Array.isArray(payload)) {
    const result = [...payload] as unknown[];
    while (result.length > 0 && Buffer.byteLength(JSON.stringify(result)) > maxBytes) result.pop();
    return { value: result as T, truncated: true };
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = { ...(payload as Record<string, unknown>) };
    const arrays = Object.keys(value).filter((key) => Array.isArray(value[key]));
    while (arrays.some((key) => Array.isArray(value[key]) && value[key]!.length > 0) && Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
      const key = arrays.find((candidate) => Array.isArray(value[candidate]) && value[candidate]!.length > 0);
      if (!key) break;
      (value[key] as unknown[]).pop();
    }
    return { value: value as T, truncated: true };
  }
  return { value: payload, truncated: true };
}

function boundedText(value: string, maxBytes = MAX_CONFLICT_BODY_BYTES): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, Math.floor(value.length * (maxBytes / Math.max(1, Buffer.byteLength(value, "utf8")))));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}

function boundGraphPayload(graph: GraphQueryResult, maxBytes = MAX_GRAPH_RESPONSE_BYTES): GraphQueryResult {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  let omittedNodes = graph.omitted_nodes ?? 0;
  let omittedEdges = graph.omitted_edges ?? 0;
  const payload = (): GraphQueryResult => {
    const allowed = new Set([graph.anchor.nodeId, ...nodes.map((node) => node.nodeId)]);
    const closedEdges = edges.filter((edge) => allowed.has(edge.fromId) && allowed.has(edge.toId));
    const totalOmittedEdges = omittedEdges + edges.length - closedEdges.length;
    return {
      anchor: graph.anchor,
      nodes,
      edges: closedEdges,
      truncated: graph.truncated || omittedNodes > 0 || totalOmittedEdges > 0,
      ...(omittedNodes ? { omitted_nodes: omittedNodes } : {}),
      ...(totalOmittedEdges ? { omitted_edges: totalOmittedEdges } : {}),
    };
  };
  while (Buffer.byteLength(JSON.stringify(payload()), "utf8") > maxBytes && (nodes.length > 0 || edges.length > 0)) {
    if (edges.length > 0) {
      edges.pop();
      omittedEdges += 1;
    } else {
      nodes.pop();
      omittedNodes += 1;
    }
  }
  return payload();
}

function boundContextPayload(payload: Record<string, unknown>, maxBytes = MAX_CONTEXT_BYTES): Record<string, unknown> {
  const result: Record<string, unknown> = { ...payload };
  const fields = ["likely_files", "attached_notes", "related_nodes", "relationships", "task_matches"];
  for (const field of fields) if (Array.isArray(result[field])) result[field] = [...result[field] as unknown[]];
  const omitted: Record<string, number> = {};
  const minimum = new Map(fields.map((field) => [field, Array.isArray(result[field]) && result[field]!.length > 0 ? 1 : 0]));
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  const removalOrder = ["task_matches", "relationships", "related_nodes", "likely_files", "attached_notes"];
  while (size() > maxBytes) {
    const field = removalOrder.find((candidate) => Array.isArray(result[candidate]) && (result[candidate] as unknown[]).length > (minimum.get(candidate) ?? 0));
    if (!field) break;
    (result[field] as unknown[]).pop();
    omitted[field] = (omitted[field] ?? 0) + 1;
  }
  if (Object.keys(omitted).length === 0 && size() <= maxBytes) return result;
  return {
    ...result,
    truncated: Object.keys(omitted).length > 0 || size() > maxBytes,
    ...(Object.keys(omitted).length > 0 ? { truncated_categories: Object.keys(omitted), omitted_counts: omitted } : {}),
  };
}

class AsyncMutex {
  private tail = Promise.resolve();

  run<T>(callback: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class VaultRuntime {
  readonly vaultRoot: string;
  readonly indexer: VaultIndexer;
  workspace?: WorkspaceConfig;
  private gitAdapter?: GitAdapter;
  private workspaceIndexer?: WorkspaceIndexer;
  private workspaceAttachmentDiagnostics: Diagnostic[] = [];
  private readonly repoGit = new Map<string, GitAdapter>();
  private readonly repoWatchers = new Map<string, WatcherHandle>();
  private watcher?: WatcherHandle;
  private workspacePhase: IndexPhase = "disabled";
  private workspaceError?: string;
  private workspaceTask?: Promise<void>;
  private closing = false;
  private readonly writes = new AsyncMutex();
  private readonly subscribers = new Set<(changeSet: VaultChangeSet) => void>();
  private readonly changeHistory: VaultChangeSet[] = [];
  private readonly pendingWrites = new Map<string, string>();
  private readonly pdfExports = new PdfExportJobManager();
  private changeSequence = 0;
  private projectionGeneration = 1;

  private constructor(vaultRoot: string, indexer: VaultIndexer) {
    this.vaultRoot = vaultRoot;
    this.indexer = indexer;
    this.projectionGeneration = Number(indexer.store.getState("projection_generation") ?? "1") || 1;
  }

  /** Construct the vault Git adapter only for an operation that needs Git. */
  get git(): GitAdapter {
    this.gitAdapter ??= new GitAdapter(this.vaultRoot);
    return this.gitAdapter;
  }

  static async start(vaultRoot: string, options?: { workspaceRoot?: string }): Promise<VaultRuntime> {
    const indexer = new VaultIndexer(vaultRoot);
    try {
      const warm = indexer.warmRead();
      if (!warm.valid) indexer.fullRebuild();
      const service = new VaultRuntime(indexer.vaultRoot, indexer);
      const workspaceRequested = Boolean(options?.workspaceRoot) || Boolean(process.env.CORTEX_WORKSPACE_ROOT) || existsSync(workspaceManifestPath(service.vaultRoot));
      if (workspaceRequested) await service.startWorkspace(options?.workspaceRoot);
      service.watcher = await startWatcher(service.vaultRoot, async (events) => {
        await service.writes.run(() => {
          const normalized = events.map((event) => ({ ...event, path: service.normalizeEventPath(event.path) }));
          service.indexer.incrementalRebuild(normalized.map((event) => event.path));
          service.refreshWorkspaceAttachments();
          service.publishChanges(normalized);
        });
      });
      return service;
    } catch (error) {
      indexer.close();
      throw error;
    }
  }

  private async startWorkspace(workspaceRoot?: string): Promise<void> {
    const workspace = loadWorkspaceConfig(this.vaultRoot, workspaceRoot);
    this.workspace = workspace;
    this.workspaceIndexer = new WorkspaceIndexer(this.indexer.store, workspace);
    this.workspacePhase = workspace.workspaceExists ? "warming" : "error";
    this.workspaceError = workspace.workspaceExists ? undefined : `Workspace root does not exist: ${workspace.workspaceRoot}`;
    const ignorePatterns = workspaceIgnorePatterns(workspace.manifest);
    await Promise.all(workspace.repositories.map(async (repository, repositoryIndex) => {
      const watcherOptions = {
        ignorePath: (path: string) => isWorkspaceIgnored(path, ignorePatterns),
        ...(process.env.CORTEX_PACKAGED === "1" ? { pollStartDelayMs: repositoryIndex * 1_000 } : {}),
      };
      const handle = await startWatcher(repository.absolutePath, async (events) => {
        const normalized = events.map((event) => ({ ...event, path: this.normalizeEventPath(event.path, repository.absolutePath) }));
        this.workspacePhase = "rebuilding";
        try {
          await this.writes.run(() => {
            this.workspaceIndexer!.incrementalRebuild(repository.id);
            this.refreshWorkspaceAttachments();
          });
          this.workspacePhase = "current";
          this.workspaceError = undefined;
          this.publishChanges(normalized, repository.id);
        } catch (error) {
          this.workspacePhase = "error";
          this.workspaceError = error instanceof Error ? error.message : String(error);
          this.publishChanges([]);
        }
      }, watcherOptions);
      this.repoWatchers.set(repository.id, handle);
    }));
    if (workspace.workspaceExists) this.scheduleWorkspaceRebuild();
  }

  private scheduleWorkspaceRebuild(): void {
    this.workspaceTask = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.closing) {
          resolve();
          return;
        }
        void this.rebuildWorkspace().then(resolve, resolve);
      }, 0);
    });
  }

  private async rebuildWorkspace(): Promise<void> {
    if (!this.workspaceIndexer || !this.workspace?.workspaceExists) return;
    try {
      await this.rebuildWorkspaceInBackground();
      this.refreshWorkspaceAttachments();
      this.workspacePhase = "current";
      this.workspaceError = undefined;
      // An empty change batch is a status invalidation. It lets the UI learn
      // that background warming finished without inventing a fake file event.
      this.publishChanges([]);
    } catch (error) {
      this.workspacePhase = "error";
      this.workspaceError = error instanceof Error ? error.message : String(error);
      this.publishChanges([]);
    }
  }

  /** Run the expensive workspace projection in a separate process so source,
   * search, and health requests keep the main event loop available. */
  private async rebuildWorkspaceInBackground(): Promise<void> {
    if (!this.workspace) return;
    const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.ts");
    const args = existsSync(cliEntry)
      ? ["run", cliEntry, "workspace:rebuild", "--vault", this.vaultRoot, "--workspace", this.workspace.workspaceRoot]
      : ["workspace:rebuild", "--vault", this.vaultRoot, "--workspace", this.workspace.workspaceRoot];
    const child = Bun.spawn([process.execPath, ...args], { stdout: "ignore", stderr: "pipe" });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Background workspace projection exited with code ${exitCode}.`);
  }

  private refreshWorkspaceAttachments(): void {
    if (!this.workspace) return;
    const scan = scanVault(this.vaultRoot);
    const notes: NoteAttachmentInput[] = scan.notes
      .filter((note): note is typeof note & { frontmatter: NoteFrontmatter; filePath: string } => Boolean(note.frontmatter && note.filePath))
      .map((note) => ({ noteId: note.frontmatter.id, path: repositoryRelativePath(this.vaultRoot, note.filePath), appliesTo: note.frontmatter.applies_to }));
    const result = resolveWorkspaceAttachments(this.workspace, notes);
    this.indexer.store.replaceWorkspaceAttachmentEdges(result.edges);
    this.workspaceAttachmentDiagnostics = result.diagnostics;
  }

  private requireRepository(repositoryId: string): WorkspaceRepository {
    const normalized = repositoryId.trim();
    const matches = workspaceRepositoryMatches(this.workspace?.repositories ?? [], normalized);
    if (matches.length > 1) throw new ServiceError("INVALID_INPUT", `Repository selector '${repositoryId}' is ambiguous.`, {
      repository: repositoryId,
      candidates: matches.map((candidate) => candidate.id),
      recovery: "Use the exact repository id in the repository-qualified selector.",
    });
    const repository = matches[0];
    if (!repository) throw new ServiceError("NOT_FOUND", `Repository '${repositoryId}' was not discovered in the workspace.`, {
      repository: repositoryId,
      available_repositories: this.workspace?.repositories.map((candidate) => candidate.id) ?? [],
    });
    return repository;
  }

  private repoGitAdapter(repositoryId: string): GitAdapter {
    const repository = this.requireRepository(repositoryId);
    const existing = this.repoGit.get(repository.id);
    if (existing) return existing;
    const adapter = new GitAdapter(repository.absolutePath);
    this.repoGit.set(repository.id, adapter);
    return adapter;
  }

  private repositoryPath(repositoryId: string, target: string): { repository: WorkspaceRepository; relative: string } {
    const repository = this.requireRepository(repositoryId);
    const workspace = this.workspace!;
    if (target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target)) {
      throw new ServiceError("INVALID_INPUT", "Absolute paths are not accepted through MCP; use a repository-relative path.", {
        repository: repository.id,
        target,
        alternatives: [`repo:${repository.id}`, `file:${repository.id}:<relative-path>`, `dir:${repository.id}:<relative-path>`],
      });
    }
    try {
      return { repository, relative: workspaceRepositoryRelativePath(workspace.workspaceRoot, repository, target) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new ServiceError("INVALID_INPUT", message, {
        repository: repository.id,
        target,
        reason: message.includes("outside") ? "outside_repository" : message.includes("not indexable") ? "ignored" : "invalid_target",
        recovery: "Use a repository-relative target; use '.' for the repository root.",
      });
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.pdfExports.close();
    await this.watcher?.stop();
    await this.watcher?.flushSnapshot();
    for (const handle of this.repoWatchers.values()) {
      await handle.stop();
      await handle.flushSnapshot();
    }
    await this.workspaceTask;
    this.indexer.close();
    this.subscribers.clear();
  }

  async waitForWorkspace(): Promise<void> {
    await this.workspaceTask;
  }

  async rebuildIndex(): Promise<IndexRefreshResult> {
    return this.writes.run(() => {
      const workspaceExists = Boolean(this.workspace?.workspaceExists && this.workspaceIndexer);
      if (workspaceExists) {
        this.workspacePhase = "rebuilding";
        this.workspaceError = undefined;
        this.publishChanges([]);
      }

      try {
        const index = this.indexer.fullRebuild();
        const workspace = this.workspaceIndexer?.fullRebuild();
        if (workspaceExists) {
          this.refreshWorkspaceAttachments();
          this.workspacePhase = "current";
          this.workspaceError = undefined;
        }
        this.publishChanges([]);
        return { index, workspace };
      } catch (error) {
        if (workspaceExists) {
          this.workspacePhase = "error";
          this.workspaceError = error instanceof Error ? error.message : String(error);
          this.publishChanges([]);
        }
        throw error;
      }
    });
  }

  subscribe(listener: (changeSet: VaultChangeSet) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Return buffered changes after a sequence, or require a state refetch when the buffer cannot bridge the gap. */
  changesSince(sequence: number): { changes: VaultChangeSet[]; resyncRequired: boolean; sequence: number; generation: number } {
    const currentSequence = this.changeSequence;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > currentSequence) {
      return { changes: [], resyncRequired: true, sequence: currentSequence, generation: this.projectionGeneration };
    }
    if (sequence === currentSequence) return { changes: [], resyncRequired: false, sequence: currentSequence, generation: this.projectionGeneration };
    const changes = this.changeHistory.filter((change) => change.sequence > sequence);
    const first = changes[0];
    const contiguous = Boolean(first && first.sequence === sequence + 1);
    return { changes: contiguous ? changes : [], resyncRequired: !contiguous, sequence: currentSequence, generation: this.projectionGeneration };
  }

  private normalizeEventPath(path: string, root: string = this.vaultRoot): string {
    const realRoot = realpathSync(root);
    const realPath = existsSync(path) ? realpathSync(path) : path;
    const relative = relativePath(realRoot, realPath).split("\\").join("/");
    if (relative === ".." || relative.startsWith("../")) throw new Error("Watcher reported a path outside the root.");
    return resolve(root, relative);
  }

  private publishChanges(events: Array<{ type: "create" | "update" | "delete"; path: string; scopes?: VaultChangeScope[] }>, repositoryId?: string): void {
    const root = repositoryId ? this.requireRepository(repositoryId).absolutePath : this.vaultRoot;
    const changes = events.flatMap((event) => {
      const relative = repositoryRelativePath(root, event.path);
      const repository = repositoryId ? { repository: repositoryId } : {};
      const scopes: VaultChangeScope[] = repositoryId
        ? ["repository", "graph"]
        : event.type === "delete" || event.type === "create"
          ? ["content", "catalog", "tree", "graph"]
          : ["content", "graph"];
      const eventScopes = event.scopes ?? scopes;
      if (!repositoryId && event.type !== "delete" && this.pendingWrites.get(relative)) {
        const expectedHash = this.pendingWrites.get(relative);
        try {
          if (expectedHash === hashContent(readFileSync(event.path))) {
            this.pendingWrites.delete(relative);
            return [];
          }
        } catch {
          // The watcher may race a rename; retain the pending marker until a later event.
        }
      }
      if (event.type === "delete" || !existsSync(event.path)) return { type: event.type, path: relative, scopes: eventScopes, ...repository } satisfies VaultChangeEvent;
      try {
        const stats = statSync(event.path);
        return {
          type: event.type,
          path: relative,
          scopes: eventScopes,
          content_hash: hashContent(readFileSync(event.path)),
          mtime: new Date(stats.mtimeMs).toISOString(),
          ...repository,
        } satisfies VaultChangeEvent;
      } catch {
        return { type: event.type, path: relative, scopes: eventScopes, ...repository } satisfies VaultChangeEvent;
      }
    }).flat();
    if (events.length > 0 && changes.length === 0) return;
    this.changeSequence += 1;
    this.projectionGeneration += 1;
    const changeSet: VaultChangeSet = { sequence: this.changeSequence, generation: this.projectionGeneration, events: changes };
    this.changeHistory.push(changeSet);
    if (this.changeHistory.length > MAX_CHANGE_HISTORY) this.changeHistory.splice(0, this.changeHistory.length - MAX_CHANGE_HISTORY);
    for (const subscriber of this.subscribers) subscriber(changeSet);
  }

  private relativePath(input: string, allowMissing = false): { absolute: string; relative: string } {
    if (!input || input.includes("\0")) throw new ServiceError("INVALID_INPUT", "A non-empty vault-relative path is required.");
    const candidate = input.replaceAll("\\", "/");
    if (candidate.startsWith("/") || /^[a-zA-Z]:\//.test(candidate)) throw new ServiceError("INVALID_INPUT", "Absolute paths are not accepted.");
    const absolute = resolve(this.vaultRoot, candidate);
    const relative = repositoryRelativePath(this.vaultRoot, absolute);
    if (relative === "." || relative === ".." || relative.startsWith("../")) throw new ServiceError("INVALID_INPUT", "Path is outside the configured vault.");
    if (relative === ".git" || relative.startsWith(".git/") || relative === RUNTIME_DIRECTORY || relative.startsWith(`${RUNTIME_DIRECTORY}/`) || relative === "node_modules" || relative.startsWith("node_modules/")) {
      throw new ServiceError("INVALID_INPUT", "Git, runtime, and dependency paths are not accessible through MCP.");
    }
    if (!allowMissing && !existsSync(absolute)) throw new ServiceError("NOT_FOUND", `Path '${relative}' does not exist.`);
    return { absolute, relative };
  }

  private noteRow(selector: NoteSelector): NoteRecord {
    const normalizedSelector = selector.trim();
    if (normalizedSelector.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(normalizedSelector)) {
      throw new ServiceError("INVALID_INPUT", "Absolute paths are not accepted through MCP; use a vault-relative note path or a canonical note selector.", {
        selector,
        alternatives: ["notes/<relative-note>.md", "note:<uuid>", "a note title or alias discovered with search"],
        recovery: "Call search to discover a note path, title, alias, or UUID, then retry with that selector.",
      });
    }
    const explicitId = normalizedSelector.startsWith("note:") ? normalizedSelector.slice("note:".length) : normalizedSelector;
    let row = UUID_RE.test(explicitId) ? this.indexer.store.noteById(explicitId.toLocaleLowerCase()) : undefined;
    if (!row && (UUID_RE.test(normalizedSelector) || normalizedSelector.startsWith("note:"))) {
      throw new ServiceError("NOT_FOUND", `Note '${selector}' was not found.`);
    }
    if (!row) {
      try {
        row = this.indexer.store.noteByPath(this.relativePath(normalizedSelector).relative);
      } catch (error) {
        // A title, alias, or filename stem is not a path. Preserve path
        // traversal and absolute-path errors, but continue into exact note
        // identity resolution for ordinary not-found path candidates.
        if (!(error instanceof ServiceError) || error.code !== "NOT_FOUND") throw error;
      }
    }
    if (!row) {
      const allMatches = this.indexer.store.noteMatches(normalizedSelector);
      const normalized = normalizedSelector.toLocaleLowerCase();
      const stemMatches = allMatches.filter((candidate) => basename(candidate.path, extname(candidate.path)).toLocaleLowerCase() === normalized);
      const titleMatches = allMatches.filter((candidate) => candidate.title.toLocaleLowerCase() === normalized);
      const aliasMatches = allMatches.filter((candidate) => candidate.aliases.some((alias) => alias.toLocaleLowerCase() === normalized));
      // Keep the selector precedence explicit: a filename stem wins over a
      // title, which wins over an alias. Only ties within the selected class
      // are ambiguous; a match in a lower-priority class must not create a
      // false ambiguity for a stronger identity.
      const matches = [stemMatches, titleMatches, aliasMatches].find((candidateMatches) => candidateMatches.length > 0) ?? [];
      if (matches.length > 1) {
        throw new ServiceError("AMBIGUOUS_NOTE", `Note selector '${selector}' matches more than one note.`, {
          selector,
          candidates: matches.slice(0, 5).map((candidate) => ({ id: candidate.id, path: candidate.path, title: candidate.title })),
          omitted_candidates: Math.max(0, matches.length - 5),
        });
      }
      row = matches[0];
    }
    if (!row) {
      const suggestions = this.indexer.store.noteSuggestions(normalizedSelector, 5).notes;
      throw new ServiceError("NOT_FOUND", `Note '${selector}' was not found.`, {
        selector,
        candidates: suggestions.map((candidate) => ({ id: candidate.id, path: candidate.path, title: candidate.title })),
      });
    }
    const absolute = resolve(this.vaultRoot, row.path);
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      type: row.type,
      created_at: row.created_at,
      updated_at: row.updated_at,
      aliases: row.aliases,
      tags: row.tags,
      content_hash: hashContent(readFileSync(absolute, "utf8")),
    };
  }

  private resolveGraphNode(selector: string): GraphNodeRecord {
    const normalized = selector.trim();
    if (normalized.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(normalized)) {
      throw new ServiceError("INVALID_INPUT", "Absolute paths are not accepted through MCP; use a namespaced graph selector.", {
        selector,
        alternatives: ["project:root", "repo:<repository-id>", "file:<repository-id>:<relative-path>", "dir:<repository-id>:<relative-path>", "note:<uuid>"],
        recovery: "Use a canonical namespaced graph ID or a repository-qualified relative path.",
      });
    }
    const noteIdSelector = normalized.match(/^note:(.+)$/i)?.[1];
    let nodeId = UUID_RE.test(normalized)
      ? noteNodeId(normalized.toLocaleLowerCase())
      : noteIdSelector && UUID_RE.test(noteIdSelector)
        ? noteNodeId(noteIdSelector.toLocaleLowerCase())
        : normalized;
    let row = this.indexer.store.unifiedNode(nodeId);
    if (!row) {
      // Node IDs are canonical, but repository aliases and UUID selectors are
      // case-insensitive at the MCP seam. Resolve an otherwise canonical ID
      // without weakening path traversal or absolute-path validation below.
      const folded = normalized.toLocaleLowerCase();
      const caseInsensitive = this.indexer.store.unifiedNodes().find((candidate) => candidate.node_id.toLocaleLowerCase() === folded);
      if (caseInsensitive) {
        row = caseInsensitive;
        nodeId = caseInsensitive.node_id;
      }
    }
    if (!row) {
      const namespaced = normalized.match(/^(repo|file|dir|package):([^:]+)(?::(.+))?$/i);
      const repositorySelector = namespaced?.[2];
      if (namespaced && repositorySelector) {
        const repositoryMatches = workspaceRepositoryMatches(this.workspace?.repositories ?? [], repositorySelector);
        if (repositoryMatches.length > 1) throw new ServiceError("AMBIGUOUS_GRAPH_NODE", `Repository selector '${repositorySelector}' matches more than one repository.`, {
          selector,
          candidates: repositoryMatches.map((candidate) => ({ node: `repo:${candidate.id}`, kind: "repository", path: candidate.path, name: candidate.id })),
          recovery: "Use the exact repository id in the namespaced graph selector.",
        });
        const repository = repositoryMatches[0];
        if (repository) {
          const kind = namespaced[1]!.toLocaleLowerCase();
          const path = namespaced[3];
          const canonical = kind === "repo" ? `repo:${repository.id}` : path ? `${kind}:${repository.id}:${path}` : undefined;
          if (canonical) {
            row = this.indexer.store.unifiedNode(canonical);
            if (!row) row = this.indexer.store.unifiedNodes().find((candidate) => candidate.node_id.toLocaleLowerCase() === canonical.toLocaleLowerCase());
            if (row) nodeId = row.node_id;
          }
        }
      }
    }
    if (!row && !normalized.includes(":")) {
      // Repository aliases are checked before vault paths because a common
      // grounding call is project_map({ node: "cortex" }).
      const repositoryMatches = workspaceRepositoryMatches(this.workspace?.repositories ?? [], normalized);
      if (repositoryMatches.length > 1) throw new ServiceError("AMBIGUOUS_GRAPH_NODE", `Repository selector '${selector}' matches more than one repository.`, {
        selector,
        candidates: repositoryMatches.map((candidate) => ({ node: `repo:${candidate.id}`, kind: "repository", path: candidate.path, name: candidate.id })),
        recovery: "Use the exact repo:<repository-id> selector.",
      });
      const repository = repositoryMatches[0];
      const repositoryId = repository?.id ?? normalized;
      row = this.indexer.store.unifiedNode(`repo:${repositoryId}`);
      if (row) nodeId = row.node_id;
    }
    if (!row && !normalized.includes(":") && normalized.includes("/")) {
      const [repositoryCandidate, ...pathParts] = normalized.split("/");
      const repositoryMatches = workspaceRepositoryMatches(this.workspace?.repositories ?? [], repositoryCandidate);
      if (repositoryMatches.length > 1) throw new ServiceError("AMBIGUOUS_GRAPH_NODE", `Repository selector '${repositoryCandidate}' matches more than one repository.`, {
        selector,
        candidates: repositoryMatches.map((candidate) => ({ node: `repo:${candidate.id}`, kind: "repository", path: candidate.path, name: candidate.id })),
        recovery: "Use the exact repository id in the repository-qualified path.",
      });
      const repository = repositoryMatches[0];
      if (repository) {
        const relative = pathParts.join("/") || ".";
        const candidates = relative === "."
          ? [`repo:${repository.id}`]
          : [`file:${repository.id}:${relative}`, `dir:${repository.id}:${relative}`];
        const resolved = candidates.map((candidate) => this.indexer.store.unifiedNode(candidate)).find((candidate) => candidate);
        if (resolved) {
          row = resolved;
          nodeId = resolved.node_id;
        }
      }
    }
    if (!row && !normalized.includes(":")) {
      const workspacePathCandidates = this.indexer.store.unifiedNodes()
        .filter((candidate) => (candidate.node_id.startsWith("file:") || candidate.node_id.startsWith("dir:")) && candidate.node_id.endsWith(`:${normalized}`));
      if (workspacePathCandidates.length > 1) {
        throw new ServiceError("AMBIGUOUS_GRAPH_NODE", `Repository-relative graph path '${selector}' matches more than one repository.`, {
          selector,
          candidates: workspacePathCandidates.slice(0, 5).map((candidate) => ({ node: candidate.node_id, kind: candidate.kind, path: candidate.path ?? undefined, name: candidate.name })),
          omitted_candidates: Math.max(0, workspacePathCandidates.length - 5),
          recovery: "Use a repository-qualified selector such as file:<repository-id>:<relative-path> or dir:<repository-id>:<relative-path>.",
        });
      }
      const workspacePathCandidate = workspacePathCandidates[0];
      if (workspacePathCandidate) {
        row = workspacePathCandidate;
        nodeId = workspacePathCandidate.node_id;
      }
    }
    if (!row && !normalized.includes(":")) {
      try {
        const relative = this.relativePath(normalized).relative;
        nodeId = relative === "." ? projectNodeId() : this.indexer.store.graphNodeIdByPath(relative) ?? "";
        row = nodeId ? this.indexer.store.unifiedNode(nodeId) : undefined;
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "NOT_FOUND") throw error;
      }
    }
    if (!row && !normalized.includes(":")) {
      try {
        const note = this.noteRow(normalized);
        nodeId = noteNodeId(note.id);
        row = this.indexer.store.unifiedNode(nodeId);
      } catch (error) {
        if (error instanceof ServiceError && (error.code === "AMBIGUOUS_NOTE" || error.code === "INVALID_INPUT")) throw error;
      }
    }
    if (!row) {
      const candidateRows = this.indexer.store.unifiedNodes()
        .filter((candidate) => candidate.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())
      const candidates = candidateRows.slice(0, 5)
        .map((candidate) => ({ node: candidate.node_id, kind: candidate.kind, path: candidate.path ?? undefined, name: candidate.name }));
      if (candidateRows.length > 1) {
        throw new ServiceError("AMBIGUOUS_GRAPH_NODE", `Graph selector '${selector}' matches more than one node.`, { selector, candidates, omitted_candidates: Math.max(0, candidateRows.length - 5) });
      }
      throw new ServiceError("NOT_FOUND", `Graph node '${selector}' was not found.`, {
        selector,
        candidates,
        recovery: "Use a namespaced node such as project:root, repo:<repository-id>, file:<repository-id>:<relative-path>, dir:<repository-id>:<relative-path>, or note:<uuid>.",
      });
    }
    return { nodeId: row.node_id, kind: row.kind, path: row.path ?? undefined, name: row.name, metadata: jsonMetadata(row.metadata_json) };
  }

  private queryGraphInternal(selector: string, direction: GraphDirection, depth: number, limit: number): GraphQueryResult {
    const anchor = this.resolveGraphNode(selector);
    const visited = new Set([anchor.nodeId]);
    const omittedNodeIds = new Set<string>();
    const frontier = [anchor.nodeId];
    const edges = new Map<string, GraphEdgeRecord>();
    let traversalTruncated = false;
    for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const outgoing = direction === "in" ? [] : this.indexer.store.unifiedEdgesFrom(nodeId);
        const incoming = direction === "out" ? [] : this.indexer.store.unifiedEdgesTo(nodeId);
        // SQLite does not promise row order. Stable traversal makes the
        // bounded neighborhood reproducible and prevents a high-degree node
        // from returning a different slice on each request.
        const adjacent = [...outgoing, ...incoming].sort((left, right) =>
          left.kind.localeCompare(right.kind)
          || left.from_id.localeCompare(right.from_id)
          || left.to_id.localeCompare(right.to_id)
          || left.metadata_json.localeCompare(right.metadata_json),
        );
        for (const row of adjacent) {
          const edge = { fromId: row.from_id, toId: row.to_id, kind: row.kind, metadata: jsonMetadata(row.metadata_json) };
          edges.set(`${edge.fromId}|${edge.toId}|${edge.kind}|${row.metadata_json}`, edge);
          const neighbor = direction === "in" ? edge.fromId : edge.toId;
          if (direction === "neighbors") {
            const other = edge.fromId === nodeId ? edge.toId : edge.fromId;
            if (!this.indexer.store.unifiedNode(other)) continue;
            if (!visited.has(other)) {
              if (visited.size >= limit + 1) {
                omittedNodeIds.add(other);
                traversalTruncated = true;
              } else {
                visited.add(other);
                next.push(other);
              }
            }
          } else if (!visited.has(neighbor)) {
            if (!this.indexer.store.unifiedNode(neighbor)) continue;
            if (visited.size >= limit + 1) {
              omittedNodeIds.add(neighbor);
              traversalTruncated = true;
            } else {
              visited.add(neighbor);
              next.push(neighbor);
            }
          }
        }
      }
      frontier.splice(0, frontier.length, ...next);
      if (traversalTruncated) break;
    }
    const ids = [...visited].slice(0, limit + 1);
    const nodes = ids.map((id) => this.resolveGraphNode(id));
    const allowed = new Set(ids);
    const returnedEdges = [...edges.values()].filter((edge) => allowed.has(edge.fromId) && allowed.has(edge.toId));
    const omittedNodes = omittedNodeIds.size + Math.max(0, visited.size - ids.length);
    const omittedEdges = Math.max(0, edges.size - returnedEdges.length);
    return {
      anchor,
      nodes: nodes.slice(1),
      edges: returnedEdges,
      truncated: traversalTruncated || omittedNodes > 0 || omittedEdges > 0,
      ...(omittedNodes ? { omitted_nodes: omittedNodes } : {}),
      ...(omittedEdges ? { omitted_edges: omittedEdges } : {}),
    };
  }

  getNote(selector: NoteSelector): { note: NoteRecord; sections: Section[] } {
    const note = this.noteRow(selector);
    const absolute = resolve(this.vaultRoot, note.path);
    const content = readFileSync(absolute, "utf8");
    const parsed = parseMarkdown(content, absolute);
    return { note, sections: parsed.sections };
  }

  getSource(selector: NoteSelector): NoteSource {
    const note = this.noteRow(selector);
    const absolute = resolve(this.vaultRoot, note.path);
    const markdown = readFileSync(absolute, "utf8");
    const parsed = parseMarkdown(markdown, absolute);
    const frontmatter = parsed.frontmatter ?? {
      id: note.id,
      title: note.title,
      type: note.type,
      created_at: note.created_at,
      updated_at: note.updated_at,
      aliases: note.aliases,
      tags: note.tags,
      applies_to: [],
      extra: {},
    } satisfies NoteFrontmatter;
    return { note, markdown, body: parsed.body, frontmatter, sections: parsed.sections, diagnostics: parsed.diagnostics };
  }

  async exportPdf(selector: NoteSelector, body?: string, title?: string, options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<Buffer> {
    const artifact = await this.exportPdfArtifact(selector, body, title, options);
    return artifact.pdf;
  }

  async exportPdfArtifact(selector: NoteSelector, body?: string, title?: string, options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<PdfExportArtifact> {
    const note = this.noteRow(selector);
    const absolute = resolve(this.vaultRoot, note.path);
    const source = body === undefined || title === undefined ? this.getSource(selector) : undefined;
    const exportBody = body ?? source?.body ?? "";
    const exportTitle = (title ?? source?.frontmatter.title ?? note.title).trim();
    return this.pdfExports.submit({ notePath: absolute, title: exportTitle, body: exportBody, vaultRoot: this.vaultRoot }, options);
  }

  vaultTree(): VaultTree {
    const noteRows = this.indexer.store.noteHeaders();
    const notesByPath = new Map(noteRows.map((row) => [row.path, row]));
    const visit = (directory: string, relativeDirectory: string): VaultTreeNode[] => {
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.name !== ".git" && entry.name !== RUNTIME_DIRECTORY && entry.name !== "node_modules")
        .sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      return entries.map((entry) => {
        const absolute = join(directory, entry.name);
        const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return { kind: "directory", path, name: entry.name, children: visit(absolute, path) } satisfies VaultTreeNode;
        }
        const note = notesByPath.get(path);
        if (note) {
          return { kind: "note", path, name: entry.name, noteId: note.note_id, title: note.title, type: note.type, updated_at: note.updated_at } satisfies VaultTreeNode;
        }
        return { kind: "file", path, name: entry.name, openable: false } satisfies VaultTreeNode;
      });
    };
    return { rootName: basename(this.vaultRoot), children: visit(this.vaultRoot, ""), truncated: false };
  }

  getSection(selector: NoteSelector, sectionId?: string, heading?: string, limit?: number, cursor?: string): SectionReadResult {
    if (sectionId && heading) throw new ServiceError("INVALID_INPUT", "Provide only one of section_id or heading.");
    if (!sectionId && !heading) throw new ServiceError("INVALID_INPUT", "get_section requires section_id or heading.");
    const note = this.noteRow(selector);
    const content = readFileSync(resolve(this.vaultRoot, note.path), "utf8");
    const parsed = parseMarkdown(content);
    const matches = findSections(parsed, sectionId ? { id: sectionId } : { heading });
    if (matches.length === 0) throw new ServiceError("NOT_FOUND", `Section '${sectionId ?? heading}' was not found.`, {
      note_path: note.path,
      section_id: sectionId,
      heading,
      recovery: "Call get_note first to obtain a current section_id, or use a unique case-insensitive heading.",
    });
    if (matches.length > 1) throw new ServiceError("AMBIGUOUS_SECTION", `Section selector '${sectionId ?? heading}' is ambiguous.`, {
      note_path: note.path,
      section_id: sectionId,
      heading,
      candidates: matches.slice(0, 5).map((match) => ({ section_id: match.id, heading: match.heading, revision: match.revision })),
      omitted_candidates: Math.max(0, matches.length - 5),
      recovery: "Use the unique section_id returned by get_note.",
    });
    const section = matches[0];
    const fullBody = getReadableSectionBody(content, section, true);
    const sectionKey = section.id ?? section.heading.toLocaleLowerCase();
    const decodedCursor = decodeSectionCursor(cursor);
    if (decodedCursor && (decodedCursor.noteId !== note.id || decodedCursor.sectionKey !== sectionKey)) {
      throw new ServiceError("CONFLICT", "Section body cursor belongs to a different section.", {
        note_path: note.path,
        section_id: section.id,
        heading: section.heading,
        recovery: "Call get_section again without the cursor to obtain a fresh bounded slice.",
      });
    }
    if (decodedCursor && decodedCursor.revision !== section.revision) {
      throw new ServiceError("CONFLICT", "Section changed while paging.", {
        note_path: note.path,
        section_id: section.id,
        expected_revision: decodedCursor.revision,
        actual_revision: section.revision,
        recovery: "Call get_section again without the cursor and restart paging from the new revision.",
      });
    }
    const chunk = takeUtf8Chunk(fullBody, decodedCursor?.offset ?? 0, pageLimit(limit, MAX_SECTION_BODY_BYTES));
    const writable = getSectionBody(content, section, true) !== undefined;
    return {
      note,
      section,
      body: chunk.body,
      revision: section.revision,
      writable,
      ...(writable ? {} : { write_warning: "missing_section_marker" as const }),
      ...(chunk.truncated ? {
        body_truncated: true,
        next_cursor: encodeSectionCursor({ noteId: note.id, sectionKey, revision: section.revision, offset: chunk.nextOffset }),
      } : {}),
    };
  }

  async patchSection(selector: NoteSelector, sectionId: string | undefined, expectedRevision: string, newContent: string, options?: { heading?: string; ensureMarker?: boolean }): Promise<WriteResult> {
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      const absolute = resolve(this.vaultRoot, note.path);
      const original = readFileSync(absolute, "utf8");
      const parsed = parseMarkdown(original, absolute);
      if (!sectionId && !options?.heading) throw new ServiceError("INVALID_INPUT", "patch_section requires section_id or heading.");
      if (sectionId && options?.heading) throw new ServiceError("INVALID_INPUT", "Provide only one of section_id or heading.");
      const heading = options?.heading;
      const matches = findSections(parsed, sectionId ? { id: sectionId } : { heading });
      if (matches.length === 0) throw new ServiceError("NOT_FOUND", `Section '${sectionId ?? heading}' was not found.`, {
        note_path: note.path,
        section_id: sectionId,
        heading,
        recovery: "Call get_note first to obtain a current section_id, or use a unique case-insensitive heading.",
      });
      if (matches.length > 1) throw new ServiceError("AMBIGUOUS_SECTION", `Section selector '${sectionId ?? heading}' is ambiguous.`, {
        note_path: note.path,
        section_id: sectionId,
        heading,
        candidates: matches.slice(0, 5).map((match) => ({ section_id: match.id, heading: match.heading, revision: match.revision })),
        omitted_candidates: Math.max(0, matches.length - 5),
        recovery: "Use the unique section_id returned by get_note.",
      });
      if (diagnosticsHaveErrors(parsed.diagnostics)) throw new ServiceError("CONFLICT", "The note has invalid section metadata.", {
        note_path: note.path,
        recovery: "Repair duplicate or invalid section metadata with a full-note update before patching a section.",
      });
      let section = matches[0];
      const currentBody = boundedText(getReadableSectionBody(original, section, true));
      if (section.revision !== expectedRevision) throw new ServiceError("CONFLICT", "Section revision is stale.", {
        expected_revision: expectedRevision,
        actual_revision: section.revision,
        note_path: note.path,
        section_id: section.id,
        heading: section.heading,
        current_body: currentBody.value,
        ...(currentBody.truncated ? { current_body_truncated: true } : {}),
        recovery: "Call get_section again with this note and section_id or heading, then reapply the intended change with the new revision.",
      });
      let writableOriginal = original;
      if (getSectionBody(original, section, true) === undefined) {
        if (!options?.ensureMarker) throw new ServiceError("SECTION_NOT_WRITABLE", `Section '${section.heading}' has no writable section marker.`, {
          note_path: note.path,
          heading: section.heading,
          recovery: "Call patch_section again with ensure_marker: true after confirming the heading is unique, or use replace_note.",
        });
        const inserted = insertSectionMarker(original, section);
        writableOriginal = inserted.text;
        const reparsed = parseMarkdown(writableOriginal, absolute);
        section = findSections(reparsed, { id: inserted.id })[0];
        if (!section) throw new ServiceError("CONFLICT", "The section marker could not be inserted safely.");
      }
      const body = replaceSectionBody(writableOriginal, section, newContent.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, ""));
      const reparsed = parseMarkdown(body, absolute);
      const updated = { ...(reparsed.frontmatter ?? parsed.frontmatter!), updated_at: new Date().toISOString() };
      const content = serializeFrontmatter(updated) + reparsed.body;
      const result = this.writeAndIndexLocked(note.path, content, "update", ["content", "graph"]);
      return { ...result, changed_sections: [section.id ?? section.heading] };
    });
  }

  async replaceNote(selector: NoteSelector, expectedHash: string, markdown: string): Promise<WriteResult> {
    return this.updateNote(selector, expectedHash, { markdown });
  }

  async updateNote(selector: NoteSelector, expectedHash: string, input: NoteUpdateInput): Promise<WriteResult> {
    if (!HASH_RE.test(expectedHash)) throw new ServiceError("INVALID_INPUT", "expected_file_hash must be a SHA-256 hash.");
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      const absolute = resolve(this.vaultRoot, note.path);
      const current = readFileSync(absolute, "utf8");
      const actualHash = hashContent(current);
      if (actualHash !== expectedHash) {
        throw new ServiceError("CONFLICT", "Note file hash is stale.", {
          expected_file_hash: expectedHash,
          actual_file_hash: actualHash,
          note_path: note.path,
          current_mtime: new Date(statSync(absolute).mtimeMs).toISOString(),
          recovery: "Call get_note or get_source again, then issue a new full-file write with the fresh expected_file_hash. Cortex does not automatically rebase this update.",
        });
      }
      if (input.markdown === undefined && input.body === undefined && input.metadata === undefined) {
        throw new ServiceError("INVALID_INPUT", "A note update must include markdown, body, or metadata.");
      }
      const parsed = parseMarkdown(input.markdown ?? current, absolute);
      if (diagnosticsHaveErrors(parsed.diagnostics) || !parsed.frontmatter) throw new ServiceError("INVALID_INPUT", "Replacement Markdown has invalid frontmatter or section metadata.", { diagnostics: parsed.diagnostics });
      if (parsed.frontmatter.id !== note.id || parsed.frontmatter.created_at !== note.created_at) throw new ServiceError("CONFLICT", "id and created_at are immutable.");
      const metadata = input.metadata ?? {};
      const frontmatter: NoteFrontmatter = {
        ...parsed.frontmatter,
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.type === undefined ? {} : { type: metadata.type }),
        ...(metadata.aliases === undefined ? {} : { aliases: metadata.aliases }),
        ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
        ...(metadata.applies_to === undefined ? {} : { applies_to: metadata.applies_to }),
        ...(metadata.extra === undefined ? {} : { extra: metadata.extra }),
        updated_at: new Date().toISOString(),
      };
      if (this.workspace) this.validateAppliesTo(frontmatter.applies_to);
      const body = input.body ?? parsed.body;
      const content = serializeFrontmatter(frontmatter) + body;
      const metadataScopes: VaultChangeScope[] = input.metadata
        ? ["content", "catalog", "tree", "graph"]
        : ["content", "graph"];
      const result = this.writeAndIndexLocked(note.path, content, "update", metadataScopes);
      if (this.workspace) this.refreshWorkspaceAttachments();
      return result;
    });
  }

  async createNote(input: NoteCreateInput): Promise<WriteResult & { id: string }> {
    return this.writes.run(() => {
      if (this.workspace && input.applies_to) this.validateAppliesTo(input.applies_to);
      const frontmatter = createFrontmatter({ title: input.title, type: input.type, aliases: input.aliases, tags: input.tags, applies_to: input.applies_to });
      const marked = addMissingSectionMarkers(input.body ?? "");
      const body = marked.body;
      const content = serializeFrontmatter(frontmatter) + body;
      const relative = input.path ? this.relativePath(input.path, true).relative : this.nextNotePath(slugify(frontmatter.title));
      if (extname(relative).toLocaleLowerCase() !== ".md") throw new ServiceError("INVALID_INPUT", "Notes must use a .md path.");
      if (existsSync(resolve(this.vaultRoot, relative))) throw new ServiceError("CONFLICT", `Note path '${relative}' already exists.`);
      const result = this.writeAndIndexLocked(relative, content, "create", ["content", "catalog", "tree", "graph"]);
      if (this.workspace) this.refreshWorkspaceAttachments();
      return { ...result, id: frontmatter.id, changed_sections: marked.added };
    });
  }

  private validateAppliesTo(appliesTo: NoteFrontmatter["applies_to"]): void {
    if (!this.workspace) return;
    const missing = appliesTo.find((entry) => !entry.repository);
    if (missing) throw new ServiceError("INVALID_INPUT", `Workspace mode requires an explicit 'repository' field on applies_to entries (missing for target '${missing.target}').`, {
      target: missing.target,
      available_repositories: this.workspace.repositories.map((repository) => repository.id),
      recovery: "Keep applies_to metadata and add one of the discovered repository ids as applies_to.repository; do not remove the attachment.",
    });
    for (const entry of appliesTo) {
      const matches = workspaceRepositoryMatches(this.workspace.repositories, entry.repository!);
      if (matches.length === 0) throw new ServiceError("INVALID_INPUT", `Attachment repository '${entry.repository}' was not discovered in the workspace.`, {
        repository: entry.repository,
        available_repositories: this.workspace.repositories.map((repository) => repository.id),
        recovery: "Use one of the discovered repository ids in applies_to.repository.",
      });
      if (matches.length > 1) throw new ServiceError("INVALID_INPUT", `Attachment repository '${entry.repository}' is ambiguous.`, {
        repository: entry.repository,
        candidates: matches.map((repository) => repository.id),
        recovery: "Use the exact repository id in applies_to.repository.",
      });
    }
  }

  private writeAndIndexLocked(relative: string, content: string, eventType: "create" | "update" = "update", scopes?: VaultChangeScope[]): WriteResult {
    const { absolute } = this.relativePath(relative, true);
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.cortex-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, "utf8");
      renameSync(temporary, absolute);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    const contentHash = hashContent(content);
    let index: IndexReport;
    try {
      index = this.indexer.incrementalRebuild([absolute]);
    } catch (error) {
      throw indexSyncFailure(relative, contentHash, error);
    }
    const stats = statSync(absolute);
    this.publishChanges([{ type: eventType, path: absolute, scopes }]);
    // Mark the accepted bytes after publishing the app-owned event. The
    // watcher callback runs through the same mutex and will consume this
    // marker to suppress its echo.
    this.pendingWrites.set(relative, contentHash);
    if (this.pendingWrites.size > MAX_PENDING_WRITES) this.pendingWrites.delete(this.pendingWrites.keys().next().value!);
    return { path: relative, mtime: new Date(stats.mtimeMs).toISOString(), content_hash: contentHash, index };
  }

  private nextNotePath(slug: string): string {
    let candidate = `notes/${slug}.md`;
    let suffix = 2;
    while (existsSync(resolve(this.vaultRoot, candidate))) candidate = `notes/${slug}-${suffix++}.md`;
    return candidate;
  }

  search(query: string, limit?: number): { hits: Array<{ note_id: string; title: string; path: string; snippet: string }>; truncated: boolean } {
    const normalized = query.trim();
    if (!normalized) throw new ServiceError("INVALID_INPUT", "Search query cannot be empty.");
    const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) throw new ServiceError("INVALID_INPUT", "Search query cannot be empty.");
    return this.indexer.store.searchNotes(normalized, clamp(limit, 10, MAX_SEARCH_LIMIT));
  }

  listNotes(prefix?: string, tag?: string, limit?: number, cursor?: string): { notes: NoteRecord[]; truncated: boolean; next_cursor?: string } {
    const limitValue = clamp(limit, 20, MAX_LIST_LIMIT);
    const result = this.indexer.store.indexedNotes({ prefix, tag, limit: limitValue, cursor: decodeNoteCursor(cursor) });
    return { notes: result.notes.map((row) => this.noteRow(row.id)), truncated: result.truncated, ...(result.nextCursor ? { next_cursor: encodeNoteCursor(result.nextCursor) } : {}) };
  }

  suggestNoteLinks(query = "", limit?: number): { matches: NoteLinkSuggestion[]; truncated: boolean } {
    const limitValue = clamp(limit, 20, MAX_LIST_LIMIT);
    const result = this.indexer.store.noteSuggestions(query, limitValue);
    return {
      matches: result.notes.map((note) => ({ id: note.id, path: note.path, title: note.title, aliases: note.aliases })),
      truncated: result.truncated,
    };
  }

  queryTable(selector: NoteSelector, sectionId?: string, contains?: Record<string, string>, limit?: number): { note: NoteRecord; headers: string[]; rows: string[][]; section_id?: string; truncated: boolean } {
    const note = this.noteRow(selector);
    const parsed = parseMarkdown(readFileSync(resolve(this.vaultRoot, note.path), "utf8"));
    const table = parsed.tables.find((candidate) => !sectionId || candidate.sectionId === sectionId);
    if (!table) throw new ServiceError("NOT_FOUND", "Table was not found.");
    const limitValue = clamp(limit, 50, MAX_LIST_LIMIT);
    const rows = table.rows.filter((row) => !contains || Object.entries(contains).every(([column, value]) => {
      const index = table.headers.indexOf(column);
      return index >= 0 && (row[index] ?? "").toLocaleLowerCase().includes(value.toLocaleLowerCase());
    }));
    return { note, headers: table.headers, rows: rows.slice(0, limitValue), section_id: table.sectionId, truncated: rows.length > limitValue };
  }

  projectMap(selector = "project:root", depth?: number, limit?: number): GraphQueryResult {
    const graph = this.queryGraphInternal(selector, "neighbors", Math.max(1, Math.min(depth ?? 1, 3)), clamp(limit, 20, MAX_GRAPH_LIMIT));
    return boundGraphPayload(graph);
  }

  graphQuery(selector: string, direction: GraphDirection, depth?: number, limit?: number): GraphQueryResult {
    const graph = this.queryGraphInternal(selector, direction, Math.max(1, Math.min(depth ?? 1, 4)), clamp(limit, 20, MAX_GRAPH_LIMIT));
    return boundGraphPayload(graph);
  }

  getContext(selector: string, taskHint?: string, limit?: number): Record<string, unknown> {
    const graph = this.queryGraphInternal(selector, "neighbors", 2, clamp(limit, 20, MAX_GRAPH_LIMIT));
    const files = graph.nodes.filter((node) => ["file", "module", "test", "configuration"].includes(node.kind)).slice(0, 20);
    const attachedNotes = graph.nodes.filter((node) => node.kind === "note").slice(0, 20);
    const relatedNodes = graph.nodes.filter((node) => ["project", "repository", "directory", "package"].includes(node.kind)).slice(0, 20);
    // Only the anchor's own edges are "relationships" for context purposes —
    // the 2-hop neighborhood also carries edges between unrelated neighbors
    // (e.g. another note's own backlinks), which is noise here and, being
    // unbounded, would otherwise dominate trimPayload's byte budget and
    // starve out the (small, capped) node-lookup buckets above. Also collapse
    // repeated mentions of the same link between the same two nodes (e.g. a
    // note wikilinking the anchor from several sections) to one relationship
    // per connected node, matching "relationship labels, not anonymous
    // backlinks" — the count of mentions isn't a distinct relationship.
    const seenRelationships = new Set<string>();
    const relationships = graph.edges.filter((edge) => {
      if (edge.fromId !== graph.anchor.nodeId && edge.toId !== graph.anchor.nodeId) return false;
      const key = `${edge.fromId}|${edge.toId}|${edge.kind}`;
      if (seenRelationships.has(key)) return false;
      seenRelationships.add(key);
      return true;
    });
    const search = taskHint ? this.search(taskHint, 10).hits : [];
    const payload = { anchor: graph.anchor, purpose: graph.anchor.metadata, likely_files: files, attached_notes: attachedNotes, related_nodes: relatedNodes, relationships, task_matches: search };
    const bounded = boundContextPayload(payload);
    return {
      ...bounded,
      truncated: bounded.truncated === true || graph.truncated,
      ...(graph.omitted_nodes ? { omitted_nodes: graph.omitted_nodes } : {}),
      ...(graph.omitted_edges ? { omitted_edges: graph.omitted_edges } : {}),
    };
  }

  history(selector: NoteSelector, limit?: number): HistoryResult {
    const note = this.noteRow(selector);
    return { path: note.path, commits: this.git.history(note.path, clamp(limit, 20, 100)) };
  }

  diff(selector: NoteSelector, revision?: string, limit?: number, cursor?: string): DiffResult {
    const note = this.noteRow(selector);
    const diff = this.git.diff(note.path, revision);
    const page = pageText(diff, hashContent(diff), limit, cursor);
    return { path: note.path, diff: page.value, ...(page.truncated ? { truncated: true, next_cursor: page.next_cursor } : {}) };
  }

  async restore(selector: NoteSelector, revision: string): Promise<{ path: string; revision: string; mtime: string; content_hash: string; index: IndexReport }> {
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      try {
        this.git.restore(note.path, revision);
      } catch (error) {
        if (error instanceof Error && error.message.includes("dirty")) throw new ServiceError("GIT_DIRTY", error.message);
        throw error;
      }
      const restoredAbsolute = resolve(this.vaultRoot, note.path);
      const contentHash = existsSync(restoredAbsolute) ? hashContent(readFileSync(restoredAbsolute)) : undefined;
      let index: IndexReport;
      try {
        index = this.indexer.incrementalRebuild([restoredAbsolute]);
      } catch (error) {
        throw indexSyncFailure(note.path, contentHash, error);
      }
      if (!existsSync(restoredAbsolute)) throw new ServiceError("NOT_FOUND", `Restored note '${note.path}' does not exist in revision '${revision}'.`, {
        note_path: note.path,
        revision,
        recovery: "Choose a revision that contains the note or restore it through a full-note create/update flow.",
      });
      const stats = statSync(restoredAbsolute);
      this.publishChanges([{ type: "update", path: restoredAbsolute, scopes: ["content", "catalog", "tree", "graph"] }]);
      return { path: note.path, revision, mtime: new Date(stats.mtimeMs).toISOString(), content_hash: contentHash ?? hashContent(readFileSync(restoredAbsolute)), index };
    });
  }

  vaultCheck(): VaultCheckResult {
    const scan = scanVault(this.vaultRoot);
    const diagnostics = [...scan.diagnostics];
    if (!vaultHasExpectedGitIgnore(this.vaultRoot)) diagnostics.push({ severity: "warning", code: "invalid-gitignore", message: "Vault .gitignore does not cover runtime data.", filePath: `${this.vaultRoot}/.gitignore` });
    return { vaultRoot: this.vaultRoot, diagnostics, index: this.indexer.store.counts(), gitStatus: this.git.status(), ok: !diagnosticsHaveErrors(diagnostics) };
  }

  health(): HealthResult {
    return {
      status: "ok",
      phase: 3,
      index: this.indexer.store.counts(),
      workspace: { active: Boolean(this.workspace), phase: this.workspacePhase, error: this.workspaceError },
      watchers: {
        vault: this.watcher?.mode ?? "starting",
        workspace: [...this.repoWatchers.values()].reduce((counts, watcher) => {
          counts[watcher.mode] += 1;
          return counts;
        }, { native: 0, polling: 0 }),
      },
    };
  }

  workspaceStatus(includeGitStatus = false): WorkspaceStatus {
    if (!this.workspace) return { active: false, phase: "disabled", repositories: [], diagnostics: [] };
    const rows = new Map(this.indexer.store.workspaceRepositories().map((row) => [row.repository_id, row]));
    const activeIds = new Set(this.workspace.repositories.map((repository) => repository.id));
    const gitStatuses = includeGitStatus
      ? new Map(this.workspace.repositories.map((repository) => [repository.id, this.repoGitAdapter(repository.id).status()]))
      : undefined;
    const gitStatus = includeGitStatus
      ? this.workspace.repositories.flatMap((repository) => (gitStatuses?.get(repository.id) ?? []).map((entry) => ({ ...entry, repository: repository.id })))
      : undefined;
    const repositories = this.workspace.repositories.map((repository) => {
      const row = rows.get(repository.id);
      const status = this.workspacePhase === "warming" || this.workspacePhase === "rebuilding"
        ? this.workspacePhase
        : this.workspacePhase === "error" ? "error" : row?.status ?? "stale";
      return {
        id: repository.id,
        path: repository.path,
        status,
        lastIndexedAt: row?.last_indexed_at ?? undefined,
        gitChangedFileCount: includeGitStatus ? gitStatuses?.get(repository.id)?.length ?? 0 : undefined,
      };
    });
    for (const row of rows.values()) {
      if (!activeIds.has(row.repository_id)) repositories.push({ id: row.repository_id, path: row.path, status: row.status, lastIndexedAt: row.last_indexed_at ?? undefined, gitChangedFileCount: undefined });
    }
    const diagnostics = [
      ...this.workspace.diagnostics.map((diagnostic) => ({ severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message, filePath: diagnostic.path })),
      ...this.indexer.store.workspaceDiagnostics(),
      ...this.workspaceAttachmentDiagnostics,
    ];
    return { active: true, phase: this.workspacePhase, error: this.workspaceError, workspaceRoot: this.workspace.workspaceRoot, workspaceExists: this.workspace.workspaceExists, repositories, diagnostics, ...(gitStatus ? { gitStatus } : {}) };
  }

  getRepoHistory(repositoryId: string, path: string, limit?: number): RepositoryHistoryResult {
    const { repository, relative } = this.repositoryPath(repositoryId, path);
    return { repository: repository.id, path: relative, commits: this.repoGitAdapter(repository.id).history(relative, clamp(limit, 20, 100)) };
  }

  getRepoDiff(repositoryId: string, path: string, revision?: string, limit?: number, cursor?: string): RepositoryDiffResult {
    const { repository, relative } = this.repositoryPath(repositoryId, path);
    const diff = this.repoGitAdapter(repository.id).diff(relative, revision);
    const page = pageText(diff, hashContent(diff), limit, cursor);
    return { repository: repository.id, path: relative, diff: page.value, ...(page.truncated ? { truncated: true, next_cursor: page.next_cursor } : {}) };
  }

  async restoreRepoPath(repositoryId: string, path: string, revision: string, confirm: boolean): Promise<RepositoryRestoreResult> {
    if (!confirm) throw new ServiceError("INVALID_INPUT", "Restoring a repository path requires explicit confirm: true.");
    return this.writes.run(async () => {
      const { repository, relative } = this.repositoryPath(repositoryId, path);
      const git = this.repoGitAdapter(repository.id);
      try {
        git.restore(relative, revision);
      } catch (error) {
        if (error instanceof Error && error.message.includes("dirty")) throw new ServiceError("GIT_DIRTY", error.message);
        throw error;
      }
      const restoredAbsolute = resolve(repository.absolutePath, relative);
      const contentHash = existsSync(restoredAbsolute) && statSync(restoredAbsolute).isFile() ? hashContent(readFileSync(restoredAbsolute)) : undefined;
      this.workspacePhase = "rebuilding";
      let index: ReturnType<WorkspaceIndexer["incrementalRebuild"]>;
      try {
        if (!this.workspaceIndexer) throw new Error("Workspace indexer is unavailable.");
        index = this.workspaceIndexer.incrementalRebuild(repository.id);
        this.refreshWorkspaceAttachments();
        this.workspacePhase = "current";
        this.workspaceError = undefined;
      } catch (error) {
        this.workspacePhase = "error";
        this.workspaceError = error instanceof Error ? error.message : String(error);
        throw indexSyncFailure(`${repository.id}:${relative}`, contentHash, error);
      }
      if (!existsSync(restoredAbsolute)) throw new ServiceError("NOT_FOUND", `Restored path '${relative}' does not exist in revision '${revision}'.`, {
        repository: repository.id,
        path: relative,
        revision,
        recovery: "Choose a revision that contains the requested path.",
      });
      const stats = statSync(restoredAbsolute);
      this.publishChanges([{ type: "update", path: restoredAbsolute }], repository.id);
      return {
        repository: repository.id,
        path: relative,
        revision,
        mtime: new Date(stats.mtimeMs).toISOString(),
        index,
        ...(stats.isFile() ? { content_hash: hashContent(readFileSync(restoredAbsolute)) } : {}),
      };
    });
  }
}
