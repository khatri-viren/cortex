import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { createApiServer } from "../api/server.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { VaultRuntime } from "./runtime.js";
import { parse as parseYaml } from "yaml";
import { ClientLiveness } from "./runtime-liveness.js";
import { requireGitVault } from "./vault-path.js";

const PROTOCOL = 1;
const STARTUP_MS = 120_000;

const IDLE_MS = Number(process.env.CORTEX_RUNTIME_IDLE_MS ?? 15_000);
export type RuntimeEndpoint = {
  protocol: number; pid: number; token: string; port?: number;
  vault: string; workspace?: string; build: string;
};
type Options = { workspaceRoot?: string; startupTimeoutMs?: number; signal?: AbortSignal };

function identity(vaultRoot: string, options?: Options) {
  const vault = realpathSync(requireGitVault(vaultRoot));
  const requested = options?.workspaceRoot ?? process.env.CORTEX_WORKSPACE_ROOT;
  const manifestPath = join(vault, "workspace.yaml");
  const manifest = existsSync(manifestPath) ? parseYaml(readFileSync(manifestPath, "utf8")) as { workspace_root?: string } : undefined;
  const configured = requested ?? manifest?.workspace_root;
  const workspace = configured ? resolve(vault, configured) : undefined;
  return { vault, workspace: workspace && existsSync(workspace) ? realpathSync(workspace) : workspace };
}

function buildId(): string {
  const executable = statSync(process.execPath);
  return `${PROTOCOL}:${realpathSync(process.execPath)}:${executable.size}:${executable.mtimeMs}`;
}

