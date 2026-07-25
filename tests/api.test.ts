import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/server.js";
import { reconcileMarkdown } from "../src/core/reconcile.js";
import { initVault } from "../src/core/vault.js";
import { VaultRuntime } from "../src/mcp/service.js";

function temporaryVault(): string {
  return initVault(join(mkdtempSync(join(tmpdir(), "cortex-phase3-api-")), "vault"));
}

async function withApi<T>(callback: (base: string, vault: string) => Promise<T>): Promise<T> {
  const vault = temporaryVault();
  const runtime = await VaultRuntime.start(vault);
  const server = createApiServer(runtime, 0);
  const base = "http://" + server.hostname + ":" + server.port;
  try {
    return await callback(base, vault);
  } finally {
    server.stop();
    await runtime.close();
  }
}

describe("Phase 3 local API", () => {
  test("serves source, graph, search, and structured errors", async () => {
    await withApi(async (base) => {
      const health = await fetch(base + "/api/health");
      expect(health.status).toBe(200);
      expect((await health.json()).phase).toBe(3);

      const source = await fetch(base + "/api/note?selector=project-map.md&source=true");
      expect(source.status).toBe(200);
      expect((await source.json()).markdown).toContain("Project Map");

      const graph = await fetch(base + "/api/project-map?depth=1&limit=20");
      expect((await graph.json()).anchor.nodeId).toBe("project:root");

      const search = await fetch(base + "/api/search?query=Engine");
      expect((await search.json()).hits.length).toBeGreaterThan(0);

      const invalid = await fetch(base + "/api/note");
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe("INVALID_INPUT");
    });
  });

  test("reconciles disjoint sections and reports overlapping conflicts", () => {
    const body = `---
id: 7a4d31c8-3a7d-4cf1-87f9-0e2f9e59f111
title: Merge Test
type: note
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

# Merge Test

<!-- cortex:section id="sec-7a4d31c8-3a7d-4cf1-87f9-0e2f9e59f112" -->

One

## Second

<!-- cortex:section id="sec-7a4d31c8-3a7d-4cf1-87f9-0e2f9e59f113" -->

Two
`;
    const local = body.replace("One", "Local one");
    const remote = body.replace("Two", "Remote two");
    const merged = reconcileMarkdown(body, local, remote);
    expect(merged.status).toBe("merged");
    if (merged.status === "merged") expect(merged.markdown).toContain("Local one");
    if (merged.status === "merged") expect(merged.markdown).toContain("Remote two");

    const conflict = reconcileMarkdown(body, local, body.replace("One", "Remote one"));
    expect(conflict).toMatchObject({ status: "conflict", conflicts: ["sec-7a4d31c8-3a7d-4cf1-87f9-0e2f9e59f112"] });
  });

  test("publishes relative watcher events over SSE", async () => {
    await withApi(async (base, vault) => {
      const response = await fetch(base + "/events");
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      await reader.read();

      const path = join(vault, "project-map.md");
      writeFileSync(path, readFileSync(path, "utf8") + "\nSSE event.\n");
      let received = "";
      const deadline = Date.now() + 3000;
      while (!received.includes("project-map.md") && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 500)),
        ]);
        if (next.done) break;
        received += decoder.decode(next.value);
      }
      await reader.cancel();
      expect(received).toContain("project-map.md");
      expect(received).not.toContain(vault);
      expect(existsSync(path)).toBe(true);
    });
  }, 10_000);
});
