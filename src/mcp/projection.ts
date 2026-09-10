import { createHash } from "node:crypto";
import { ServiceError } from "../core/errors.js";

type JsonObject = Record<string, unknown>;

export type McpProjectionContext = {
  changedSection?: string;
  warningCount?: number;
  includeDiagnostics?: boolean;
  diagnosticFilter?: "all" | "errors" | "warnings";
  resultFilter?: "summary" | "errors" | "warnings" | "changed_paths";
  diagnosticLimit?: number;
  diagnosticCursor?: string;
};

// Keep the compatibility representation below the provider cap observed in
// the audit while leaving structuredContent and content equally actionable.
export const MCP_MAX_RESULT_BYTES = 48_000;
const MAX_TEXT_BYTES = 16_000;
const MAX_ARRAY_ITEMS = 100;
const DEFAULT_DIAGNOSTIC_LIMIT = 20;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MCP_MAX_RESULT_BYTES + 1;
  }
}

function boundedText(value: string, maxBytes = MAX_TEXT_BYTES): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, Math.floor(value.length * (maxBytes / Math.max(1, Buffer.byteLength(value, "utf8")))));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
  return { value: `${value.slice(0, end)}...`, truncated: true };
}

type BoundStats = {
  truncated: boolean;
  omitted: number;
};

function boundValue(value: unknown, stats: BoundStats): unknown {
  if (typeof value === "string") {
    const bounded = boundedText(value);
    if (bounded.truncated) {
      stats.truncated = true;
      stats.omitted += Math.max(1, value.length - bounded.value.length);
    }
    return bounded.value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      stats.truncated = true;
      stats.omitted += value.length - MAX_ARRAY_ITEMS;
    }
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, stats));
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundValue(item, stats)]));
  return value;
}

function diagnosticCounts(index: JsonObject | undefined): { diagnosticCount: number; errorCount: number; warningCount: number } {
  const diagnostics = Array.isArray(index?.diagnostics) ? index.diagnostics : [];
  return {
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((diagnostic) => isObject(diagnostic) && diagnostic.severity === "error").length,
    warningCount: diagnostics.filter((diagnostic) => isObject(diagnostic) && diagnostic.severity === "warning").length,
  };
}

function diagnosticsFrom(payload: JsonObject): JsonObject[] {
  return Array.isArray(payload.diagnostics) ? payload.diagnostics.filter(isObject) : [];
}

function diagnosticCursorKey(diagnostics: JsonObject[]): string {
  return createHash("sha256").update(JSON.stringify(diagnostics)).digest("hex");
}

function encodeDiagnosticCursor(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ key, offset }), "utf8").toString("base64url");
}

function decodeDiagnosticCursor(cursor: string | undefined, key: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { key?: unknown; offset?: unknown };
    if (parsed.key !== key || typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("stale cursor");
    return parsed.offset;
  } catch {
    throw new ServiceError("CONFLICT", "Diagnostic cursor is stale or invalid.", { recovery: "Call the diagnostic tool again without cursor to obtain a fresh page." });
  }
}

