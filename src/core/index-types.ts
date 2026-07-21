import type { Diagnostic, ParsedNote } from "./types.js";

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
