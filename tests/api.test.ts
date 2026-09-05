import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/server.js";
import { reconcileMarkdown } from "../src/core/reconcile.js";
import { initVault } from "../src/core/vault.js";
import { VaultRuntime } from "../src/core/runtime.js";
import { pdfRendererExecutablePath } from "../src/core/pdf-export.js";

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
      expect((await (await fetch(base + "/api/health")).json()).workspace.phase).toBe("disabled");

      const rebuilt = await fetch(base + "/api/index/rebuild", { method: "POST" });
      expect(rebuilt.status).toBe(200);
      expect((await rebuilt.json()).index.mode).toBe("full");

      const source = await fetch(base + "/api/note?selector=project-map.md&source=true");
      expect(source.status).toBe(200);
      expect((await source.json()).markdown).toContain("Project Map");
      expect((await fetch(base + "/api/note?selector=project-map.md&source=true")).status).toBe(200);

      const graph = await fetch(base + "/api/project-map?depth=1&limit=20");
      expect((await graph.json()).anchor.nodeId).toBe("project:root");

      const search = await fetch(base + "/api/search?query=Engine");
      expect((await search.json()).hits.length).toBeGreaterThan(0);

      const invalid = await fetch(base + "/api/note");
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe("INVALID_INPUT");
    });
  });

  test("returns a deterministic, bounded graph neighborhood", async () => {
    await withApi(async (base) => {
      const responses = await Promise.all([
        fetch(base + "/api/project-map?depth=3&limit=50"),
        fetch(base + "/api/project-map?depth=3&limit=50"),
      ]);
      const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ anchor: { nodeId: string }; nodes: unknown[]; edges: unknown[]; truncated: boolean }>));
      expect(payloads[0]?.anchor.nodeId).toBe("project:root");
      expect(payloads[0]?.nodes.length).toBeLessThanOrEqual(50);
      expect(payloads[0]?.nodes).toEqual(payloads[1]?.nodes);
      expect(payloads[0]?.edges).toEqual(payloads[1]?.edges);
      expect(typeof payloads[0]?.truncated).toBe("boolean");
    });
  });

  test("serves a vault tree and accepts structured body/metadata updates", async () => {
    await withApi(async (base) => {
      const tree = await fetch(base + "/api/vault/tree");
      expect(tree.status).toBe(200);
      const treePayload = await tree.json() as { children: Array<{ kind: string; path: string; children?: Array<{ path: string }> }> };
      expect(treePayload.children.some((node) => node.path === "notes" && node.kind === "directory")).toBe(true);

      const sourceResponse = await fetch(base + "/api/note?selector=notes/engine.md&source=true");
      const source = await sourceResponse.json() as { note: { content_hash: string; title: string }; body: string; frontmatter: { id: string; created_at: string; tags: string[] } };
      expect(source.body).toContain("# Engine Notes");
      expect(source.frontmatter.id).toBeTruthy();

      const update = await fetch(base + "/api/note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: "notes/engine.md",
          expected_file_hash: source.note.content_hash,
          body: source.body + "\nStructured update.\n",
          metadata: { title: "Engine Notes Updated", tags: ["backend"] },
        }),
      });
      expect(update.status).toBe(200);
      const updated = await update.json() as { note: { title: string; content_hash: string }; body: string; frontmatter: { tags: string[] } };
      expect(updated.note.title).toBe("Engine Notes Updated");
      expect(updated.body).toContain("Structured update.");
      expect(updated.frontmatter.tags).toEqual(["backend"]);
      expect(updated.note.content_hash).not.toBe(source.note.content_hash);
    });
  });

  test("paginates note metadata with an opaque cursor", async () => {
    await withApi(async (base) => {
      const first = await (await fetch(base + "/api/notes?limit=1")).json() as { notes: Array<{ path: string }>; truncated: boolean; next_cursor?: string };
      expect(first.notes).toHaveLength(1);
      expect(first.truncated).toBe(true);
      expect(first.next_cursor).toBeTruthy();

      const second = await (await fetch(base + "/api/notes?limit=1&cursor=" + encodeURIComponent(first.next_cursor!))).json() as { notes: Array<{ path: string }>; truncated: boolean };
      expect(second.notes).toHaveLength(1);
      expect(second.notes[0]?.path).not.toBe(first.notes[0]?.path);

      const invalid = await fetch(base + "/api/notes?cursor=not-a-cursor");
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe("INVALID_INPUT");
    });
  });

  test("validates PDF export input without mutating the source note", async () => {
    await withApi(async (base) => {
      const before = await (await fetch(base + "/api/note?selector=project-map.md&source=true")).json() as { note: { content_hash: string }; body: string };
      const response = await fetch(base + "/api/note/export/pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "project-map.md", body: before.body, title: "   " }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_INPUT");
      const after = await (await fetch(base + "/api/note?selector=project-map.md&source=true")).json() as { note: { content_hash: string } };
      expect(after.note.content_hash).toBe(before.note.content_hash);
    });
  });

  test("delivers PDF bytes with a checksum and explicit length", async () => {
    const executable = pdfRendererExecutablePath();
    if (!executable) return;
    const previous = process.env.CORTEX_CHROMIUM_PATH;
    process.env.CORTEX_CHROMIUM_PATH = executable;
    try {
      await withApi(async (base) => {
        const response = await fetch(base + "/api/note/export/pdf", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "project-map.md", body: "# Export\n\nBounded bytes.", title: "Export" }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/pdf");
        expect(response.headers.get("content-length")).toBeTruthy();
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
        const checksum = await crypto.subtle.digest("SHA-256", bytes);
        const actual = Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, "0")).join("");
        expect(response.headers.get("x-cortex-pdf-sha256")).toBe(actual);
      });
    } finally {
      if (previous === undefined) delete process.env.CORTEX_CHROMIUM_PATH;
      else process.env.CORTEX_CHROMIUM_PATH = previous;
    }
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
      const data = received.split("\n").find((line) => line.startsWith("data: "));
      const changeSet = JSON.parse(data?.slice("data: ".length) ?? "{}") as { sequence?: number; generation?: number; events?: Array<{ scopes?: string[] }> };
      expect(changeSet.sequence).toBeGreaterThan(0);
      expect(changeSet.generation).toBeGreaterThan(0);
      expect(changeSet.events?.[0]?.scopes).toEqual(expect.arrayContaining(["content", "graph"]));
      expect(existsSync(path)).toBe(true);
    });
  }, 10_000);

  test("replays versioned changes and emits one app-owned write event", async () => {
    await withApi(async (base) => {
      const source = await (await fetch(base + "/api/note?selector=project-map.md&source=true")).json() as { note: { content_hash: string }; body: string };
      const update = await fetch(base + "/api/note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "project-map.md", expected_file_hash: source.note.content_hash, body: source.body + "\nApp-owned event.\n" }),
      });
      expect(update.status).toBe(200);
      const replay = await (await fetch(base + "/api/changes?since=0")).json() as { changes: Array<{ events: Array<{ path: string }> }>; resyncRequired: boolean };
      expect(replay.resyncRequired).toBe(false);
      const matching = replay.changes.flatMap((change) => change.events).filter((event) => event.path === "project-map.md");
      expect(matching).toHaveLength(1);

      const stream = await fetch(base + "/events?since=0");
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let replayed = "";
      const deadline = Date.now() + 1000;
      while (!replayed.includes("project-map.md") && Date.now() < deadline) {
        const next = await reader.read();
        if (next.done) break;
        replayed += decoder.decode(next.value);
      }
      await reader.cancel();
      expect(replayed).toContain("project-map.md");

      const stale = await (await fetch(base + "/api/changes?since=999")).json() as { resyncRequired: boolean };
      expect(stale.resyncRequired).toBe(true);
    });
  });
});
