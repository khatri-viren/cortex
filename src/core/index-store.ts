import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, constants } from "bun:sqlite";
import type { Diagnostic, ParsedNote } from "./types.js";
import type { FileKind, GraphBuild, IndexedMarkdown } from "./index-types.js";

const SCHEMA_VERSION = "1";

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
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_note_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_sections_note ON sections(note_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_path ON diagnostics(path);
`;

export class IndexStore {
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
    const titleRows = this.db.query<{ note_id: string; title: string }, []>("SELECT note_id, title FROM notes").all();
    const aliases = this.db.query<{ note_id: string; alias: string }, []>("SELECT note_id, alias FROM note_aliases").all();
    const targets = new Map<string, string>();
    for (const row of titleRows) targets.set(row.title.toLocaleLowerCase(), row.note_id);
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
