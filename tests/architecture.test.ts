import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (extname(entry.name) === ".ts") files.push(path);
  }
  return files;
}

describe("architecture guardrails", () => {
  test("runtime and adapter production code use semantic projection reads", () => {
    const production = [
      ...sourceFiles(join(projectRoot, "src", "mcp")),
      ...sourceFiles(join(projectRoot, "src", "api")),
      join(projectRoot, "src", "core", "runtime.ts"),
      join(projectRoot, "src", "core", "claude-context.ts"),
    ];
    for (const path of production) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toContain("store.db");
      expect(source, path).not.toMatch(/\.db\.(?:query|run)/);
    }
  });

  test("core and adapters stay independent of the wire-contract module", () => {
    for (const directory of [join(projectRoot, "src", "core"), join(projectRoot, "src", "mcp"), join(projectRoot, "src", "api")]) {
      for (const path of sourceFiles(directory)) {
        expect(readFileSync(path, "utf8"), path).not.toContain("api/contracts");
      }
    }
  });

  test("runtime ownership and graph/Markdown seams remain singular", () => {
    expect(existsSync(join(projectRoot, "src", "mcp", "service.ts"))).toBe(false);
    const workspaceIndexer = readFileSync(join(projectRoot, "src", "core", "workspace-indexer.ts"), "utf8");
    expect(workspaceIndexer).not.toContain("IMPORT_RE");
    expect(workspaceIndexer).not.toContain("function buildGraph");
    const reconcile = readFileSync(join(projectRoot, "src", "core", "reconcile.ts"), "utf8");
    expect(reconcile).not.toContain("sectionDirectEnd");
    expect(reconcile).not.toContain("SECTION_MARKER_RE");
  });
});
