import type { IndexReport } from "./index-types.js";
import type { Diagnostic, NoteFrontmatter, NoteType, Section } from "./types.js";

export type IndexPhase = "disabled" | "warming" | "current" | "rebuilding" | "error";

export type GitStatusEntry = {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
};

export type GitCommit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

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

export type VaultChangeEvent = {
  type: "create" | "update" | "delete";
  path: string;
  content_hash?: string;
  mtime?: string;
  repository?: string;
};

export type WorkspaceStatus = {
  active: boolean;
  phase: IndexPhase;
  error?: string;
  workspaceRoot?: string;
  workspaceExists?: boolean;
  repositories: Array<{ id: string; path: string; status: string; lastIndexedAt?: string; gitChangedFileCount?: number }>;
  diagnostics: Diagnostic[];
};

export type GraphDirection = "in" | "out" | "neighbors";

export type GraphQueryResult = {
  anchor: GraphNodeRecord;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  truncated: boolean;
};

export type WriteResult = {
  path: string;
  mtime: string;
  content_hash: string;
  index: IndexReport;
};

export type NoteMetadataPatch = {
  title?: string;
  type?: NoteType;
  aliases?: string[];
  tags?: string[];
  applies_to?: NoteFrontmatter["applies_to"];
  extra?: Record<string, unknown>;
};

export type NoteUpdateInput = {
  body?: string;
  metadata?: NoteMetadataPatch;
  markdown?: string;
};

export type NoteCreateInput = {
  title: string;
  type?: NoteType;
  aliases?: string[];
  tags?: string[];
  applies_to?: NoteFrontmatter["applies_to"];
  body?: string;
  path?: string;
};

export type NoteSource = {
  note: NoteRecord;
  markdown: string;
  body: string;
  frontmatter: NoteFrontmatter;
  sections: Section[];
  diagnostics: Diagnostic[];
};

export type VaultTreeNode =
  | {
      kind: "directory";
      path: string;
      name: string;
      children: VaultTreeNode[];
    }
  | {
      kind: "note";
      path: string;
      name: string;
      noteId: string;
      title: string;
      type: NoteType;
      updated_at: string;
    }
  | {
      kind: "file";
      path: string;
      name: string;
      openable: boolean;
    };

export type VaultTree = {
  rootName: string;
  children: VaultTreeNode[];
  truncated: boolean;
};

export type IndexCounts = {
  noteCount: number;
  sectionCount: number;
  linkCount: number;
  tableRowCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  diagnosticCount: number;
};

export type VaultCheckResult = {
  vaultRoot: string;
  diagnostics: Diagnostic[];
  index: IndexCounts;
  gitStatus: GitStatusEntry[];
  ok: boolean;
};

export type HealthResult = {
  status: "ok";
  phase: 3;
  index: IndexCounts;
  workspace: { active: boolean; phase: IndexPhase; error?: string };
};

export type HistoryResult = { path: string; commits: GitCommit[] };
export type DiffResult = { path: string; diff: string };
export type RepositoryHistoryResult = { repository: string; path: string; commits: GitCommit[] };
export type RepositoryDiffResult = { repository: string; path: string; diff: string };
export type RepositoryRestoreResult = { repository: string; path: string; revision: string; mtime: string };
