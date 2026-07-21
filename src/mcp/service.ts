import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { addMissingSectionMarkers, parseMarkdown } from "../core/markdown.js";
import { createFrontmatter, serializeFrontmatter } from "../core/frontmatter.js";
import { repositoryRelativePath, projectNodeId, noteNodeId } from "../core/identity.js";
import { VaultIndexer } from "../core/indexer.js";
import { scanVault, vaultHasExpectedGitIgnore } from "../core/vault.js";
import { GitAdapter, type GitCommit, type GitStatusEntry } from "../core/git.js";
import { RUNTIME_DIRECTORY } from "../core/vault.js";
import type { Diagnostic, NoteFrontmatter, NoteType, Section } from "../core/types.js";
import type { IndexReport } from "../core/index-types.js";
import { startWatcher, type WatcherHandle } from "../core/watcher.js";

const MAX_SEARCH_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_GRAPH_LIMIT = 100;
const MAX_CONTEXT_BYTES = 6_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const SECTION_MARKER_RE = /^\s*<!--\s*cortex:section\s+id="(sec-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\s*-->\s*$/i;

export type NoteSelector = string;

export type NoteRecord = {
  id: string;
  path: string;
  title: string;
  type: NoteType;
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  content_hash: string;
};

export type GraphNodeRecord = {
  nodeId: string;
  kind: string;
  path?: string;
  name: string;
  metadata: Record<string, unknown>;
};

export type GraphEdgeRecord = {
  fromId: string;
  toId: string;
  kind: string;
  metadata: Record<string, unknown>;
};

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "AMBIGUOUS_SECTION"
  | "GIT_DIRTY"
  | "INDEX_SYNC_FAILED"
  | "VAULT_INVALID";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ServiceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.details = details;
  }
}

type GraphDirection = "in" | "out" | "neighbors";

type NoteDbRow = {
  id: string;
  path: string;
  title: string;
  type: NoteType;
  created_at: string;
  updated_at: string;
};

type GraphQueryResult = {
  anchor: GraphNodeRecord;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  truncated: boolean;
};

type WriteResult = {
  path: string;
  mtime: string;
  content_hash: string;
  index: IndexReport;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function jsonMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sectionBounds(text: string, section: Section): { lines: string[]; start: number; end: number; marker: number } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = section.startLine - 1;
  const end = Math.min(section.endLine, lines.length);
  const marker = lines.slice(start + 1, end).findIndex((line) => SECTION_MARKER_RE.test(line));
  if (marker < 0) throw new ServiceError("CONFLICT", `Section '${section.id ?? section.heading}' has no writable section marker.`);
  return { lines, start, end, marker: start + 1 + marker };
}

function sectionBody(text: string, section: Section): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = section.startLine - 1;
  const end = Math.min(section.endLine, lines.length);
  const markerOffset = lines.slice(start + 1, end).findIndex((line) => SECTION_MARKER_RE.test(line));
  const contentStart = markerOffset < 0 ? start + 1 : start + 1 + markerOffset + 1;
  return lines.slice(contentStart, end).join("\n").replace(/^\n+|\n+$/g, "");
}