function projectDiagnostics(payload: JsonObject, context: McpProjectionContext): JsonObject {
  const all = diagnosticsFrom(payload);
  const counts = {
    diagnostic_count: all.length,
    error_count: all.filter((diagnostic) => diagnostic.severity === "error").length,
    warning_count: all.filter((diagnostic) => diagnostic.severity === "warning").length,
  };
  const filtered = context.diagnosticFilter === "errors"
    ? all.filter((diagnostic) => diagnostic.severity === "error")
    : context.diagnosticFilter === "warnings"
      ? all.filter((diagnostic) => diagnostic.severity === "warning")
      : all;
  if (context.resultFilter === "summary" || context.resultFilter === "changed_paths" || (!context.includeDiagnostics && (!context.diagnosticFilter || context.diagnosticFilter === "all"))) {
    const changedPaths = Array.isArray(payload.gitStatus)
      ? payload.gitStatus.filter(isObject).map((entry) => {
        const path = entry.path;
        const repository = entry.repository;
        return typeof path === "string" && typeof repository === "string" ? `${repository}:${path}` : path;
      }).filter((path): path is string => typeof path === "string")
      : [];
    return {
      ...payload,
      ...counts,
      ...(context.resultFilter === "changed_paths" ? { changed_paths: changedPaths } : {}),
      ...(all.length > 0 ? { diagnostics_omitted: all.length } : {}),
      ...(all.length > 0 ? { diagnostics: undefined } : {}),
    };
  }
  const key = diagnosticCursorKey(filtered);
  const offset = decodeDiagnosticCursor(context.diagnosticCursor, key);
  const limit = Math.max(1, Math.min(Math.floor(context.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT), MAX_ARRAY_ITEMS));
  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + page.length < filtered.length;
  return {
    ...payload,
    ...counts,
    diagnostics: page,
    ...(hasMore ? {
      diagnostics_truncated: true,
      diagnostics_cursor: encodeDiagnosticCursor(key, offset + page.length),
      omitted_diagnostics: filtered.length - offset - page.length,
    } : {}),
  };
}

function compactIndex(index: JsonObject | undefined): JsonObject | undefined {
  if (!index) return undefined;
  const counts = diagnosticCounts(index);
  const compact: JsonObject = {};
  for (const key of ["mode", "noteCount", "sectionCount", "linkCount", "tableRowCount", "graphNodeCount", "graphEdgeCount"]) {
    if (index[key] !== undefined) compact[key] = index[key];
  }
  if (typeof index.durationMs === "number") compact.durationMs = index.durationMs;
  if (isObject(index.work)) {
    const work = Object.fromEntries(Object.entries(index.work).filter(([, value]) => typeof value === "number"));
    if (Object.keys(work).length > 0) compact.work = work;
  }
  if (Array.isArray(index.changedPaths)) compact.changedPaths = index.changedPaths.slice(0, MAX_ARRAY_ITEMS);
  compact.diagnostic_count = counts.diagnosticCount;
  compact.error_count = counts.errorCount;
  compact.warning_count = counts.warningCount;
  compact.index_status = index.index_status === "failed" ? "failed" : "current";
  if (Array.isArray(index.changedPaths) && index.changedPaths.length > MAX_ARRAY_ITEMS) {
    compact.truncated = true;
    compact.omitted_changed_paths = index.changedPaths.length - MAX_ARRAY_ITEMS;
  }
  return compact;
}

