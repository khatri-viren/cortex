import type { Diagnostic, NoteType, ParsedNote } from "./types.js";

export type FileKind = "markdown" | "module" | "test" | "configuration" | "asset";

export type IndexReport = {
  mode: "full" | "incremental";
  changedPaths: string[];
  noteCount: number;
  sectionCount: number;
  linkCount: number;
  tableRowCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  diagnostics: Diagnostic[];
  durationMs: number;
};

export type IndexedMarkdown = {
  path: string;
  absolutePath: string;
  content: string;
  parsed: ParsedNote;
  hash: string;
  mtimeMs: number;
};

export type GraphNode = {
  nodeId: string;
  kind: string;
  path?: string;
  name: string;
  metadata?: Record<string, unknown>;
};

export type GraphEdge = {
  fromId: string;
  toId: string;
  kind: string;
  metadata?: Record<string, unknown>;
};

export type GraphBuild = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
};

export type IndexedNoteRecord = {
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

export type IndexedNoteHeader = {
  note_id: string;
  path: string;
  title: string;
  type: NoteType;
  updated_at: string;
};

export type IndexSearchHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
};

export type IndexSearchResult = {
  hits: IndexSearchHit[];
  truncated: boolean;
};

export type IndexedGraphNodeRow = {
  node_id: string;
  kind: string;
  path: string | null;
  name: string;
  metadata_json: string;
};

export type IndexedGraphEdgeRow = {
  from_id: string;
  to_id: string;
  kind: string;
  metadata_json: string;
};

export type WorkspaceRepositoryRecord = {
  repositoryId: string;
  path: string;
  status: "ready" | "missing" | "stale";
  lastIndexedAt?: string;
};

export type WorkspaceIndexReport = {
  mode: "full" | "incremental";
  repositories: string[];
  fileCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  diagnostics: Diagnostic[];
  durationMs: number;
};
