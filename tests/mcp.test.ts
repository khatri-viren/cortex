import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, MCP_TOOL_NAMES } from "../src/mcp/server.js";
import { VaultRuntime } from "../src/core/runtime.js";
import { initVault } from "../src/core/vault.js";

function temporaryVault(): string {
  return initVault(join(mkdtempSync(join(tmpdir(), "cortex-mcp-")), "vault"));
}

async function connectedMcp(vault: string) {
  const service = await VaultRuntime.start(vault);
  const server = createMcpServer(service);
  const client = new Client({ name: "cortex-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    service,
    server,
    client,
    async close() {
      await client.close();
      await server.close();
      await service.close();
    },
  };
}

function structured(result: unknown): Record<string, any> {
  return (result as { structuredContent?: unknown }).structuredContent as Record<string, any>;
}

describe("MCP server", () => {
  test("discovers tools and serves focused note and graph queries", async () => {
    const vault = temporaryVault();
    const mcp = await connectedMcp(vault);
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("replace_note");
      expect(tools.tools).toHaveLength(MCP_TOOL_NAMES.length);

      const schemaFor = (name: string) => tools.tools.find((tool) => tool.name === name)?.inputSchema as {
        properties?: Record<string, { type?: string }>;
        required?: string[];
      };
      expect(tools.tools.every((tool) => Object.keys(tool.inputSchema.properties ?? {}).length > 0)).toBe(true);
      expect(schemaFor("project_map").properties?.depth?.type).toBe("integer");
      expect(schemaFor("project_map").properties?.limit?.type).toBe("integer");
      expect(schemaFor("list_notes").properties?.limit?.type).toBe("integer");
      expect(schemaFor("patch_section").properties?.ensure_marker?.type).toBe("boolean");
      expect(schemaFor("create_note").properties?.tags?.type).toBe("array");
      expect(schemaFor("create_note").properties?.applies_to?.type).toBe("array");
      expect(schemaFor("workspace_status").properties?.include_git?.type).toBe("boolean");
      expect(schemaFor("get_note").properties?.note?.type).toBe("string");
      expect(schemaFor("get_note").required).toContain("note");
      expect(schemaFor("patch_section").required).toEqual(expect.arrayContaining(["note", "expected_revision", "new_content"]));

      const legacy = await mcp.client.callTool({ name: "get_note", arguments: { path: "project-map.md" } });
      expect(structured(legacy).warnings).toEqual([
        expect.objectContaining({ code: "DEPRECATED_FIELD", field: "path", canonical_field: "note" }),
      ]);

      const stringified = await mcp.client.callTool({ name: "project_map", arguments: { depth: "1", limit: "30" } });
      expect(stringified.isError).toBe(true);
      expect(structured(stringified).error).toMatchObject({ code: "INVALID_INPUT" });
      expect(structured(stringified).error.details.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["depth"], code: "invalid_type" }),
        expect.objectContaining({ path: ["limit"], code: "invalid_type" }),
      ]));

      const noteResult = await mcp.client.callTool({ name: "get_note", arguments: { note: "project-map.md" } });
      const note = structured(noteResult);
      expect(note.note.title).toBe("Project Map");
      expect(note.sections[0].id).toMatch(/^sec-/);
      expect(note.sections[0].body).toBeUndefined();

      const graphResult = await mcp.client.callTool({ name: "project_map", arguments: { node: "project:root", depth: 1 } });
      expect(structured(graphResult).anchor.nodeId).toBe("project:root");
      expect(structured(graphResult).nodes.length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });

  test("creates, patches, searches, and rejects stale section revisions", async () => {
    const vault = temporaryVault();
    const mcp = await connectedMcp(vault);
    try {
      const created = structured(await mcp.client.callTool({
        name: "create_note",
        arguments: { title: "MCP Notes", type: "note", body: "# MCP Notes\n\nInitial backend context." },
      }));
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(existsSync(join(vault, created.path))).toBe(true);

      const note = structured(await mcp.client.callTool({ name: "get_note", arguments: { note: created.id } }));
      const section = note.sections[0];
      const patched = structured(await mcp.client.callTool({
        name: "patch_section",
        arguments: { note: created.id, section_id: section.id, expected_revision: section.revision, new_content: "Updated backend context." },
      }));
      expect(patched.path).toBe(created.path);

      const stale = await mcp.client.callTool({
        name: "patch_section",
        arguments: { note: created.id, section_id: section.id, expected_revision: section.revision, new_content: "This must conflict." },
      });
      expect(stale.isError).toBe(true);
      expect(structured(stale).error.code).toBe("CONFLICT");

      const search = structured(await mcp.client.callTool({ name: "search", arguments: { query: "backend" } }));
      expect(search.hits.some((hit: { title: string }) => hit.title === "MCP Notes")).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  test("replaces a note only with the current hash and preserves identity", async () => {
    const vault = temporaryVault();
    const mcp = await connectedMcp(vault);
    try {
      const path = join(vault, "project-map.md");
      const original = readFileSync(path, "utf8");
      const hash = createHash("sha256").update(original).digest("hex");
      const note = structured(await mcp.client.callTool({ name: "get_note", arguments: { note: "project-map.md" } }));
      const replacement = original.replace("This vault describes the project structure.", "This vault describes the MCP project structure.");
      const result = structured(await mcp.client.callTool({ name: "replace_note", arguments: { note: "project-map.md", expected_file_hash: hash, markdown: replacement } }));
      expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
      const updated = structured(await mcp.client.callTool({ name: "get_note", arguments: { note: "project-map.md" } }));
      expect(updated.note.id).toBe(note.note.id);
      expect(readFileSync(path, "utf8")).toContain("MCP project structure");

      const conflict = await mcp.client.callTool({ name: "replace_note", arguments: { note: "project-map.md", expected_file_hash: hash, markdown: replacement } });
      expect(conflict.isError).toBe(true);
      expect(structured(conflict).error.code).toBe("CONFLICT");
    } finally {
      await mcp.close();
    }
  });

  test("speaks MCP over the real per-vault stdio entrypoint", async () => {
    const vault = temporaryVault();
    const client = new Client({ name: "cortex-stdio-test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "src/cli.ts", "mcp", "--vault", vault],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("vault_check");
      const result = await client.callTool({ name: "vault_check", arguments: {} });
      expect(structured(result).ok).toBe(true);
    } finally {
      await client.close();
    }
  }, 15_000);
});