function projectWriteResult(payload: JsonObject, context: McpProjectionContext): JsonObject {
  const index = isObject(payload.index) ? payload.index : undefined;
  const counts = diagnosticCounts(index);
  const result: JsonObject = {
    persisted: true,
    ...(typeof payload.path === "string" ? { path: payload.path } : {}),
    ...(typeof payload.mtime === "string" ? { mtime: payload.mtime } : {}),
    ...(typeof payload.content_hash === "string" ? { content_hash: payload.content_hash } : {}),
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    ...(typeof payload.repository === "string" ? { repository: payload.repository } : {}),
    ...(typeof payload.revision === "string" ? { revision: payload.revision } : {}),
    changed_sections: Array.isArray(payload.changed_sections)
      ? payload.changed_sections.filter((section): section is string => typeof section === "string").slice(0, MAX_ARRAY_ITEMS)
      : context.changedSection ? [context.changedSection] : [],
    changed_section_count: Array.isArray(payload.changed_sections)
      ? payload.changed_sections.length
      : context.changedSection ? 1 : 0,
    index_counts: {
      ...(typeof index?.noteCount === "number" ? { noteCount: index.noteCount } : {}),
      ...(typeof index?.sectionCount === "number" ? { sectionCount: index.sectionCount } : {}),
      ...(typeof index?.linkCount === "number" ? { linkCount: index.linkCount } : {}),
      ...(typeof index?.tableRowCount === "number" ? { tableRowCount: index.tableRowCount } : {}),
      ...(typeof index?.graphNodeCount === "number" ? { graphNodeCount: index.graphNodeCount } : {}),
      ...(typeof index?.graphEdgeCount === "number" ? { graphEdgeCount: index.graphEdgeCount } : {}),
    },
    index_status: payload.index_status === "failed" ? "failed" : "current",
    diagnostic_count: counts.diagnosticCount,
    error_count: counts.errorCount,
    warning_count: counts.warningCount + (context.warningCount ?? 0),
    omitted_fields: ["index.diagnostics"],
  };
  if (Array.isArray(payload.changed_sections) && payload.changed_sections.length > MAX_ARRAY_ITEMS) {
    result.changed_sections_truncated = true;
    result.omitted_changed_sections = payload.changed_sections.length - MAX_ARRAY_ITEMS;
  }
  const indexProjection = compactIndex(index);
  if (indexProjection) result.index = indexProjection;
  if (context.includeDiagnostics && index) {
    const diagnosticPayload = projectDiagnostics({ diagnostics: index.diagnostics }, context);
    if (Array.isArray(diagnosticPayload.diagnostics)) result.diagnostics = diagnosticPayload.diagnostics;
    if (diagnosticPayload.diagnostics_truncated) {
      result.diagnostics_truncated = true;
      result.diagnostics_cursor = diagnosticPayload.diagnostics_cursor;
      result.omitted_diagnostics = diagnosticPayload.omitted_diagnostics;
    }
  }
  return result;
}

function projectTextField(payload: JsonObject, field: string, maxBytes = MAX_TEXT_BYTES): JsonObject {
  const value = payload[field];
  if (typeof value !== "string") return payload;
  const bounded = boundedText(value, maxBytes);
  return bounded.truncated ? { ...payload, [field]: bounded.value, [`${field}_truncated`]: true } : payload;
}

function projectListNotes(payload: JsonObject): JsonObject {
  if (!Array.isArray(payload.notes)) return payload;
  return {
    ...payload,
    notes: payload.notes.filter(isObject).map((note) => ({
      ...(typeof note.id === "string" ? { id: note.id } : {}),
      ...(typeof note.path === "string" ? { path: note.path } : {}),
      ...(typeof note.title === "string" ? { title: note.title } : {}),
      ...(typeof note.type === "string" ? { type: note.type } : {}),
      ...(typeof note.updated_at === "string" ? { updated_at: note.updated_at } : {}),
      ...(Array.isArray(note.aliases) && note.aliases.length > 0 ? { aliases: note.aliases.slice(0, MAX_ARRAY_ITEMS) } : {}),
    })),
  };
}

function projectArrayField(payload: JsonObject, field: string): JsonObject {
  const value = payload[field];
  if (!Array.isArray(value) || value.length <= MAX_ARRAY_ITEMS) return payload;
  return { ...payload, [field]: value.slice(0, MAX_ARRAY_ITEMS), [`${field}_truncated`]: true };
}

