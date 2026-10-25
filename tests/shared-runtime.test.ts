import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault } from "../src/core/vault.js";
import { acquireRuntimeLease, ensureSharedRuntime, runtimeHeaders, runtimeUrl } from "../src/core/shared-runtime.js";

async function stopOwner(vault: string) {
  try {
    const owner = JSON.parse(readFileSync(join(vault, ".cortex/runtime-owner/owner.json"), "utf8"));
    process.kill(owner.pid, "SIGTERM");
    for (let n = 0; n < 100; n++) {
      try { process.kill(owner.pid, 0); } catch { return; }
      await Bun.sleep(30);
    }
  } catch {}
}

describe("shared runtime", () => {
  test("twelve concurrent MCP clients and desktop share one owner and observe writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-shared-"));
    const vault = initVault(join(root, "vault"));
    symlinkSync(vault, join(root, "alias"));
    const clients: Client[] = [];
    let desktop: Bun.Subprocess | undefined;
    try {
      const transports = Array.from({ length: 12 }, (_, i) => new StdioClientTransport({
        command: process.execPath, args: ["run", resolve("src/cli.ts"), "mcp", "--vault", i % 2 ? join(root, "alias") : vault],
        env: { ...process.env as Record<string, string>, CORTEX_PACKAGED: "1" },
        stderr: "pipe",
      }));
      await Promise.all(transports.map(async transport => {
        const client = new Client({ name: "shared-test", version: "1" });
        clients.push(client);
        await client.connect(transport);
      }));
      const owner = await ensureSharedRuntime(vault);
      const status = await fetch(runtimeUrl(owner) + "/_runtime/status", { headers: runtimeHeaders(owner) }).then(r => r.json()) as { pid: number; sessions: number; leases: number };
      expect(status.sessions).toBe(12);
      expect(status.leases).toBe(12);
      expect(owner.pid).not.toBe(process.pid);
      const unauthorized = await fetch(runtimeUrl(owner) + "/mcp", { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(403);
      const origin = await fetch(runtimeUrl(owner) + "/mcp", { method: "POST", headers: { ...runtimeHeaders(owner), origin: "https://example.com" }, body: "{}" });
      expect(origin.status).toBe(403);
      const created = await clients[0].callTool({ name: "create_note", arguments: { title: "Shared across agents", type: "note", body: "# Shared across agents\n\nOne writer." } });
      const id = (created.structuredContent as { id: string }).id;
      const reads = await Promise.all(clients.slice(1).map(client => client.callTool({ name: "get_note", arguments: { note: id } })));
      expect(reads.every(result => (result.structuredContent as { note: { title: string } }).note.title === "Shared across agents")).toBe(true);
      // A desktop listener forwards API calls to the same owner.
      const socket = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = socket.port!; socket.stop(true);
      desktop = Bun.spawn([process.execPath, "run", resolve("src/cli.ts"), "dev", "--vault", vault, "--port", String(port)], { stdout: "ignore", stderr: "pipe", env: { ...process.env, CORTEX_PACKAGED: "1" } });
      let health: { sharedRuntime?: { pid: number } } = {};
      for (let i = 0; i < 100; i++) {
        try { health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()) as typeof health; if (health.sharedRuntime) break; } catch {}
        await Bun.sleep(50);
      }
      expect(health.sharedRuntime?.pid).toBe(owner.pid);
      const preflight = await fetch(`http://127.0.0.1:${port}/api/health`, {
        method: "OPTIONS",
        headers: { origin: "tauri://localhost", "access-control-request-method": "GET", "access-control-request-headers": "content-type" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
      const desktopHealth = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { origin: "tauri://localhost" } });
      expect(desktopHealth.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      const desktopNote = await fetch(`http://127.0.0.1:${port}/api/note?selector=${id}`).then(response => response.json()) as { note: { title: string } };
      expect(desktopNote.note.title).toBe("Shared across agents");
      const stream = await fetch(`http://127.0.0.1:${port}/events`);
      const reader = stream.body!.getReader();
      try {
        await reader.read(); // Initial retry frame proves the stream is open.
        const nextEvent = reader.read();
        await clients[1].callTool({ name: "create_note", arguments: { title: "Desktop sees agent write", type: "note", body: "# Desktop sees agent write" } });
        const event = await Promise.race([
          nextEvent,
          Bun.sleep(3000).then(() => { throw new Error("Desktop proxy did not stream the agent change"); }),
        ]);
        expect(new TextDecoder().decode(event.value)).toContain("event: vault.change");
      } finally { await reader.cancel(); }
      await clients[0].close();
      expect((await clients[1].listTools()).tools.length).toBeGreaterThan(0);
      desktop.kill("SIGTERM"); await desktop.exited; desktop = undefined;
      expect((await clients[1].listTools()).tools.length).toBeGreaterThan(0);
      await Promise.all(clients.map(client => client.close()));
      const after = await fetch(runtimeUrl(owner) + "/_runtime/status", { headers: runtimeHeaders(owner) }).then(r => r.json()) as { sessions: number };
      expect(after.sessions).toBe(0);
    } finally {
      desktop?.kill("SIGTERM");
      await Promise.all(clients.map(client => client.close().catch(() => undefined)));
      await stopOwner(vault);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("crashed owner is recovered without a stale-lock race", async () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-shared-recovery-"));
    const vault = initVault(join(root, "vault"));
    try {
      const first = await ensureSharedRuntime(vault);
      process.kill(first.pid, "SIGKILL");
      await Bun.sleep(100);
      const endpoints = await Promise.all(Array.from({ length: 12 }, () => ensureSharedRuntime(vault)));
      expect(new Set(endpoints.map(owner => owner.pid)).size).toBe(1);
      expect(endpoints[0].pid).not.toBe(first.pid);
      const release = await acquireRuntimeLease(endpoints[0]);
      await release();
    } finally { await stopOwner(vault); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});

test("shared owner exits after its final lease is released", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-shared-idle-"));
  const vault = initVault(join(root, "vault"));
  const previous = process.env.CORTEX_RUNTIME_IDLE_MS;
  try {
    process.env.CORTEX_RUNTIME_IDLE_MS = "200";
    const owner = await ensureSharedRuntime(vault);
    if (previous === undefined) delete process.env.CORTEX_RUNTIME_IDLE_MS; else process.env.CORTEX_RUNTIME_IDLE_MS = previous;
    const release = await acquireRuntimeLease(owner);
    await release();
    let stopped = false;
    for (let n = 0; n < 100; n++) {
      try { process.kill(owner.pid, 0); } catch { stopped = true; break; }
      await Bun.sleep(50);
    }
    expect(stopped).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CORTEX_RUNTIME_IDLE_MS; else process.env.CORTEX_RUNTIME_IDLE_MS = previous;
    await stopOwner(vault); rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("a conflicting workspace cannot create another owner for the same vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-shared-config-"));
  const vault = initVault(join(root, "vault"));
  try {
    const owner = await ensureSharedRuntime(vault);
    await expect(ensureSharedRuntime(vault, { workspaceRoot: root })).rejects.toThrow("different workspace configuration");
    expect((await ensureSharedRuntime(vault)).pid).toBe(owner.pid);
  } finally { await stopOwner(vault); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
