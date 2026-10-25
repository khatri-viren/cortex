import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault } from "../src/core/vault.js";

const executable = process.env.CORTEX_TEST_SIDECAR ?? process.execPath;
const prefix = process.env.CORTEX_TEST_SIDECAR ? [] : ["run", resolve("src/cli.ts")];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cortex-mcp-recovery-"));
  const vault = initVault(join(root, "vault"));
  const ownerFile = join(vault, ".cortex/runtime-owner/owner.json");
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const owner = () => JSON.parse(readFileSync(ownerFile, "utf8")) as { pid: number; port: number; token: string };
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: executable, args: [...prefix, "mcp", "--vault", vault],
      env: { ...process.env as Record<string, string>, CORTEX_PACKAGED: "1" }, stderr: "pipe",
    });
    const client = new Client({ name: "bridge-recovery-test", version: "1" });
    clients.push(client); transports.push(transport);
    await client.connect(transport);
    return { client, transport };
  };
  const stopOwner = async () => {
    const pid = owner().pid;
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    for (let n = 0; n < 100; n++) {
      try { process.kill(pid, 0); } catch { return; }
      await Bun.sleep(20);
    }
    throw new Error("Fixture owner failed to stop");
  };
  const close = async () => {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
    try { await stopOwner(); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { vault, ownerFile, owner, connect, stopOwner, close };
}

test("existing stdio client recovers concurrently after owner replacement", async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    expect((await client.listTools()).tools).toHaveLength(19);
    const original = f.owner().pid;
    await f.stopOwner();
    const reads = await Promise.all(Array.from({ length: 6 }, () => client.listTools()));
    expect(reads.every(result => result.tools.length === 19)).toBe(true);
    expect(f.owner().pid).not.toBe(original);
    const result = await client.callTool({ name: "create_note", arguments: { title: "After recovery", type: "note", body: "# After recovery" } });
    expect(result.isError).not.toBe(true);
    expect((await client.listTools()).tools).toHaveLength(19);
  } finally { await f.close(); }
}, 30_000);

test("delayed bridge recovers an expired session while another client stays active", async () => {
  const f = await fixture();
  let paused: number | undefined;
  try {
    const { client, transport } = await f.connect();
    const control = (await f.connect()).client;
    const original = f.owner().pid;
    paused = transport.pid!;
    process.kill(paused, "SIGSTOP");
    await Bun.sleep(50_000);
    expect((await control.listTools()).tools).toHaveLength(19);
    process.kill(paused, "SIGCONT"); paused = undefined;
    expect((await client.listTools()).tools).toHaveLength(19);
    expect(f.owner().pid).toBe(original);
    expect((await client.callTool({ name: "search", arguments: { query: "missing", limit: 1 } })).isError).not.toBe(true);
  } finally {
    if (paused) process.kill(paused, "SIGCONT");
    await f.close();
  }
}, 65_000);

test("pre-initialize probes return protocol responses without closing stdio", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({
    command: executable, args: [...prefix, "mcp", "--vault", f.vault],
    env: { ...process.env as Record<string, string>, CORTEX_PACKAGED: "1" }, stderr: "pipe",
  });
  try {
    const responses = new Map<number, (message: any) => void>();
    transport.onmessage = message => {
      if ("id" in message && typeof message.id === "number") responses.get(message.id)?.(message);
    };
    await transport.start();
    const request = (id: number, method: string, params?: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Probe closed or timed out: " + method)), 5000);
      responses.set(id, message => { clearTimeout(timer); resolve(message); });
      void transport.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).catch(reject);
    });
    expect((await request(1, "ping")).result).toEqual({});
    expect((await request(2, "cortex/unsupported-probe")).error.code).toBe(-32601);
    const init = await request(3, "initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
    expect(init.result.serverInfo.name).toBe("cortex-notes");
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await request(4, "tools/list")).result.tools).toHaveLength(19);
  } finally { await transport.close(); await f.close(); }
}, 15_000);

test.each(["response_lost", "session_rejected"] as const)("a %s write is handled without duplication and stdio remains usable", async failureMode => {
  const f = await fixture();
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    const control = (await f.connect()).client;
    await control.listTools();
    const owner = f.owner();
    let writes = 0;
    let rejected = false;
    proxy = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0,
      async fetch(request) {
        let loseResponse = false;
        if (request.method === "POST" && new URL(request.url).pathname === "/mcp") {
          const body = await request.clone().json().catch(() => ({})) as { method?: string; params?: { name?: string } };
          if (body.method === "tools/call" && body.params?.name === "create_note") {
            if (failureMode === "session_rejected" && !rejected) {
              rejected = true;
              return new Response("Unknown MCP session; reconnect", { status: 404 });
            }
            writes++;
            loseResponse = failureMode === "response_lost";
          }
        }
        const response = await fetch("http://127.0.0.1:" + owner.port + new URL(request.url).pathname, {
          method: request.method, headers: request.headers, body: request.body, signal: request.signal,
        });
        if (loseResponse) { await response.arrayBuffer(); return new Response("Upstream response lost", { status: 503 }); }
        return response;
      },
    });
    writeFileSync(f.ownerFile, JSON.stringify({ ...owner, ...JSON.parse(readFileSync(f.ownerFile, "utf8")), port: proxy.port }));
    const client = (await f.connect()).client;
    const result = await client.callTool({ name: "create_note", arguments: { title: "Exactly once", type: "note", body: "# Exactly once" } });
    if (failureMode === "response_lost") {
      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).error.code).toBe("MCP_EXECUTION_UNCERTAIN");
      expect((result.structuredContent as any).error.details.reason).toBe("http_503");
    } else expect(result.isError).not.toBe(true);
    expect(writes).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(19);
    const notes = await control.callTool({ name: "search", arguments: { query: "Exactly once", limit: 10 } });
    expect((notes.structuredContent as any).hits).toHaveLength(1);
  } finally { proxy?.stop(true); await f.close(); }
}, 20_000);
