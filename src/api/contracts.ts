import type { Diagnostic, NoteFrontmatter, Section } from "../core/types.js";
import type { DiffResult, GitCommit, GitStatusEntry, GraphEdgeRecord, GraphNodeRecord, GraphQueryResult, HealthResult, HistoryResult, IndexPhase, NoteMetadataPatch, NoteRecord, NoteSource, RepositoryRestoreResult, VaultChangeEvent, VaultCheckResult, VaultTree, VaultTreeNode, WorkspaceStatus } from "../core/runtime-types.js";

/** Stable HTTP/MCP/UI wire aliases over the protocol-neutral core types. */
export type ApiSection = Section;
export type ApiDiagnostic = Diagnostic;
export type ApiNote = NoteRecord;
export type ApiGraphNode = GraphNodeRecord;
export type ApiGraphEdge = GraphEdgeRecord;
export type ApiChange = VaultChangeEvent;
export type ApiNoteSource = NoteSource;
export type ApiVaultTreeNode = VaultTreeNode;
export type ApiVaultTree = VaultTree;
export type ApiNoteMetadataPatch = NoteMetadataPatch;
export type ApiGraph = GraphQueryResult;
export type ApiGitCommit = GitCommit;
export type ApiHistory = HistoryResult;
export type ApiDiff = DiffResult;
export type ApiIndexPhase = IndexPhase;
export type ApiHealth = HealthResult;
export type ApiGitStatusEntry = GitStatusEntry;
export type ApiVaultCheck = VaultCheckResult;
export type ApiWorkspaceStatus = WorkspaceStatus;
export type ApiRepoRestoreResult = RepositoryRestoreResult;

export type ApiNoteUpdateInput = {
  note: string;
  expected_file_hash: string;
  body?: string;
  metadata?: ApiNoteMetadataPatch;
  markdown?: string;
};

export type ApiContext = {
  anchor?: ApiGraphNode;
  likely_files?: ApiGraphNode[];
  attached_notes?: ApiGraphNode[];
  related_nodes?: ApiGraphNode[];
  relationships?: ApiGraphEdge[];
  task_matches?: Array<{ note_id: string; title: string; path: string; snippet: string }>;
  truncated?: boolean;
  [key: string]: unknown;
};

export type ApiChangeEvent = {
  events: ApiChange[];
};

export type ApiWorkspaceRepository = WorkspaceStatus["repositories"][number];

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

// Keep these imports visible to generated declaration consumers that used the
// old contract module as the source of the frontmatter and section shapes.
export type { NoteFrontmatter, Section };
