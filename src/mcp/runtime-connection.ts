import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { acquireRuntimeLease, ensureSharedRuntime, runtimeHeaders, runtimeUrl } from "../core/shared-runtime.js";

type Connection = { client: Client; dispose: () => Promise<void> };

export class RuntimeConnectionError extends Error {
  constructor(readonly code: "MCP_RUNTIME_UNAVAILABLE" | "MCP_EXECUTION_UNCERTAIN", readonly reason: string) {
    super(code === "MCP_EXECUTION_UNCERTAIN"
      ? "The runtime response was lost. This operation may have completed; inspect the vault before retrying. Cortex did not replay it."
      : "The Cortex runtime is unavailable. The agent connection is still open; retry the request.");
  }
}

function recoverable(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 404 || error.code === 408 || error.code === 429 || (error.code ?? 0) >= 500;
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout;
  // Network/stream failures are thrown by fetch rather than returned by MCP.
  return error instanceof Error;
}

function reason(error: unknown): string {
  if (error instanceof StreamableHTTPError) return "http_" + (error.code ?? "unknown");
  if (error instanceof McpError) return error.code === ErrorCode.RequestTimeout ? "request_timeout" : "connection_closed";
  return "transport_or_setup_error";
}

/** One replaceable HTTP client behind a stable agent-facing stdio connection. */
export class RuntimeConnection {
  private current?: Connection;
  private connecting?: Promise<Connection>;
  private readonly lifetime = new AbortController();

  constructor(private readonly vault: string, private readonly workspaceRoot?: string) {}

  async get(): Promise<Connection> {
    this.lifetime.signal.throwIfAborted();
    if (this.current) return this.current;
    if (!this.connecting) {
      this.connecting = this.connect().then(connection => {
        this.current = connection;
        return connection;
      }).finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private async connect(): Promise<Connection> {
    const endpoint = await ensureSharedRuntime(this.vault, {
      workspaceRoot: this.workspaceRoot, startupTimeoutMs: 10_000, signal: this.lifetime.signal,
    });
    this.lifetime.signal.throwIfAborted();
    const release = await acquireRuntimeLease(endpoint);
    const transport = new StreamableHTTPClientTransport(new URL(runtimeUrl(endpoint) + "/mcp"), {
      requestInit: { headers: { ...runtimeHeaders(endpoint), "x-cortex-lease": release.id } },
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1.5 },
    });
    const client = new Client({ name: "cortex-mcp-bridge", version: "2.1.0" });
    let reported = false;
    client.onerror = error => {
      if (!reported && !this.lifetime.signal.aborted) {
        reported = true;
        console.error("[cortex:mcp] remote_transport_error reason=" + reason(error));
      }
    };
    let disposing: Promise<void> | undefined;
    const connection: Connection = { client, dispose: () => disposing ??= (async () => {
      const sessionId = transport.sessionId;
      await client.close().catch(() => undefined);
      if (sessionId) await fetch(runtimeUrl(endpoint) + "/mcp", {
        method: "DELETE",
        headers: { ...runtimeHeaders(endpoint), "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
      await release();
    })() };
    try {
      await client.connect(transport, { timeout: 10_000, signal: this.lifetime.signal });
      this.lifetime.signal.throwIfAborted();
      return connection;
    } catch (error) {
      await connection.dispose();
      throw error;
    }
  }

  private async invalidate(connection: Connection): Promise<void> {
    if (this.current === connection) this.current = undefined;
    await connection.dispose();
  }

  async execute<T>(operation: (client: Client) => Promise<T>, replaySafe: boolean, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      let connection: Connection | undefined;
      // A failed ping cannot have dispatched the user's operation, including writes.
      try {
        connection = await this.get();
        await connection.client.ping({ timeout: 3000, signal });
      } catch (error) {
        signal?.throwIfAborted();
        if (connection) await this.invalidate(connection);
        if (attempt === 0 && recoverable(error)) {
          console.error("[cortex:mcp] reconnect_before_dispatch reason=" + reason(error));
          continue;
        }
        throw new RuntimeConnectionError("MCP_RUNTIME_UNAVAILABLE", reason(error));
      }
      try {
        return await operation(connection.client);
      } catch (error) {
        signal?.throwIfAborted();
        if (!recoverable(error)) throw error;
        await this.invalidate(connection);
        // A 404 is returned before dispatch when the session no longer exists.
        const rejected = error instanceof StreamableHTTPError && error.code === 404;
        if (!replaySafe && !rejected) {
          console.error("[cortex:mcp] execution_uncertain reason=" + reason(error));
          throw new RuntimeConnectionError("MCP_EXECUTION_UNCERTAIN", reason(error));
        }
        if (attempt === 0) {
          console.error("[cortex:mcp] reconnect_after_rejection reason=" + reason(error));
          continue;
        }
        throw new RuntimeConnectionError("MCP_RUNTIME_UNAVAILABLE", reason(error));
      }
    }
    throw new RuntimeConnectionError("MCP_RUNTIME_UNAVAILABLE", "retry_exhausted");
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    const pending = await this.connecting?.catch(() => undefined);
    const current = this.current ?? pending;
    this.current = undefined;
    await current?.dispose();
  }
}