function ownerPath(vault: string): string { return join(vault, ".cortex", "runtime-owner"); }
function readOwner(vault: string): RuntimeEndpoint | undefined {
  try { return JSON.parse(readFileSync(join(ownerPath(vault), "owner.json"), "utf8")); } catch { return undefined; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function runtimeHeaders(endpoint: RuntimeEndpoint): Record<string, string> {
  return { authorization: `Bearer ${endpoint.token}` };
}
export function runtimeUrl(endpoint: RuntimeEndpoint): string { return `http://127.0.0.1:${endpoint.port}`; }

export async function ensureSharedRuntime(vaultRoot: string, options?: Options): Promise<RuntimeEndpoint> {
  const expected = identity(vaultRoot, options);
  const deadline = Date.now() + (options?.startupTimeoutMs ?? STARTUP_MS);
  let launched = false;
  while (Date.now() < deadline) {
    options?.signal?.throwIfAborted();
    const owner = readOwner(expected.vault);
    if (owner && alive(owner.pid) && owner.port) {
      let ready = false;
      try {
        const response = await fetch(runtimeUrl(owner) + "/_runtime/status", { headers: runtimeHeaders(owner), signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
        ready = response.ok && (await response.json() as { pid: number }).pid === owner.pid;
      } catch { /* Startup, crash or stale descriptor. Ownership is decided by the kernel lock. */ }
      if (ready) {
        if (owner.protocol !== PROTOCOL || owner.build !== buildId()) throw new Error("This vault has a Cortex runtime from another build. Disconnect its clients and let it stop before retrying.");
        if (owner.workspace !== expected.workspace) throw new Error("The shared Cortex runtime has a different workspace configuration for this vault.");
        return owner;
      }
    }
    if (!launched) {
      const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.ts");
      const args = existsSync(cli) ? ["run", cli] : [];
      args.push("runtime:serve", "--vault", expected.vault);
      if (expected.workspace) args.push("--workspace", expected.workspace);
      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env } });
      child.on("error", () => undefined);
      child.unref();
      launched = true;
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for the shared Cortex runtime. Inspect the vault runtime-owner descriptor and installed resources.");
}

export async function acquireRuntimeLease(endpoint: RuntimeEndpoint): Promise<(() => Promise<void>) & { id: string }> {
  const id = randomUUID();
  const request = async (method: string) => {
    const response = await fetch(runtimeUrl(endpoint) + "/_runtime/lease/" + id, {
      method, headers: runtimeHeaders(endpoint), signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Cortex runtime lease failed: " + response.status);
  };
  await request("POST");
  let failed = false;
  const timer = setInterval(() => void request("POST").then(() => {
    if (failed) console.error("[cortex:runtime] lease_renewal_recovered");
    failed = false;
  }).catch(() => {
    if (!failed) console.error("[cortex:runtime] lease_renewal_failed");
    failed = true;
  }), 10_000);
  return Object.assign(async () => { clearInterval(timer); await request("DELETE").catch(() => undefined); }, { id });
}

/** Exactly one process holds this vault's watcher/index ownership. */
export async function runSharedRuntime(vaultRoot: string, options?: Options): Promise<void> {
  const { VaultRuntime } = await import("./runtime.js");
  const { createApiServer } = await import("../api/server.js");
  const { createMcpServer } = await import("../mcp/server.js");
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  const expected = identity(vaultRoot, options);
  const directory = ownerPath(expected.vault);
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A dedicated SQLite lock is held for the owner's lifetime. The kernel
  // releases it on crash; no PID-file stealing or stale-unlink race exists.
  const ownership = new Database(join(directory, "ownership.sqlite"), { create: true });
  try { ownership.exec("BEGIN EXCLUSIVE"); } catch (error) {
    ownership.close();
    if (String(error).includes("locked") || String(error).includes("busy")) return;
    throw error;
  }
  const endpoint: RuntimeEndpoint = { ...expected, protocol: PROTOCOL, pid: process.pid, token: randomUUID(), build: buildId() };
  const publish = () => {
    const temporary = join(directory, "owner.tmp");
    writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 });
    renameSync(temporary, join(directory, "owner.json"));
  };
  publish();
  let runtime: VaultRuntime | undefined;
  let server: ReturnType<typeof createApiServer> | undefined;
  let closing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const liveness = new ClientLiveness();
  const leases = liveness.leases;
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; close: () => Promise<void>; seen: number }>();
  let lastActive = Date.now();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    server?.stop(true);
    try {
      await Promise.all([...sessions.values()].map(session => session.close().catch(() => undefined)));
      await runtime?.close();
    } finally {
      if (readOwner(expected.vault)?.token === endpoint.token) rmSync(join(directory, "owner.json"), { force: true });
      ownership.close();
    }
  };
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  try {
    runtime = await VaultRuntime.start(expected.vault, { workspaceRoot: expected.workspace });
    const uiDist = process.env.CORTEX_UI_DIST ?? (process.env.CORTEX_PACKAGED === "1"
      ? resolve(dirname(process.execPath), "../Resources/dist")
      : resolve(dirname(fileURLToPath(import.meta.url)), "../../ui/dist"));
    server = createApiServer(runtime, 0, uiDist, async request => {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return Response.json({ ...runtime!.health(), sharedRuntime: { pid: process.pid, leases: leases.size, sessions: sessions.size } });
      }
      if (!url.pathname.startsWith("/_runtime/") && url.pathname !== "/mcp") return undefined;
      if (request.headers.get("authorization") !== "Bearer " + endpoint.token || request.headers.has("origin")) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname === "/_runtime/status") return Response.json({ pid: process.pid, leases: leases.size, sessions: sessions.size });
      if (url.pathname.startsWith("/_runtime/lease/")) {
        const id = url.pathname.slice("/_runtime/lease/".length);
        if (request.method === "POST") {
          const lease = liveness.renew(id);
          const session = lease.session ? sessions.get(lease.session) : undefined;
          if (session) session.seen = Date.now();
        }
        else if (request.method === "DELETE") leases.delete(id);
        else return new Response("Method not allowed", { status: 405 });
        lastActive = Date.now();
        return new Response(null, { status: 204 });
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      lastActive = Date.now();
      const sessionId = request.headers.get("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return new Response("Unknown MCP session; reconnect", { status: 404 });
      if (!session) {
        if (request.method !== "POST") return new Response("Initialize required", { status: 400 });
        if (sessions.size >= 128) return new Response("Too many MCP clients", { status: 429 });
        const mcp = createMcpServer(runtime!);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: id => {
            sessions.set(id, session!);
            const leaseId = request.headers.get("x-cortex-lease");
            const lease = leaseId ? leases.get(leaseId) : undefined;
            if (lease) lease.session = id;
          },
          onsessionclosed: id => { sessions.delete(id); },
        });
        session = { transport, close: () => mcp.close(), seen: Date.now() };
        await mcp.connect(transport);
      }
      session.seen = Date.now();
      const response = await session.transport.handleRequest(request);
      if (!session.transport.sessionId) await session.close();
      return response;
    });
    endpoint.port = server.port;
    publish();
    timer = setInterval(() => {
      const now = Date.now();
      const sweep = liveness.sweep(now);
      if (sweep.resumed) for (const session of sessions.values()) session.seen = now;
      if (sweep.expired.length) console.error("[cortex:runtime] lease_expired count=" + sweep.expired.length);
      for (const lease of sweep.expired) {
        if (lease.session) {
          const session = sessions.get(lease.session);
          sessions.delete(lease.session);
          void session?.close();
        }
      }
      for (const [id, session] of sessions) {
        if (now - session.seen > 30 * 60_000) {
          sessions.delete(id);
          void session.close();
        }
      }
      if (leases.size || sessions.size) lastActive = now;
      else if (now - lastActive > IDLE_MS) void shutdown().then(() => process.exit(0));
    }, 1000);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** Desktop/dev compatibility listener. It owns no index, watcher or database. */
export async function runSharedApi(vault: string, port: number, options?: Options): Promise<void> {
  const endpoint = await ensureSharedRuntime(vault, options);
  const release = await acquireRuntimeLease(endpoint);
  const proxy = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // Internal control and MCP are private to the owner.
      if (url.pathname.startsWith("/_runtime/") || url.pathname === "/mcp") return new Response("Not found", { status: 404 });
      const headers = new Headers(request.headers);
      headers.delete("host");
      try {
        return await fetch(runtimeUrl(endpoint) + url.pathname + url.search, {
          method: request.method, headers, body: request.body,
          signal: request.signal, redirect: "manual",
        });
      } catch { return Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "Cortex runtime disconnected; reopen the vault." } }, { status: 503 }); }
    },
  });
  const shutdown = async () => { proxy.stop(true); await release(); process.exit(0); };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