function boundGraph(payload: JsonObject): JsonObject {
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) return payload;
  const nodes = [...payload.nodes];
  const edges = [...payload.edges];
  let omittedNodes = typeof payload.omitted_nodes === "number" ? payload.omitted_nodes : 0;
  let omittedEdges = typeof payload.omitted_edges === "number" ? payload.omitted_edges : 0;

  const makePayload = (): JsonObject => {
    const anchorId = isObject(payload.anchor) && typeof payload.anchor.nodeId === "string" ? payload.anchor.nodeId : undefined;
    const allowed = new Set([anchorId, ...nodes.filter(isObject).map((node) => typeof node.nodeId === "string" ? node.nodeId : undefined)]);
    const closedEdges = edges.filter((edge) => {
      if (!isObject(edge)) return false;
      const fromId = typeof edge.fromId === "string" ? edge.fromId : undefined;
      const toId = typeof edge.toId === "string" ? edge.toId : undefined;
      return allowed.has(fromId) && allowed.has(toId);
    });
    const droppedEdges = edges.length - closedEdges.length;
    return {
      ...payload,
      nodes,
      edges: closedEdges,
      truncated: payload.truncated === true || omittedNodes > 0 || omittedEdges > 0 || droppedEdges > 0,
      ...(omittedNodes > 0 ? { omitted_nodes: omittedNodes } : {}),
      ...(omittedEdges > 0 || droppedEdges > 0 ? { omitted_edges: omittedEdges + droppedEdges } : {}),
    };
  };

  let result = makePayload();
  while (serializedBytes(result) > MCP_MAX_RESULT_BYTES && (edges.length > 0 || nodes.length > 0)) {
    if (edges.length > 0) {
      edges.pop();
      omittedEdges += 1;
    } else {
      nodes.pop();
      omittedNodes += 1;
    }
    result = makePayload();
  }
  return result;
}

/** Bound a response without changing its top-level structured shape. */
export function boundMcpResult(payload: JsonObject): JsonObject {
  const stats: BoundStats = { truncated: false, omitted: 0 };
  let result = boundValue(payload, stats) as JsonObject;
  for (const field of ["body", "diff", "context"]) result = projectTextField(result, field);
  for (const field of ["commits", "diagnostics", "repositories", "hits", "notes", "rows"]) result = projectArrayField(result, field);
  if (Array.isArray(result.nodes) && Array.isArray(result.edges)) result = boundGraph(result);
  if (stats.truncated) result = { ...result, truncated: true, omitted_items: stats.omitted };
  if (serializedBytes(result) <= MCP_MAX_RESULT_BYTES) return result;

  // Preserve the small, stable receipt/error identity fields if an unknown
  // nested payload is still too large after known projections.
  const fallback: JsonObject = {
    truncated: true,
    omitted_items: Math.max(1, stats.omitted),
    omitted_fields: ["unbounded_payload"],
  };
  for (const key of ["path", "mtime", "content_hash", "id", "persisted", "changed_sections", "index_status", "diagnostic_count", "error", "warnings"]) {
    if (result[key] === undefined) continue;
    const candidateValue = key === "error" && isObject(result[key])
      ? {
        ...(typeof result[key].code === "string" ? { code: result[key].code } : {}),
        ...(typeof result[key].message === "string" ? { message: boundedText(result[key].message, 2_000).value } : {}),
      }
      : result[key];
    const candidate = { ...fallback, [key]: candidateValue };
    if (serializedBytes(candidate) <= MCP_MAX_RESULT_BYTES) fallback[key] = candidateValue;
  }
  if (isObject(result.error)) {
    fallback.error = {
      ...(typeof result.error.code === "string" ? { code: result.error.code } : {}),
      ...(typeof result.error.message === "string" ? { message: boundedText(result.error.message, 2_000).value } : {}),
    };
  }
  return fallback;
}

/**
 * Project full runtime write results into compact MCP receipts and bound
 * large read responses at the transport boundary.
 */
export function projectMcpResult(toolName: string, payload: JsonObject, context: McpProjectionContext = {}): JsonObject {
  let result = ["create_note", "patch_section", "replace_note", "restore_note", "restore_repo_path"].includes(toolName)
    ? projectWriteResult(payload, context)
    : payload;
  if (toolName === "vault_check" || toolName === "workspace_status") result = projectDiagnostics(result, context);
  if (toolName === "list_notes") result = projectListNotes(result);
  if (toolName === "get_section") result = projectTextField(result, "body");
  if (toolName === "get_diff" || toolName === "get_repo_diff") result = projectTextField(result, "diff");
  return boundMcpResult(result);
}
