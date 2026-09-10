import { describe, expect, test } from "bun:test";
import { ServiceError } from "../src/core/errors.js";
import { McpIngressError, normalizeMcpArguments } from "../src/mcp/adapter.js";
import { MCP_MAX_RESULT_BYTES, projectMcpResult } from "../src/mcp/projection.js";
import { z } from "zod";

describe("MCP compatibility contract", () => {
  test("normalizes supported historical fields and emits a canonical warning", () => {
    const normalized = normalizeMcpArguments("get_note", { path: "notes/example.md" }, z.object({ note: z.string().min(1) }));
    expect(normalized.args).toEqual({ note: "notes/example.md" });
    expect(normalized.warnings).toEqual([expect.objectContaining({ code: "DEPRECATED_FIELD", field: "path", canonical_field: "note" })]);
  });

  test("covers the observed selector, section, body, revision, and hash aliases", () => {
    const note = normalizeMcpArguments("get_note", { note_id: "123" }, z.object({ note: z.string().min(1) }));
    expect(note.args).toEqual({ note: "123" });
    expect(note.warnings[0]).toEqual(expect.objectContaining({ field: "note_id", canonical_field: "note" }));

    const section = normalizeMcpArguments(
      "get_section",
      { note: "notes/example.md", section: "sec-example" },
      z.object({ note: z.string().min(1), section_id: z.string().min(1) }),
    );
    expect(section.args).toEqual({ note: "notes/example.md", section_id: "sec-example" });
    expect(section.warnings).toEqual([expect.objectContaining({ field: "section", canonical_field: "section_id" })]);

    const patch = normalizeMcpArguments(
      "patch_section",
      { path: "notes/example.md", section: "sec-example", revision: "rev-1", content: "updated" },
      z.object({ note: z.string().min(1), section_id: z.string().min(1), expected_revision: z.string().min(1), new_content: z.string() }),
    );
    expect(patch.args).toEqual({ note: "notes/example.md", section_id: "sec-example", expected_revision: "rev-1", new_content: "updated" });
    expect(patch.warnings.map((warning) => warning.field)).toEqual(["path", "revision", "content", "section"]);

    const replacement = normalizeMcpArguments(
      "replace_note",
      { path: "notes/example.md", expected_hash: "hash-1", content: "# Updated" },
      z.object({ note: z.string().min(1), expected_file_hash: z.string().min(1), markdown: z.string() }),
    );
    expect(replacement.args).toEqual({ note: "notes/example.md", expected_file_hash: "hash-1", markdown: "# Updated" });
  });

  test("accepts equal canonical and legacy duplicates but rejects conflicting values", () => {
    const equal = normalizeMcpArguments("get_note", { note: "notes/example.md", path: "notes/example.md" }, z.object({ note: z.string().min(1) }));
    expect(equal.args).toEqual({ note: "notes/example.md" });
    expect(equal.warnings).toHaveLength(1);

    expect(() => normalizeMcpArguments("get_note", { note: "notes/one.md", path: "notes/two.md" }, z.object({ note: z.string().min(1) }))).toThrow(McpIngressError);
    try {
      normalizeMcpArguments("get_note", { note: "notes/one.md", path: "notes/two.md" }, z.object({ note: z.string().min(1) }));
    } catch (cause) {
      expect(cause).toBeInstanceOf(ServiceError);
      expect((cause as ServiceError).code).toBe("INVALID_INPUT");
      expect((cause as McpIngressError).details?.conflicting_fields).toEqual(["note", "path"]);
    }
  });

  test("turns malformed and unknown arguments into Cortex-owned structured input errors", () => {
    const schema = z.object({ note: z.string().min(1) });
    expect(() => normalizeMcpArguments("get_note", { note: 42 }, schema)).toThrow(McpIngressError);
    expect(() => normalizeMcpArguments("get_note", { note: "notes/example.md", unexpected: true }, schema)).toThrow(McpIngressError);
    expect(() => normalizeMcpArguments("get_note", "not an object", schema)).toThrow(McpIngressError);
  });

  test("projects writes to a bounded receipt and graph responses stay closed", () => {
    const receipt = projectMcpResult("patch_section", {
      path: "notes/example.md",
      mtime: "2026-09-10T00:00:00.000Z",
      content_hash: "a".repeat(64),
      changed_sections: ["sec-example"],
      index: {
        mode: "incremental",
        changedPaths: ["notes/example.md"],
        noteCount: 1,
        sectionCount: 1,
        linkCount: 0,
        tableRowCount: 0,
        graphNodeCount: 1,
        graphEdgeCount: 0,
        diagnostics: [{ severity: "warning", code: "example", message: "ignored" }],
        durationMs: 3,
        work: { changedFilesRead: 1 },
      },
    }) as {
      persisted: boolean;
      index: { work: Record<string, unknown>; durationMs: number };
      content_hash: string;
    };
    expect(receipt.persisted).toBe(true);
    expect(receipt.index.work).toEqual({ changedFilesRead: 1 });
    expect(receipt.index.durationMs).toBe(3);
    expect(receipt.content_hash).toHaveLength(64);

    const graph = projectMcpResult("project_map", {
      anchor: { nodeId: "repo:cortex", kind: "repository", name: "cortex" },
      nodes: [{ nodeId: "file:cortex:src/index.ts", kind: "module", name: "index.ts" }],
      edges: [{ fromId: "repo:cortex", toId: "missing", kind: "contains", metadata: {} }],
      truncated: true,
    });
    expect(graph.edges).toEqual([]);
    expect(graph.omitted_edges).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(graph), "utf8")).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES);
  });
});
