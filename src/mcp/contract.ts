export const MCP_SERVER_INFO = { name: "cortex-notes", version: "2.1.0" };

export const MCP_TOOL_NAMES = [
  "get_note",
  "get_section",
  "patch_section",
  "replace_note",
  "search",
  "project_map",
  "graph_query",
  "get_context",
  "query_table",
  "list_notes",
  "create_note",
  "get_history",
  "get_diff",
  "restore_note",
  "vault_check",
  "workspace_status",
  "get_repo_history",
  "get_repo_diff",
  "restore_repo_path",
] as const;

/** Canonical argument examples used in initialize instructions and tests. */
export const MCP_CANONICAL_EXAMPLES = {
  get_note: { note: "notes/example.md" },
  get_section: { note: "notes/example.md", heading: "Overview" },
  patch_section: { note: "notes/example.md", heading: "Overview", expected_revision: "<64-char section revision>", new_content: "Updated section body.", ensure_marker: false },
  replace_note: { note: "notes/example.md", expected_file_hash: "<64-char SHA-256>", markdown: "<complete Markdown document>" },
  search: { query: "backend reliability", limit: 20 },
  project_map: { node: "repo:cortex", depth: 1, limit: 20 },
  graph_query: { node: "file:cortex:src/mcp/server.ts", direction: "neighbors", depth: 1, limit: 20 },
  get_context: { node: "repo:cortex", task_hint: "MCP ingress", limit: 20 },
  query_table: { note: "plans/example.md", section_id: "sec-...", contains: { Status: "pending" }, limit: 20 },
  list_notes: { prefix: "plans/", tag: "plan", limit: 20 },
  create_note: { title: "Example note", type: "note", body: "# Example note\n\nBody." },
  get_history: { note: "notes/example.md", limit: 20 },
  get_diff: { note: "notes/example.md", revision: "HEAD" },
  restore_note: { note: "notes/example.md", revision: "HEAD" },
  vault_check: {},
  workspace_status: {},
  get_repo_history: { repository: "cortex", path: "src/mcp/server.ts", limit: 20 },
  get_repo_diff: { repository: "cortex", path: "src/mcp/server.ts", revision: "HEAD" },
  restore_repo_path: { repository: "cortex", path: "src/mcp/server.ts", revision: "HEAD", confirm: true },
} as const;

export const MCP_INSTRUCTIONS = [
  "Cortex exposes focused note, graph, search, table, diagnostics, and Git tools. Prefer slices over whole-file exploration.",
  "Canonical argument examples:",
  JSON.stringify(MCP_CANONICAL_EXAMPLES),
  "Use repo:<id> and file:<id>:<repository-relative-path> graph IDs; never send absolute filesystem paths.",
  "Workspace attachments require repository plus a repository-relative target; use target '.' for a repository root and do not remove applies_to metadata.",
  "On writable:false, explicitly use ensure_marker:true for a deliberate marker insertion or use replace_note. On CONFLICT, reread the bounded current slice and issue a new write with its revision/hash; Cortex never automatically rebases.",
  "Deprecated aliases are accepted at the compatibility seam with structured warnings; use canonical fields for new calls.",
].join(" ");
