export type ApiSection = {
  id?: string;
  level: number;
  heading: string;
  startLine: number;
  endLine: number;
  revision: string;
};

export type ApiDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
};

export type ApiNote = {
  id: string;
  path: string;
  title: string;
  type: "note" | "map" | "table";
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  content_hash: string;
};

export type ApiGraphNode = {
  nodeId: string;
  kind: string;
  path?: string;
  name: string;
  metadata: Record<string, unknown>;
};

export type ApiGraphEdge = {
  fromId: string;
  toId: string;
  kind: string;
  metadata: Record<string, unknown>;
};

export type ApiChange = {
  type: "create" | "update" | "delete";
  path: string;
  content_hash?: string;
  mtime?: string;
  repository?: string;
};

export type ApiNoteSource = {
  note: ApiNote;
  markdown: string;
  sections: ApiSection[];
  diagnostics: ApiDiagnostic[];
};

export type ApiGraph = {
  anchor: ApiGraphNode;
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
  truncated: boolean;
};

export type ApiGitCommit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

export type ApiHistory = {
  path: string;
  commits: ApiGitCommit[];
};

export type ApiDiff = {
  path: string;
  diff: string;
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

export type ApiWorkspaceRepository = {
  id: string;
  path: string;
  status: string;
  lastIndexedAt?: string;
  gitChangedFileCount?: number;
};

export type ApiGitStatusEntry = {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
};

export type ApiVaultCheck = {
  vaultRoot: string;
  diagnostics: ApiDiagnostic[];
  index: {
    noteCount: number;
    sectionCount: number;
    linkCount: number;
    tableRowCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    diagnosticCount: number;
  };
  gitStatus: ApiGitStatusEntry[];
  ok: boolean;
};

export type ApiWorkspaceStatus = {
  active: boolean;
  workspaceRoot?: string;
  workspaceExists?: boolean;
  repositories: ApiWorkspaceRepository[];
  diagnostics: ApiDiagnostic[];
};

export type ApiRepoRestoreResult = {
  repository: string;
  path: string;
  revision: string;
  mtime: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
