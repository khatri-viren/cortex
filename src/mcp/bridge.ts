import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_INSTRUCTIONS, MCP_SERVER_INFO } from "./contract.js";
import { RuntimeConnection, RuntimeConnectionError } from "./runtime-connection.js";

const READ_TOOLS = new Set([
  "get_note", "get_section", "search", "project_map", "graph_query", "get_context",
  "query_table", "list_notes", "get_history", "get_diff", "vault_check",
  "workspace_status", "get_repo_history", "get_repo_diff",
]);

/** Own the stdio protocol lifecycle without owning a vault, SQLite, or watchers. */
export async function runMcpBridge(vault: string, options?: { workspaceRoot?: string }): Promise<void> {
  const remote = new RuntimeConnection(vault, options?.workspaceRoot);
  const local = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } }, instructions: MCP_INSTRUCTIONS,
  });
  local.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      return await remote.execute(client => client.listTools(request.params, { signal: extra.signal }), true, extra.signal);
    } catch (error) {
      if (error instanceof RuntimeConnectionError) throw new McpError(ErrorCode.InternalError, error.message, { code: error.code, reason: error.reason });
      throw error;
    }
  });
  local.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await remote.execute(
        client => client.callTool(request.params, undefined, { signal: extra.signal }),
        READ_TOOLS.has(request.params.name), extra.signal,
      );
    } catch (error) {
      if (!(error instanceof RuntimeConnectionError)) throw error;
      const payload = { error: { code: error.code, message: error.message, details: { reason: error.reason } } };
      return { isError: true, structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  });
  local.onerror = () => console.error("[cortex:mcp] stdio_protocol_error");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([local.close(), remote.close()]);
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.stdin.once("end", () => void shutdown().then(() => process.exit(0)));
  try {
    // Warm ownership before the initialization response, retaining the existing
    // startup contract. Remote failure never closes the agent-facing transport.
    await remote.get().catch(() => console.error("[cortex:mcp] runtime_start_unavailable"));
    if (closing) return;
    await local.connect(new StdioServerTransport());
    await new Promise<void>(() => undefined);
  } finally { await shutdown(); }
}
