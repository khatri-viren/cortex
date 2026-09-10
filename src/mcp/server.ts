import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ServiceError } from "../core/errors.js";
import { VaultRuntime } from "../core/runtime.js";
import type { NoteType } from "../core/types.js";
import { MCP_FIELD_ALIASES, McpIngressError, normalizeMcpArguments, rawObjectIngressSchema, type McpDeprecationWarning } from "./adapter.js";
import { boundMcpResult, projectMcpResult, type McpProjectionContext } from "./projection.js";
import { recordMcpCall, type McpTraceEvent } from "./telemetry.js";

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

const MCP_INSTRUCTIONS = [
  "Cortex exposes focused note, graph, search, table, diagnostics, and Git tools. Prefer slices over whole-file exploration.",
  "Canonical argument examples:",
  JSON.stringify(MCP_CANONICAL_EXAMPLES),
  "Use repo:<id> and file:<id>:<repository-relative-path> graph IDs; never send absolute filesystem paths.",
  "Workspace attachments require repository plus a repository-relative target; use target '.' for a repository root and do not remove applies_to metadata.",
  "On writable:false, explicitly use ensure_marker:true for a deliberate marker insertion or use replace_note. On CONFLICT, reread the bounded current slice and issue a new write with its revision/hash; Cortex never automatically rebases.",
  "Deprecated aliases are accepted at the compatibility seam with structured warnings; use canonical fields for new calls.",
].join(" ");

type ToolPayload = Record<string, unknown>;

type ToolResult = {
  isError?: boolean;
  structuredContent: ToolPayload;
  content: Array<{ type: "text"; text: string }>;
};

function isObject(value: unknown): value is ToolPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inputMode(toolName: string, rawArguments: unknown): McpTraceEvent["input_mode"] {
  if (!isObject(rawArguments)) return "invalid";
  const aliases = (MCP_FIELD_ALIASES as Readonly<Record<string, Readonly<Record<string, string>>>>)[toolName];
  let usedAlias = false;
  let mixed = false;
  for (const [alias, canonical] of Object.entries(aliases ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(rawArguments, alias)) continue;
    usedAlias = true;
    if (Object.prototype.hasOwnProperty.call(rawArguments, canonical)) mixed = true;
  }
  return mixed ? "mixed" : usedAlias ? "legacy" : "canonical";
}

