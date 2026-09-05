import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Database, constants } from "bun:sqlite";
import type { Diagnostic, ParsedNote, NoteType } from "./types.js";
import type { FileKind, GraphBuild, IndexedMarkdown, IndexedNoteHeader, IndexedNoteRecord, IndexSearchResult } from "./index-types.js";

export const SCHEMA_VERSION = "1";
export const PROJECTION_VERSION = "1";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  status TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_aliases (
  note_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (note_id, alias)
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE TABLE IF NOT EXISTS sections (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  section_id TEXT,
  level INTEGER NOT NULL,
  heading TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_note_id TEXT NOT NULL,
  target_title TEXT NOT NULL,
  target_note_id TEXT,
  target_section TEXT,
  display TEXT,
  line INTEGER NOT NULL,
  column_number INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS table_rows (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  section_id TEXT,
  row_index INTEGER NOT NULL,
  headers_json TEXT NOT NULL,
  values_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER,
  column_number INTEGER
);
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (from_id, to_id, kind, metadata_json)
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tags
);
CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_updated_path ON notes(updated_at DESC, path ASC);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_note_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_sections_note ON sections(note_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_path ON diagnostics(path);
CREATE TABLE IF NOT EXISTS workspace_repositories (
  repository_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  last_indexed_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_files (
  repository_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  status TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, path)
);
CREATE TABLE IF NOT EXISTS workspace_graph_nodes (
  node_id TEXT PRIMARY KEY,
  repository_id TEXT,
  kind TEXT NOT NULL,
  path TEXT,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_graph_edges (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (from_id, to_id, kind, metadata_json)
);
CREATE TABLE IF NOT EXISTS workspace_diagnostics (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT,
  path TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER,
  column_number INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workspace_edges_from ON workspace_graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_workspace_edges_to ON workspace_graph_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_workspace_files_repo ON workspace_files(repository_id);
`;

export class IndexStore {
  /** Internal schema escape hatch for low-level projection/index tests only. */
  readonly db: Database;
  readonly vaultRoot: string;
  readonly dbPath: string;

  constructor(vaultRoot: string, dbPath: string) {
    this.vaultRoot = vaultRoot;
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(SCHEMA);
    this.db.query("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?1)").run(SCHEMA_VERSION);
  }

  close(): void {
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
      this.db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    } finally {
      this.db.close();
    }
  }

  transaction<T>(callback: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  setState(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?1, ?2)").run(key, value);
  }

  getState(key: string): string | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?1").get(key);
    return row?.value;
  }

  resetProjection(): void {
    for (const table of ["files", "notes", "note_aliases", "note_tags", "sections", "links", "table_rows", "diagnostics", "graph_nodes", "graph_edges"]) {
      this.db.run(`DELETE FROM ${table}`);
    }
    this.db.run("DELETE FROM notes_fts");
  }

  resetWorkspaceRepository(repositoryId: string): void {
    this.db.query("DELETE FROM workspace_files WHERE repository_id = ?1").run(repositoryId);
    this.db.query("DELETE FROM workspace_diagnostics WHERE repository_id = ?1").run(repositoryId);
    this.db.query("DELETE FROM workspace_graph_edges WHERE from_id LIKE ?1 OR to_id LIKE ?1").run(`%:${repositoryId}:%`);
    this.db.query("DELETE FROM workspace_graph_edges WHERE from_id = ?1 OR to_id = ?1").run(`repo:${repositoryId}`);
    this.db.query("DELETE FROM workspace_graph_nodes WHERE repository_id = ?1 OR node_id = ?2").run(repositoryId, `repo:${repositoryId}`);
  }

  replaceWorkspaceRepository(repositoryId: string, repositoryPath: string, files: Array<{ path: string; kind: string; hash: string; size: number; mtimeMs: number }>, graph: GraphBuild, diagnostics: Diagnostic[]): void {
    this.resetWorkspaceRepository(repositoryId);
    for (const file of files) {
      this.db.query("INSERT INTO workspace_files (repository_id, path, kind, content_hash, size, mtime_ms, status, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7)").run(repositoryId, file.path, file.kind, file.hash, file.size, file.mtimeMs, new Date().toISOString());
    }
    for (const node of graph.nodes) {
      this.db.query("INSERT OR REPLACE INTO workspace_graph_nodes (node_id, repository_id, kind, path, name, metadata_json, stale) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)").run(node.nodeId, repositoryId, node.kind, node.path ?? null, node.name, JSON.stringify(node.metadata ?? {}));
    }
    for (const edge of graph.edges) {
      this.db.query("INSERT OR IGNORE INTO workspace_graph_edges (from_id, to_id, kind, metadata_json) VALUES (?1, ?2, ?3, ?4)").run(edge.fromId, edge.toId, edge.kind, JSON.stringify(edge.metadata ?? {}));
    }
    for (const diagnostic of diagnostics) {
      this.db.query("INSERT INTO workspace_diagnostics (repository_id, path, severity, code, message, line, column_number) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(repositoryId, diagnostic.filePath ?? repositoryPath, diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.line ?? null, diagnostic.column ?? null);
    }
    this.db.query("INSERT OR REPLACE INTO workspace_repositories (repository_id, path, status, last_indexed_at) VALUES (?1, ?2, 'ready', ?3)").run(repositoryId, repositoryPath, new Date().toISOString());
  }

  markWorkspaceRepositoryMissing(repositoryId: string): void {
    this.db.query("UPDATE workspace_repositories SET status = 'stale' WHERE repository_id = ?1").run(repositoryId);
    this.db.query("UPDATE workspace_graph_nodes SET stale = 1 WHERE repository_id = ?1").run(repositoryId);
  }

  removeWorkspaceRepository(repositoryId: string): void {
    this.resetWorkspaceRepository(repositoryId);
    this.db.query("DELETE FROM workspace_repositories WHERE repository_id = ?1").run(repositoryId);
  }

  workspaceRepositories(): Array<{ repository_id: string; path: string; status: string; last_indexed_at: string | null }> {
    return this.db.query<{ repository_id: string; path: string; status: string; last_indexed_at: string | null }, []>("SELECT repository_id, path, status, last_indexed_at FROM workspace_repositories ORDER BY repository_id").all();
  }

  workspaceCounts(): { fileCount: number; graphNodeCount: number; graphEdgeCount: number } {
    const count = (table: string): number => (this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ${table}`).get()?.count ?? 0);
    return { fileCount: count("workspace_files"), graphNodeCount: count("workspace_graph_nodes"), graphEdgeCount: count("workspace_graph_edges") };
  }

  workspaceDiagnostics(): Diagnostic[] {
    return this.db.query<Diagnostic & { column_number: number | null }, []>("SELECT severity, code, message, path as filePath, line, column_number FROM workspace_diagnostics ORDER BY row_id").all().map((row) => ({ severity: row.severity, code: row.code, message: row.message, filePath: row.filePath, line: row.line ?? undefined, column: row.column_number ?? undefined }));
  }

  private indexedNote(noteId: string): IndexedNoteRecord | undefined {
    const row = this.db.query<{
      id: string;
      path: string;
      title: string;
      type: NoteType;
      created_at: string;
      updated_at: string;
      content_hash: string | null;
    }, [string]>(
      "SELECT notes.note_id as id, notes.path, notes.title, notes.type, notes.created_at, notes.updated_at, files.content_hash FROM notes LEFT JOIN files ON files.path = notes.path WHERE notes.note_id = ?1",
    ).get(noteId);
    if (!row) return undefined;
    const aliases = this.db.query<{ alias: string }, [string]>("SELECT alias FROM note_aliases WHERE note_id = ?1 ORDER BY alias").all(noteId).map((item) => item.alias);
    const tags = this.db.query<{ tag: string }, [string]>("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag").all(noteId).map((item) => item.tag);
    return { ...row, content_hash: row.content_hash ?? "", aliases, tags };
  }

  noteById(noteId: string): IndexedNoteRecord | undefined {
    return this.indexedNote(noteId);
  }

  noteByPath(path: string): IndexedNoteRecord | undefined {
    const row = this.db.query<{ note_id: string }, [string]>("SELECT note_id FROM notes WHERE path = ?1").get(path);
    return row ? this.indexedNote(row.note_id) : undefined;
  }

  noteHeaders(): IndexedNoteHeader[] {
    return this.db.query<IndexedNoteHeader, []>("SELECT note_id, path, title, type, updated_at FROM notes ORDER BY path").all();
  }

  indexedNotes(options: { prefix?: string; tag?: string; limit: number; cursor?: { updatedAt: string; path: string } }): { notes: IndexedNoteRecord[]; truncated: boolean; nextCursor?: { updatedAt: string; path: string } } {
    const rows = this.db.query<{ note_id: string; updated_at: string; path: string }, [string | null, string | null, string | null, string | null, string | null, string | null, number]>(
      "SELECT notes.note_id, notes.updated_at, notes.path FROM notes WHERE (?1 IS NULL OR notes.path LIKE ?2 OR lower(notes.title) LIKE lower(?3)) AND (?4 IS NULL OR EXISTS (SELECT 1 FROM note_tags WHERE note_tags.note_id = notes.note_id AND note_tags.tag = ?4)) AND (?5 IS NULL OR notes.updated_at < ?5 OR (notes.updated_at = ?5 AND notes.path > ?6)) ORDER BY notes.updated_at DESC, notes.path ASC LIMIT ?7",
    ).all(
      options.prefix ?? null,
      options.prefix ? `${options.prefix}%` : null,
      options.prefix ? `${options.prefix}%` : null,
      options.tag ?? null,
      options.cursor?.updatedAt ?? null,
      options.cursor?.path ?? null,
      options.limit + 1,
    );
    const truncated = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return { notes: page.map((row) => this.indexedNote(row.note_id)).filter((row): row is IndexedNoteRecord => Boolean(row)), truncated, nextCursor: truncated && last ? { updatedAt: last.updated_at, path: last.path } : undefined };
  }

  searchNotes(query: string, limit: number): IndexSearchResult {
    const words = query.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const terms = words.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    if (!terms) return { hits: [], truncated: false };
    const rows = this.db.query<{ note_id: string; title: string; path: string; snippet: string }, [string, number]>(
      "SELECT notes_fts.note_id, notes_fts.title, notes.path, snippet(notes_fts, 2, '', '', '...', 24) as snippet FROM notes_fts JOIN notes ON notes.note_id = notes_fts.note_id WHERE notes_fts MATCH ?1 LIMIT ?2",
    ).all(terms, limit);
    return { hits: rows, truncated: rows.length >= limit };
  }

  graphNodeIdByPath(path: string): string | undefined {
    return this.db.query<{ node_id: string }, [string]>("SELECT node_id FROM graph_nodes WHERE path = ?1").get(path)?.node_id;
  }

  fileHash(path: string): string | undefined {
    return this.db.query<{ content_hash: string }, [string]>("SELECT content_hash FROM files WHERE path = ?1").get(path)?.content_hash;
  }

  fileSnapshots(): Array<{ path: string; size: number; mtimeMs: number }> {
    return this.db.query<{ path: string; size: number; mtimeMs: number }, []>("SELECT path, size, mtime_ms as mtimeMs FROM files ORDER BY path").all();
  }

  graphPaths(): Array<{ path: string; kind: string; name: string }> {
    return this.db.query<{ path: string; kind: string; name: string }, []>("SELECT path, kind, name FROM graph_nodes WHERE path IS NOT NULL ORDER BY kind, path").all();
  }

  linkRepositoriesToProject(repositoryIds: string[]): void {
    this.db.query("DELETE FROM workspace_graph_edges WHERE from_id = 'project:root' AND to_id LIKE 'repo:%'").run();
    for (const repositoryId of repositoryIds) {
      this.db.query("INSERT OR IGNORE INTO workspace_graph_edges (from_id, to_id, kind, metadata_json) VALUES ('project:root', ?1, 'contains', '{}')").run(`repo:${repositoryId}`);
    }
  }

  replaceWorkspaceAttachmentEdges(edges: Array<{ fromId: string; toId: string; kind: string; metadata?: Record<string, unknown> }>): void {
    this.db.run("DELETE FROM workspace_graph_edges WHERE from_id LIKE 'note:%'");
    for (const edge of edges) {
      this.db.query("INSERT OR IGNORE INTO workspace_graph_edges (from_id, to_id, kind, metadata_json) VALUES (?1, ?2, ?3, ?4)").run(edge.fromId, edge.toId, edge.kind, JSON.stringify(edge.metadata ?? {}));
    }
  }

  unifiedNode(nodeId: string): { node_id: string; kind: string; path: string | null; name: string; metadata_json: string } | undefined {
    return this.db.query<{ node_id: string; kind: string; path: string | null; name: string; metadata_json: string }, [string]>("SELECT node_id, kind, path, name, metadata_json FROM graph_nodes WHERE node_id = ?1").get(nodeId)
      ?? this.db.query<{ node_id: string; kind: string; path: string | null; name: string; metadata_json: string }, [string]>("SELECT node_id, kind, path, name, metadata_json FROM workspace_graph_nodes WHERE node_id = ?1").get(nodeId)
      ?? undefined;
  }

  unifiedEdgesFrom(nodeId: string): Array<{ from_id: string; to_id: string; kind: string; metadata_json: string }> {
    return [
      ...this.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM graph_edges WHERE from_id = ?1").all(nodeId),
      ...this.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM workspace_graph_edges WHERE from_id = ?1").all(nodeId),
    ];
  }

  unifiedEdgesTo(nodeId: string): Array<{ from_id: string; to_id: string; kind: string; metadata_json: string }> {
    return [
      ...this.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM graph_edges WHERE to_id = ?1").all(nodeId),
      ...this.db.query<{ from_id: string; to_id: string; kind: string; metadata_json: string }, [string]>("SELECT from_id, to_id, kind, metadata_json FROM workspace_graph_edges WHERE to_id = ?1").all(nodeId),
    ];
  }

  removePath(path: string): void {
    const noteRows = this.db.query<{ note_id: string }, [string]>("SELECT note_id FROM notes WHERE path = ?1").all(path);
    for (const row of noteRows) {
      this.db.query("DELETE FROM note_aliases WHERE note_id = ?1").run(row.note_id);
      this.db.query("DELETE FROM note_tags WHERE note_id = ?1").run(row.note_id);
      this.db.query("DELETE FROM sections WHERE note_id = ?1").run(row.note_id);
      this.db.query("DELETE FROM links WHERE source_note_id = ?1").run(row.note_id);
      this.db.query("DELETE FROM table_rows WHERE note_id = ?1").run(row.note_id);
      this.db.query("DELETE FROM graph_edges WHERE from_id = ?1 OR to_id = ?1").run(`note:${row.note_id}`);
      this.db.query("DELETE FROM graph_nodes WHERE node_id = ?1").run(`note:${row.note_id}`);
      this.db.query("DELETE FROM notes_fts WHERE note_id = ?1").run(row.note_id);
    }
    this.db.query("DELETE FROM notes WHERE path = ?1").run(path);
    this.db.query("DELETE FROM files WHERE path = ?1").run(path);
    this.db.query("DELETE FROM diagnostics WHERE path = ?1").run(path);
  }

  replaceMarkdown(note: IndexedMarkdown): void {
    this.removePath(note.path);
    this.db.query("INSERT INTO files (path, kind, content_hash, size, mtime_ms, status, indexed_at) VALUES (?1, 'markdown', ?2, ?3, ?4, ?5, ?6)").run(
      note.path,
      note.hash,
      Buffer.byteLength(note.content),
      note.mtimeMs,
      note.parsed.frontmatter ? "ok" : "error",
      new Date().toISOString(),
    );
    this.insertDiagnostics(note.path, note.parsed.diagnostics);
    if (!note.parsed.frontmatter) return;

    const metadata = note.parsed.frontmatter;
    this.db.query("INSERT INTO notes (note_id, path, title, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
      metadata.id,
      note.path,
      metadata.title,
      metadata.type,
      metadata.created_at,
      metadata.updated_at,
    );
    for (const alias of metadata.aliases) this.db.query("INSERT INTO note_aliases (note_id, alias) VALUES (?1, ?2)").run(metadata.id, alias);
    for (const tag of metadata.tags) this.db.query("INSERT INTO note_tags (note_id, tag) VALUES (?1, ?2)").run(metadata.id, tag);
    for (const section of note.parsed.sections) {
      this.db.query("INSERT INTO sections (note_id, section_id, level, heading, start_line, end_line, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(
        metadata.id,
        section.id ?? null,
        section.level,
        section.heading,
        section.startLine,
        section.endLine,
        section.revision,
      );
    }
    for (const link of note.parsed.wikilinks) {
      this.db.query("INSERT INTO links (source_note_id, target_title, target_section, display, line, column_number, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unresolved')").run(
        metadata.id,
        link.target,
        link.section ?? null,
        link.display ?? null,
        link.location.line,
        link.location.column,
      );
    }
    for (const table of note.parsed.tables) {
      table.rows.forEach((row, rowIndex) => {
        this.db.query("INSERT INTO table_rows (note_id, section_id, row_index, headers_json, values_json) VALUES (?1, ?2, ?3, ?4, ?5)").run(
          metadata.id,
          table.sectionId ?? null,
          rowIndex,
          JSON.stringify(table.headers),
          JSON.stringify(row),
        );
      });
    }
    const tags = metadata.tags.join(" ");
    this.db.query("INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?1, ?2, ?3, ?4)").run(metadata.id, metadata.title, note.parsed.body, tags);
  }

  insertFile(path: string, kind: string, hash: string, size: number, mtimeMs: number): void {
    this.db.query("INSERT OR REPLACE INTO files (path, kind, content_hash, size, mtime_ms, status, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, 'ok', ?6)").run(path, kind, hash, size, mtimeMs, new Date().toISOString());
  }

  insertDiagnostics(path: string, diagnostics: Diagnostic[]): void {
    for (const item of diagnostics) {
      this.db.query("INSERT INTO diagnostics (path, severity, code, message, line, column_number) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(path, item.severity, item.code, item.message, item.line ?? null, item.column ?? null);
    }
  }

  resolveLinks(): void {
    const titleRows = this.db.query<{ note_id: string; title: string; path: string }, []>("SELECT note_id, title, path FROM notes").all();
    const aliases = this.db.query<{ note_id: string; alias: string }, []>("SELECT note_id, alias FROM note_aliases").all();
    const targets = new Map<string, string>();
    for (const row of titleRows) {
      // Same filename-stem fallback as scanVault's diagnostics scan, so a link that
      // resolves cleanly (no warning) also resolves in the actual graph, not just the
      // diagnostics check.
      targets.set(basename(row.path, ".md").toLocaleLowerCase(), row.note_id);
      targets.set(row.title.toLocaleLowerCase(), row.note_id);
    }
    for (const row of aliases) targets.set(row.alias.toLocaleLowerCase(), row.note_id);
    const links = this.db.query<{ row_id: number; target_title: string }, []>("SELECT row_id, target_title FROM links").all();
    for (const link of links) {
      const noteId = targets.get(link.target_title.toLocaleLowerCase());
      this.db.query("UPDATE links SET target_note_id = ?1, status = ?2 WHERE row_id = ?3").run(noteId ?? null, noteId ? "resolved" : "unresolved", link.row_id);
    }
  }

  replaceGraph(graph: GraphBuild): void {
    this.db.query("DELETE FROM diagnostics WHERE path = '.cortex/project-graph'").run();
    this.db.run("DELETE FROM graph_edges");
    this.db.run("DELETE FROM graph_nodes");
    for (const node of graph.nodes) {
      this.db.query("INSERT INTO graph_nodes (node_id, kind, path, name, metadata_json) VALUES (?1, ?2, ?3, ?4, ?5)").run(node.nodeId, node.kind, node.path ?? null, node.name, JSON.stringify(node.metadata ?? {}));
    }
    for (const edge of graph.edges) {
      this.db.query("INSERT OR IGNORE INTO graph_edges (from_id, to_id, kind, metadata_json) VALUES (?1, ?2, ?3, ?4)").run(edge.fromId, edge.toId, edge.kind, JSON.stringify(edge.metadata ?? {}));
    }
    this.insertDiagnostics(".cortex/project-graph", graph.diagnostics);
  }

  refreshWikilinkEdges(): void {
    this.db.query("DELETE FROM graph_edges WHERE kind = 'wikilink'").run();
    const links = this.db.query<{ source_note_id: string; target_note_id: string | null; target_section: string | null; row_id: number }, []>("SELECT source_note_id, target_note_id, target_section, row_id FROM links WHERE target_note_id IS NOT NULL").all();
    for (const link of links) {
      this.db.query("INSERT OR IGNORE INTO graph_edges (from_id, to_id, kind, metadata_json) VALUES (?1, ?2, 'wikilink', ?3)").run(`note:${link.source_note_id}`, `note:${link.target_note_id}`, JSON.stringify({ rowId: link.row_id, section: link.target_section }));
    }
  }

  counts(): { noteCount: number; sectionCount: number; linkCount: number; tableRowCount: number; graphNodeCount: number; graphEdgeCount: number; diagnosticCount: number } {
    const count = (table: string): number => (this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ${table}`).get()?.count ?? 0);
    return { noteCount: count("notes"), sectionCount: count("sections"), linkCount: count("links"), tableRowCount: count("table_rows"), graphNodeCount: count("graph_nodes"), graphEdgeCount: count("graph_edges"), diagnosticCount: count("diagnostics") };
  }

  diagnostics(): Diagnostic[] {
    return this.db.query<Diagnostic & { column_number: number | null }, []>("SELECT severity, code, message, path as filePath, line, column_number FROM diagnostics ORDER BY row_id").all().map((row) => ({ severity: row.severity, code: row.code, message: row.message, filePath: row.filePath, line: row.line ?? undefined, column: row.column_number ?? undefined }));
  }
}
