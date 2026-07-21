import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { McpVaultService, ServiceError } from "./service.js";
import type { NoteType } from "../core/types.js";

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
] as const;

type ToolPayload = Record<string, unknown>;

function success(payload: ToolPayload) {
  return { structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function failure(cause: unknown) {
  const error = cause instanceof ServiceError
    ? { code: cause.code, message: cause.message, details: cause.details }
    : { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) };
  const payload = { error };
  return { isError: true, structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function registerTool(server: McpServer, name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: Record<string, any>) => Promise<ToolPayload> | ToolPayload): void {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return success(await handler(args as Record<string, any>));
    } catch (cause) {
      return failure(cause);
    }
  });
}

export function createMcpServer(service: McpVaultService): McpServer {
  const server = new McpServer(
    { name: "cortex-notes", version: "2.0.0" },
    { capabilities: { tools: { listChanged: false } }, instructions: "Cortex exposes focused note, graph, search, table, diagnostics, and Git tools. Prefer slices over whole-file exploration." },
  );

  registerTool(server, "get_note", "Return note metadata and a section outline without the full body.", {
    note: z.string().min(1),
  }, (args) => service.getNote(args.note));

  registerTool(server, "get_section", "Return one section body and its content revision. Heading lookup is read-only and must be unique.", {
    note: z.string().min(1),
    section_id: z.string().optional(),
    heading: z.string().optional(),
  }, (args) => {
    if (!args.section_id && !args.heading) throw new ServiceError("INVALID_INPUT", "Provide section_id or heading.");
    if (args.section_id && args.heading) throw new ServiceError("INVALID_INPUT", "Provide only one of section_id or heading.");
    return service.getSection(args.note, args.section_id, args.heading);
  });

  registerTool(server, "patch_section", "Replace a marked section body when its expected revision still matches.", {
    note: z.string().min(1),
    section_id: z.string().min(1),
    expected_revision: z.string().length(64),
    new_content: z.string(),
  }, async (args) => service.patchSection(args.note, args.section_id, args.expected_revision, args.new_content));

  registerTool(server, "replace_note", "Replace complete Markdown using an optimistic full-file hash check.", {
    note: z.string().min(1),
    expected_file_hash: z.string().length(64),
    markdown: z.string(),
  }, async (args) => service.replaceNote(args.note, args.expected_file_hash, args.markdown));

  registerTool(server, "search", "Search indexed note titles, bodies, and tags with compact snippets.", {
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
  }, (args) => service.search(args.query, args.limit));

  registerTool(server, "project_map", "Return a bounded neighborhood of the repository project graph.", {
    node: z.string().optional(),
    depth: z.number().int().positive().max(3).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.projectMap(args.node ?? "project:root", args.depth, args.limit));

  registerTool(server, "graph_query", "Traverse related code and note nodes with typed edges.", {
    node: z.string().min(1),
    direction: z.enum(["in", "out", "neighbors"]).default("neighbors"),
    depth: z.number().int().positive().max(4).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.graphQuery(args.node, args.direction, args.depth, args.limit));

  registerTool(server, "get_context", "Return compact purpose, graph relationships, likely files, attached notes, and task matches.", {
    node: z.string().min(1),
    task_hint: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.getContext(args.node, args.task_hint, args.limit));

  registerTool(server, "query_table", "Query rows extracted from a Markdown table note.", {
    note: z.string().min(1),
    section_id: z.string().optional(),
    contains: z.record(z.string()).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.queryTable(args.note, args.section_id, args.contains, args.limit));

  registerTool(server, "list_notes", "List indexed notes with optional path/title prefix and exact tag filters.", {
    prefix: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.listNotes(args.prefix, args.tag, args.limit));

  registerTool(server, "create_note", "Create a valid note with generated identity and section markers.", {
    title: z.string().min(1),
    type: z.enum(["note", "map", "table"]),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    applies_to: z.array(z.object({ target: z.string(), relation: z.enum(["documents", "owns", "implements", "depends_on", "related_to"]) })).optional(),
    body: z.string().optional(),
    path: z.string().optional(),
  }, async (args) => service.createNote(args as { title: string; type: NoteType; aliases?: string[]; tags?: string[]; applies_to?: Array<{ target: string; relation: "documents" | "owns" | "implements" | "depends_on" | "related_to" }>; body?: string; path?: string }));

  registerTool(server, "get_history", "Return Git commits affecting a note.", {
    note: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  }, (args) => service.history(args.note, args.limit));

  registerTool(server, "get_diff", "Return the working-tree or revision diff for a note.", {
    note: z.string().min(1),
    revision: z.string().optional(),
  }, (args) => service.diff(args.note, args.revision));

  registerTool(server, "restore_note", "Restore a clean note from Git and reindex it.", {
    note: z.string().min(1),
    revision: z.string().min(1),
  }, async (args) => service.restore(args.note, args.revision));

  registerTool(server, "vault_check", "Return vault diagnostics, index counts, and Git status.", {}, () => service.vaultCheck());

  return server;
}

export async function runMcpServer(vaultRoot: string): Promise<void> {
  const service = await McpVaultService.start(vaultRoot);
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
