import { appendFileSync } from "node:fs";
import { logger } from "../logger.js";

/** Machine-readable MCP call telemetry. Deliberately excludes arguments and result bodies. */
export type McpTraceEvent = {
  request_id?: string;
  session_id?: string;
  tool_use_id?: string;
  tool: string;
  input_mode: "canonical" | "legacy" | "mixed" | "invalid";
  duration_ms: number;
  success: boolean;
  error_code?: string;
  output_bytes: number;
  truncated: boolean;
  warning_count: number;
  empty_result: boolean;
  index_status?: "current" | "failed";
};

function tracePath(): string | undefined {
  const value = process.env.CORTEX_MCP_TRACE_FILE?.trim();
  return value || undefined;
}

/**
 * Emit an opt-in trace line and a structured stderr logger event. Telemetry is
 * fail-open: a bad trace destination must never change the MCP result.
 */
export function recordMcpCall(event: McpTraceEvent): void {
  const record = { type: "cortex.mcp.call", ...event };
  logger.info(record, "Cortex MCP call");
  const destination = tracePath();
  if (!destination) return;
  try {
    appendFileSync(destination, `${JSON.stringify(record)}\n`, "utf8");
  } catch (cause) {
    logger.warn({ error: cause instanceof Error ? cause.message : String(cause), destination }, "Cortex MCP trace write failed");
  }
}