function payloadErrorCode(payload: ToolPayload): string | undefined {
  const error = payload.error;
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function payloadTruncated(payload: ToolPayload): boolean {
  return payload.truncated === true || Object.entries(payload).some(([key, value]) => key.endsWith("_truncated") && value === true);
}

function payloadIndexStatus(payload: ToolPayload): "current" | "failed" | undefined {
  const direct = payload.index_status;
  if (direct === "current" || direct === "failed") return direct;
  const index = payload.index;
  if (isObject(index) && (index.index_status === "current" || index.index_status === "failed")) return index.index_status;
  const error = payload.error;
  const details = isObject(error) && isObject(error.details) ? error.details : undefined;
  return details?.index_status === "failed" ? "failed" : undefined;
}

function outputBytes(result: ToolResult): number {
  return Buffer.byteLength(result.content.map((item) => item.text).join(""), "utf8");
}

function requestMetadata(extra: unknown): { request_id?: string; session_id?: string; tool_use_id?: string } {
  if (!isObject(extra)) return {};
  const requestId = extra.requestId;
  const sessionId = extra.sessionId;
  const meta = isObject(extra._meta) ? extra._meta : undefined;
  const toolUseId = meta?.tool_use_id ?? meta?.toolUseId;
  return {
    ...(typeof requestId === "string" || typeof requestId === "number" ? { request_id: String(requestId) } : {}),
    ...(typeof sessionId === "string" ? { session_id: sessionId } : {}),
    ...(typeof toolUseId === "string" ? { tool_use_id: toolUseId } : {}),
  };
}

function traceCall(
  toolName: string,
  startedAt: number,
  result: ToolResult,
  mode: McpTraceEvent["input_mode"],
  warningCount: number,
  extra?: unknown,
): void {
  const payload = result.structuredContent;
  try {
    recordMcpCall({
      ...requestMetadata(extra),
      tool: toolName,
      input_mode: mode,
      duration_ms: Math.max(0, Date.now() - startedAt),
      success: result.isError !== true,
      ...(payloadErrorCode(payload) ? { error_code: payloadErrorCode(payload) } : {}),
      output_bytes: outputBytes(result),
      truncated: payloadTruncated(payload),
      warning_count: warningCount,
      empty_result: Object.keys(payload).length === 0,
      ...(payloadIndexStatus(payload) ? { index_status: payloadIndexStatus(payload) } : {}),
    });
  } catch {
    // Telemetry is observational and must never change the MCP result.
  }
}

function success(toolName: string, payload: ToolPayload, warnings: McpDeprecationWarning[] = [], context: McpProjectionContext = {}): ToolResult {
  const projected = projectMcpResult(toolName, payload, context);
  const response = boundMcpResult(warnings.length > 0 ? { ...projected, warnings } : projected);
  return { structuredContent: response, content: [{ type: "text" as const, text: JSON.stringify(response) }] };
}

function failure(cause: unknown, warnings: McpDeprecationWarning[] = []): ToolResult {
  const error = cause instanceof ServiceError
    ? { code: cause.code, message: cause.message, details: cause.details }
    : { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) };
  const ingressWarnings = cause instanceof McpIngressError ? cause.warnings : [];
  const allWarnings = [...warnings, ...ingressWarnings];
  const payload = boundMcpResult(allWarnings.length > 0 ? { error, warnings: allWarnings } : { error });
  return { isError: true, structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function registerTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputShape: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<ToolPayload> | ToolPayload,
): void {
  const inputSchema = z.object(inputShape);
  server.registerTool(name, { description, inputSchema: rawObjectIngressSchema(inputSchema) }, async (rawArguments: unknown, extra: unknown) => {
    const startedAt = Date.now();
    let warnings: McpDeprecationWarning[] = [];
    let mode = inputMode(name, rawArguments);
    try {
      const normalized = normalizeMcpArguments(name, rawArguments, inputSchema);
      warnings = normalized.warnings;
      const payload = await handler(normalized.args);
      const normalizedRecord = normalized.args as Record<string, unknown>;
      const changedSection = name === "patch_section"
        ? (normalizedRecord.section_id as string | undefined) ?? (normalizedRecord.heading as string | undefined)
        : undefined;
      const diagnosticFilter = normalizedRecord.severity === "errors" || normalizedRecord.errors_only === true
        ? "errors" as const
        : normalizedRecord.severity === "warnings" || normalizedRecord.warnings_only === true
          ? "warnings" as const
          : "all" as const;
      const requestedFilter = normalizedRecord.filter;
      const effectiveDiagnosticFilter = requestedFilter === "errors" ? "errors" as const
        : requestedFilter === "warnings" ? "warnings" as const
          : diagnosticFilter;
      const includeDiagnostics = normalizedRecord.include_diagnostics === true || normalizedRecord.severity !== undefined || normalizedRecord.errors_only === true || normalizedRecord.warnings_only === true || requestedFilter === "errors" || requestedFilter === "warnings";
      const result = success(name, payload, warnings, {
        ...(changedSection ? { changedSection } : {}),
        warningCount: warnings.length,
        ...(includeDiagnostics ? { includeDiagnostics: true } : {}),
        ...(name === "vault_check" || name === "workspace_status" ? {
          diagnosticFilter: effectiveDiagnosticFilter,
          ...(requestedFilter === "summary" || requestedFilter === "changed_paths" ? { resultFilter: requestedFilter } : {}),
          diagnosticLimit: typeof normalizedRecord.limit === "number" ? normalizedRecord.limit : undefined,
          diagnosticCursor: typeof normalizedRecord.cursor === "string" ? normalizedRecord.cursor : undefined,
        } : {}),
      });
      traceCall(name, startedAt, result, mode, warnings.length, extra);
      return result;
    } catch (cause) {
      if (cause instanceof McpIngressError) mode = "invalid";
      const result = failure(cause, warnings);
      traceCall(name, startedAt, result, mode, warnings.length + (cause instanceof McpIngressError ? cause.warnings.length : 0), extra);
      return result;
    }
  });
}

export function createMcpServer(service: VaultRuntime): McpServer {
  const server = new McpServer(
    { name: "cortex-notes", version: "2.1.0" },
    { capabilities: { tools: { listChanged: false } }, instructions: MCP_INSTRUCTIONS },
  );

  registerTool(server, "get_note", "Return note metadata and a section outline without the full body. Example: {note: \"notes/example.md\"}.", {
    note: z.string().min(1),
  }, (args) => service.getNote(args.note));

  registerTool(server, "get_section", "Return one section body and its content revision. Heading lookup is read-only and must be unique. Example: {note: \"notes/example.md\", section_id: \"sec-...\", limit: 16000}.", {
    note: z.string().min(1),
    section_id: z.string().optional(),
    heading: z.string().optional(),
    limit: z.number().int().positive().max(16_000).optional(),
    cursor: z.string().optional(),
  }, (args) => {
    if (!args.section_id && !args.heading) throw new ServiceError("INVALID_INPUT", "Provide section_id or heading.");
    if (args.section_id && args.heading) throw new ServiceError("INVALID_INPUT", "Provide only one of section_id or heading.");
    return service.getSection(args.note, args.section_id, args.heading, args.limit, args.cursor);
  });

  registerTool(server, "patch_section", "Replace a section body with optimistic concurrency. Use section_id or a unique heading; markerless headings require explicit ensure_marker: true. Example: {note: \"notes/example.md\", section_id: \"sec-...\", expected_revision: \"<64-char hash>\", new_content: \"...\"}.", {
    note: z.string().min(1),
    section_id: z.string().min(1).optional(),
    heading: z.string().min(1).optional(),
    expected_revision: z.string().length(64),
    new_content: z.string(),
    ensure_marker: z.boolean().optional(),
    include_diagnostics: z.boolean().optional(),
  }, async (args) => {
    if (!args.section_id && !args.heading) throw new ServiceError("INVALID_INPUT", "Provide section_id or heading.");
    if (args.section_id && args.heading) throw new ServiceError("INVALID_INPUT", "Provide only one of section_id or heading.");
    return service.patchSection(args.note, args.section_id, args.expected_revision, args.new_content, {
      heading: args.heading,
      ensureMarker: args.ensure_marker,
    });
  });

  registerTool(server, "replace_note", "Replace complete Markdown using an optimistic full-file hash check. Example: {note: \"notes/example.md\", expected_file_hash: \"<64-char SHA-256>\", markdown: \"---\\n...\"}.", {
    note: z.string().min(1),
    expected_file_hash: z.string().length(64),
    markdown: z.string(),
    include_diagnostics: z.boolean().optional(),
  }, async (args) => service.replaceNote(args.note, args.expected_file_hash, args.markdown));

  registerTool(server, "search", "Search indexed note titles, bodies, and tags with compact snippets. Use this to discover titles and aliases before guessing selectors.", {
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
  }, (args) => service.search(args.query, args.limit));

  registerTool(server, "project_map", "Return a bounded, closed neighborhood of the repository project graph. Example: {node: \"repo:cortex\", depth: 1, limit: 20}.", {
    node: z.string().optional(),
    depth: z.number().int().positive().max(3).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.projectMap(args.node ?? "project:root", args.depth, args.limit));

  registerTool(server, "graph_query", "Traverse related code and note nodes with typed edges. Use namespaced nodes such as file:cortex:src/core/runtime.ts; absolute paths are rejected.", {
    node: z.string().min(1),
    direction: z.enum(["in", "out", "neighbors"]).default("neighbors"),
    depth: z.number().int().positive().max(4).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.graphQuery(args.node, args.direction, args.depth, args.limit));

  registerTool(server, "get_context", "Return compact purpose, graph relationships, likely files, attached notes, and task matches. Example: {node: \"repo:cortex\", limit: 20}.", {
    node: z.string().min(1),
    task_hint: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.getContext(args.node, args.task_hint, args.limit));

  registerTool(server, "query_table", "Query rows extracted from a Markdown table note. Requested limits as small as one are honored.", {
    note: z.string().min(1),
    section_id: z.string().optional(),
    contains: z.record(z.string()).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.queryTable(args.note, args.section_id, args.contains, args.limit));

  registerTool(server, "list_notes", "List compact indexed note summaries with optional path/title prefix and exact tag filters. Use next_cursor for the next page.", {
    prefix: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
    cursor: z.string().optional(),
  }, (args) => service.listNotes(args.prefix, args.tag, args.limit, args.cursor));

  registerTool(server, "create_note", "Create a valid note with generated identity and section markers. Workspace applies_to entries must include repository plus a repository-relative target; use target '.' for a repository root.", {
    title: z.string().min(1),
    type: z.enum(["note", "map", "table"]),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    applies_to: z.array(z.object({ target: z.string(), relation: z.enum(["documents", "owns", "implements", "depends_on", "related_to"]), repository: z.string().min(1).optional().describe("Required when the active vault is attached to a workspace; use a discovered repository id.") })).optional(),
    body: z.string().optional(),
    path: z.string().optional(),
    include_diagnostics: z.boolean().optional(),
  }, async (args) => service.createNote(args as { title: string; type: NoteType; aliases?: string[]; tags?: string[]; applies_to?: Array<{ target: string; relation: "documents" | "owns" | "implements" | "depends_on" | "related_to"; repository?: string }>; body?: string; path?: string }));

  registerTool(server, "get_history", "Return bounded Git commits affecting a note.", {
    note: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.history(args.note, args.limit));

  registerTool(server, "get_diff", "Return a bounded working-tree or revision diff for a note.", {
    note: z.string().min(1),
    revision: z.string().optional(),
    limit: z.number().int().positive().max(16_000).optional(),
    cursor: z.string().optional(),
  }, (args) => service.diff(args.note, args.revision, args.limit, args.cursor));

  registerTool(server, "restore_note", "Restore a clean note from Git and reindex it.", {
    note: z.string().min(1),
    revision: z.string().min(1),
    include_diagnostics: z.boolean().optional(),
  }, async (args) => service.restore(args.note, args.revision));

  registerTool(server, "vault_check", "Return vault health and paged diagnostics. Use include_diagnostics, severity, limit, and cursor to request a bounded diagnostic page.", {
    include_diagnostics: z.boolean().optional(),
    severity: z.enum(["all", "errors", "warnings"]).optional(),
    filter: z.enum(["summary", "errors", "warnings", "changed_paths"]).optional(),
    errors_only: z.boolean().optional(),
    warnings_only: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    cursor: z.string().optional(),
  }, (args) => service.vaultCheck());

  registerTool(server, "workspace_status", "Return workspace status with discovered repositories and bounded diagnostics. Set include_git: true only when Git counts are needed.", {
    include_git: z.boolean().optional(),
    include_diagnostics: z.boolean().optional(),
    severity: z.enum(["all", "errors", "warnings"]).optional(),
    filter: z.enum(["summary", "errors", "warnings", "changed_paths"]).optional(),
    errors_only: z.boolean().optional(),
    warnings_only: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    cursor: z.string().optional(),
  }, (args) => service.workspaceStatus(args.include_git ?? false));

  registerTool(server, "get_repo_history", "Return Git commits affecting a path within a discovered workspace repository.", {
    repository: z.string().min(1),
    path: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.getRepoHistory(args.repository, args.path, args.limit));

  registerTool(server, "get_repo_diff", "Return the working-tree or revision diff for a path within a discovered workspace repository.", {
    repository: z.string().min(1),
    path: z.string().min(1),
    revision: z.string().optional(),
    limit: z.number().int().positive().max(16_000).optional(),
    cursor: z.string().optional(),
  }, (args) => service.getRepoDiff(args.repository, args.path, args.revision, args.limit, args.cursor));

  registerTool(server, "restore_repo_path", "Restore a clean path within a workspace repository from Git. Requires confirm: true and refuses when the repository is dirty.", {
    repository: z.string().min(1),
    path: z.string().min(1),
    revision: z.string().min(1),
    confirm: z.boolean(),
    include_diagnostics: z.boolean().optional(),
  }, async (args) => service.restoreRepoPath(args.repository, args.path, args.revision, args.confirm));

  return server;
}

export async function runMcpServer(vaultRoot: string, options?: { workspaceRoot?: string }): Promise<void> {
  const service = await VaultRuntime.start(vaultRoot, options);
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await server.close().catch(() => undefined);
    await service.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.stdin.once("end", () => void shutdown().then(() => process.exit(0)));
  await server.connect(transport);
  await new Promise<void>(() => undefined);
}