function replaceSectionBody(text: string, section: Section, body: string): string {
  const bounds = sectionBounds(text, section);
  const next = body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const replacement = next.length === 0 ? [] : next.split("\n");
  const lines = [...bounds.lines.slice(0, bounds.marker + 1), ...replacement, ...bounds.lines.slice(bounds.end)];
  return lines.join("\n");
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

class AsyncMutex {
  private tail = Promise.resolve();

  run<T>(callback: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class McpVaultService {
  readonly vaultRoot: string;
  readonly indexer: VaultIndexer;
  readonly git: GitAdapter;
  private watcher?: WatcherHandle;
  private readonly writes = new AsyncMutex();

  private constructor(vaultRoot: string, indexer: VaultIndexer, git: GitAdapter) {
    this.vaultRoot = vaultRoot;
    this.indexer = indexer;
    this.git = git;
  }

  static async start(vaultRoot: string): Promise<McpVaultService> {
    const indexer = new VaultIndexer(vaultRoot);
    try {
      indexer.fullRebuild();
      const service = new McpVaultService(indexer.vaultRoot, indexer, new GitAdapter(indexer.vaultRoot));
      service.watcher = await startWatcher(service.vaultRoot, async (events) => {
        await service.writes.run(() => {
          service.indexer.incrementalRebuild(events.map((event) => event.path));
        });
      });
      return service;
    } catch (error) {
      indexer.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.watcher?.stop();
    await this.watcher?.flushSnapshot();
    this.indexer.close();
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
    const row = UUID_RE.test(selector)
      ? this.indexer.store.db.query<NoteDbRow, [string]>("SELECT note_id as id, path, title, type, created_at, updated_at FROM notes WHERE note_id = ?1").get(selector)
      : this.indexer.store.db.query<NoteDbRow, [string]>("SELECT note_id as id, path, title, type, created_at, updated_at FROM notes WHERE path = ?1").get(this.relativePath(selector).relative);
    if (!row) throw new ServiceError("NOT_FOUND", `Note '${selector}' was not found.`);
    const aliases = this.indexer.store.db.query<{ alias: string }, [string]>("SELECT alias FROM note_aliases WHERE note_id = ?1 ORDER BY alias").all(row.id).map((item) => item.alias);
    const tags = this.indexer.store.db.query<{ tag: string }, [string]>("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag").all(row.id).map((item) => item.tag);
    const absolute = resolve(this.vaultRoot, row.path);
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      type: row.type,
      created_at: row.created_at,
      updated_at: row.updated_at,
      aliases,
      tags,
      content_hash: hashContent(readFileSync(absolute, "utf8")),
    };
  }

  private resolveGraphNode(selector: string): GraphNodeRecord {
    let nodeId = selector;
    if (UUID_RE.test(selector)) nodeId = noteNodeId(selector);
    if (!selector.includes(":")) {
      const relative = this.relativePath(selector).relative;
      nodeId = relative === "." ? projectNodeId() : this.indexer.store.db.query<{ node_id: string }, [string]>("SELECT node_id FROM graph_nodes WHERE path = ?1").get(relative)?.node_id ?? "";
    }
    if (!nodeId) throw new ServiceError("NOT_FOUND", `Graph node '${selector}' was not found.`);
    const row = this.indexer.store.db.query<{ node_id: string; kind: string; path: string | null; name: string; metadata_json: string }, [string]>("SELECT node_id, kind, path, name, metadata_json FROM graph_nodes WHERE node_id = ?1").get(nodeId);
    if (!row) throw new ServiceError("NOT_FOUND", `Graph node '${selector}' was not found.`);
    return { nodeId: row.node_id, kind: row.kind, path: row.path ?? undefined, name: row.name, metadata: jsonMetadata(row.metadata_json) };
  }

  private queryGraphInternal(selector: string, direction: GraphDirection, depth: number, limit: number): GraphQueryResult {
    const anchor = this.resolveGraphNode(selector);
    const visited = new Set([anchor.nodeId]);
    const frontier = [anchor.nodeId];
    const edges = new Map<string, GraphEdgeRecord>();
    for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const outgoing = direction === "in" ? [] : this.indexer.store.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM graph_edges WHERE from_id = ?1").all(nodeId);
        const incoming = direction === "out" ? [] : this.indexer.store.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM graph_edges WHERE to_id = ?1").all(nodeId);
        for (const row of [...outgoing, ...incoming]) {
          const edge = { fromId: row.from_id, toId: row.to_id, kind: row.kind, metadata: jsonMetadata(row.metadata_json) };
          edges.set(`${edge.fromId}|${edge.toId}|${edge.kind}|${row.metadata_json}`, edge);
          const neighbor = direction === "in" ? edge.fromId : edge.toId;
          if (direction === "neighbors") {
            const other = edge.fromId === nodeId ? edge.toId : edge.fromId;
            if (!visited.has(other)) {
              visited.add(other);
              next.push(other);
            }
          } else if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
          if (visited.size >= limit + 1) break;
        }
        if (visited.size >= limit + 1) break;
      }
      frontier.splice(0, frontier.length, ...next);
      if (visited.size >= limit + 1) break;
    }
    const ids = [...visited].slice(0, limit + 1);
    const nodes = ids.map((id) => this.resolveGraphNode(id));
    const allowed = new Set(ids);
    return { anchor, nodes: nodes.slice(1), edges: [...edges.values()].filter((edge) => allowed.has(edge.fromId) && allowed.has(edge.toId)), truncated: visited.size > limit + 1 };
  }

  getNote(selector: NoteSelector): { note: NoteRecord; sections: Section[] } {
    const note = this.noteRow(selector);
    const absolute = resolve(this.vaultRoot, note.path);
    const content = readFileSync(absolute, "utf8");
    const parsed = parseMarkdown(content, absolute);
    return { note, sections: parsed.sections };
  }

  getSection(selector: NoteSelector, sectionId?: string, heading?: string): { note: NoteRecord; section: Section; body: string } {
    const note = this.noteRow(selector);
    const content = readFileSync(resolve(this.vaultRoot, note.path), "utf8");
    const parsed = parseMarkdown(content);
    let matches = sectionId ? parsed.sections.filter((section) => section.id === sectionId) : parsed.sections.filter((section) => section.heading.toLocaleLowerCase() === heading?.toLocaleLowerCase());
    if (matches.length === 0) throw new ServiceError("NOT_FOUND", "Section was not found.");
    if (matches.length > 1) throw new ServiceError("AMBIGUOUS_SECTION", `Section heading '${heading}' is ambiguous.`);
    const section = matches[0];
    return { note, section, body: sectionBody(content, section) };
  }

  async patchSection(selector: NoteSelector, sectionId: string, expectedRevision: string, newContent: string): Promise<WriteResult> {
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      const absolute = resolve(this.vaultRoot, note.path);
      const original = readFileSync(absolute, "utf8");
      const parsed = parseMarkdown(original, absolute);
      const matches = parsed.sections.filter((section) => section.id === sectionId);
      if (matches.length === 0) throw new ServiceError("NOT_FOUND", `Section '${sectionId}' was not found.`);
      if (matches.length > 1 || diagnosticsHaveErrors(parsed.diagnostics)) throw new ServiceError("CONFLICT", "The note has invalid or duplicate section metadata.");
      const section = matches[0];
      if (section.revision !== expectedRevision) throw new ServiceError("CONFLICT", "Section revision is stale.", { expected_revision: expectedRevision, actual_revision: section.revision });
      const body = replaceSectionBody(original, section, newContent);
      const updated = { ...parsed.frontmatter!, updated_at: new Date().toISOString() };
      const content = serializeFrontmatter(updated) + parseMarkdown(body).body;
      return this.writeAndIndexLocked(note.path, content);
    });
  }

  async replaceNote(selector: NoteSelector, expectedHash: string, markdown: string): Promise<WriteResult> {
    if (!HASH_RE.test(expectedHash)) throw new ServiceError("INVALID_INPUT", "expected_file_hash must be a SHA-256 hash.");
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      const absolute = resolve(this.vaultRoot, note.path);
      const current = readFileSync(absolute, "utf8");
      const actualHash = hashContent(current);
      if (actualHash !== expectedHash) throw new ServiceError("CONFLICT", "Note file hash is stale.", { expected_file_hash: expectedHash, actual_file_hash: actualHash });
      const parsed = parseMarkdown(markdown, absolute);
      if (diagnosticsHaveErrors(parsed.diagnostics) || !parsed.frontmatter) throw new ServiceError("INVALID_INPUT", "Replacement Markdown has invalid frontmatter or section metadata.", { diagnostics: parsed.diagnostics });
      if (parsed.frontmatter.id !== note.id || parsed.frontmatter.created_at !== note.created_at) throw new ServiceError("CONFLICT", "id and created_at are immutable.");
      const content = serializeFrontmatter({ ...parsed.frontmatter, updated_at: new Date().toISOString() }) + parsed.body;
      return this.writeAndIndexLocked(note.path, content);
    });
  }

  async createNote(input: { title: string; type?: NoteType; aliases?: string[]; tags?: string[]; applies_to?: NoteFrontmatter["applies_to"]; body?: string; path?: string }): Promise<WriteResult & { id: string }> {
    return this.writes.run(() => {
      const frontmatter = createFrontmatter({ title: input.title, type: input.type, aliases: input.aliases, tags: input.tags, applies_to: input.applies_to });
      const body = addMissingSectionMarkers(input.body ?? "").body;
      const content = serializeFrontmatter(frontmatter) + body;
      const relative = input.path ? this.relativePath(input.path, true).relative : this.nextNotePath(slugify(frontmatter.title));
      if (extname(relative).toLocaleLowerCase() !== ".md") throw new ServiceError("INVALID_INPUT", "Notes must use a .md path.");
      if (existsSync(resolve(this.vaultRoot, relative))) throw new ServiceError("CONFLICT", `Note path '${relative}' already exists.`);
      const result = this.writeAndIndexLocked(relative, content);
      return { ...result, id: frontmatter.id };
    });
  }

  private writeAndIndexLocked(relative: string, content: string): WriteResult {
    const { absolute } = this.relativePath(relative, true);
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.cortex-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, "utf8");
      renameSync(temporary, absolute);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    let index: IndexReport;
    try {
      index = this.indexer.incrementalRebuild([absolute]);
    } catch (error) {
      throw new ServiceError("INDEX_SYNC_FAILED", `File '${relative}' was written but indexing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stats = statSync(absolute);
    return { path: relative, mtime: new Date(stats.mtimeMs).toISOString(), content_hash: hashContent(content), index };
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
    const terms = normalized.split(/\s+/).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const rows = this.indexer.store.db.query<{ note_id: string; title: string; path: string; snippet: string }, [string, number]>("SELECT notes_fts.note_id, notes_fts.title, notes.path, snippet(notes_fts, 2, '', '', '...', 24) as snippet FROM notes_fts JOIN notes ON notes.note_id = notes_fts.note_id WHERE notes_fts MATCH ?1 LIMIT ?2").all(terms, clamp(limit, 20, MAX_SEARCH_LIMIT));
    return { hits: rows, truncated: rows.length >= clamp(limit, 20, MAX_SEARCH_LIMIT) };
  }

  listNotes(prefix?: string, tag?: string, limit?: number): { notes: NoteRecord[]; truncated: boolean } {
    const rows = this.indexer.store.db.query<{ note_id: string; path: string; title: string; type: NoteType; created_at: string; updated_at: string }, []>("SELECT note_id, path, title, type, created_at, updated_at FROM notes ORDER BY title").all();
    const filtered = rows.filter((row) => (!prefix || row.path.startsWith(prefix) || row.title.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) && (!tag || this.indexer.store.db.query<{ count: number }, [string, string]>("SELECT COUNT(*) as count FROM note_tags WHERE note_id = ?1 AND tag = ?2").get(row.note_id, tag)?.count === 1));
    const limitValue = clamp(limit, 20, MAX_LIST_LIMIT);
    return { notes: filtered.slice(0, limitValue).map((row) => this.noteRow(row.note_id)), truncated: filtered.length > limitValue };
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
    return this.queryGraphInternal(selector, "neighbors", Math.max(1, Math.min(depth ?? 1, 3)), clamp(limit, 50, MAX_GRAPH_LIMIT));
  }

  graphQuery(selector: string, direction: GraphDirection, depth?: number, limit?: number): GraphQueryResult {
    return this.queryGraphInternal(selector, direction, Math.max(1, Math.min(depth ?? 1, 4)), clamp(limit, 50, MAX_GRAPH_LIMIT));
  }

  getContext(selector: string, taskHint?: string, limit?: number): Record<string, unknown> {
    const graph = this.queryGraphInternal(selector, "neighbors", 2, clamp(limit, 20, MAX_GRAPH_LIMIT));
    const files = graph.nodes.filter((node) => ["file", "module", "test", "configuration"].includes(node.kind)).slice(0, 20);
    const attachedNotes = graph.nodes.filter((node) => node.kind === "note").slice(0, 20);
    const search = taskHint ? this.search(taskHint, 10).hits : [];
    const payload = { anchor: graph.anchor, purpose: graph.anchor.metadata, likely_files: files, attached_notes: attachedNotes, relationships: graph.edges, task_matches: search };
    const trimmed = trimPayload(payload);
    return { ...trimmed.value, truncated: trimmed.truncated || graph.truncated };
  }

  history(selector: NoteSelector, limit?: number): { path: string; commits: GitCommit[] } {
    const note = this.noteRow(selector);
    return { path: note.path, commits: this.git.history(note.path, clamp(limit, 20, 100)) };
  }

  diff(selector: NoteSelector, revision?: string): { path: string; diff: string } {
    const note = this.noteRow(selector);
    return { path: note.path, diff: this.git.diff(note.path, revision) };
  }

  async restore(selector: NoteSelector, revision: string): Promise<{ path: string; revision: string; mtime: string; index: IndexReport }> {
    return this.writes.run(() => {
      const note = this.noteRow(selector);
      try {
        this.git.restore(note.path, revision);
      } catch (error) {
        if (error instanceof Error && error.message.includes("dirty")) throw new ServiceError("GIT_DIRTY", error.message);
        throw error;
      }
      const index = this.indexer.incrementalRebuild([resolve(this.vaultRoot, note.path)]);
      const stats = statSync(resolve(this.vaultRoot, note.path));
      return { path: note.path, revision, mtime: new Date(stats.mtimeMs).toISOString(), index };
    });
  }

  vaultCheck(): { vaultRoot: string; diagnostics: Diagnostic[]; index: ReturnType<VaultIndexer["store"]["counts"]>; gitStatus: GitStatusEntry[]; ok: boolean } {
    const scan = scanVault(this.vaultRoot);
    const diagnostics = [...scan.diagnostics];
    if (!vaultHasExpectedGitIgnore(this.vaultRoot)) diagnostics.push({ severity: "warning", code: "invalid-gitignore", message: "Vault .gitignore does not cover runtime data.", filePath: `${this.vaultRoot}/.gitignore` });
    return { vaultRoot: this.vaultRoot, diagnostics, index: this.indexer.store.counts(), gitStatus: this.git.status(), ok: !diagnosticsHaveErrors(diagnostics) };
  }
}
