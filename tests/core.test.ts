import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrontmatter, parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { directoryNodeId, fileNodeId, noteNodeId, projectNodeId, repositoryRelativePath } from "../src/core/identity.js";
import { addMissingSectionMarkers, findSections, getSectionBody, parseMarkdown, replaceSectionBody } from "../src/core/markdown.js";
import { reconcileMarkdown } from "../src/core/reconcile.js";
import { migrateVault } from "../src/core/migration.js";
import { initVault, scanVault } from "../src/core/vault.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "cortex-phase0-"));
}

describe("frontmatter", () => {
  test("parses strict managed metadata and preserves unknown keys", () => {
    const parsed = parseFrontmatter(`---\nid: 11111111-1111-4111-8111-111111111111\ntitle: Search\ntype: note\ncreated_at: 2026-07-22T00:00:00.000Z\nupdated_at: 2026-07-22T00:00:00.000Z\ncustom: value\n---\nBody`);
    expect(parsed.frontmatter?.title).toBe("Search");
    expect(parsed.frontmatter?.extra.custom).toBe("value");
    expect(parsed.diagnostics.some((item) => item.code === "unknown-frontmatter-key")).toBe(true);
    expect(parsed.body).toBe("Body");
  });

  test("rejects missing and invalid required fields", () => {
    const parsed = parseFrontmatter("---\ntitle: Missing\ntype: wrong\n---\nBody");
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.diagnostics.some((item) => item.code === "missing-id")).toBe(true);
    expect(parsed.diagnostics.some((item) => item.code === "invalid-type")).toBe(true);
  });

  test("creates valid UUID and UTC timestamps", () => {
    const frontmatter = createFrontmatter({ title: "Created" });
    expect(frontmatter.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(frontmatter.created_at.endsWith("Z")).toBe(true);
    expect(serializeFrontmatter(frontmatter)).toContain("type: note");
  });
});

describe("markdown", () => {
  test("extracts supported wikilinks and ignores fenced code", () => {
    const note = parseMarkdown(`# Links\n\n[[A]] [[B#Section|shown]]\n\n\`\`\`md\n[[Ignored]]\n\`\`\``);
    expect(note.wikilinks).toEqual([
      { target: "A", section: undefined, display: undefined, location: { line: 3, column: 1 } },
      { target: "B", section: "Section", display: "shown", location: { line: 3, column: 7 } },
    ]);
  });

  test("ignores wikilinks inside inline code spans", () => {
    const note = parseMarkdown("# Links\n\nUse `[[Note Title]]` for crosslinks, see [[Real]].\n\nAlso `.md` plus `[[links]]` parse.\n");
    expect(note.wikilinks.map((link) => link.target)).toEqual(["Real"]);
  });

  test("still extracts wikilinks around unpaired backticks", () => {
    const note = parseMarkdown("# Links\n\nA ` stray backtick and [[Kept]].\n");
    expect(note.wikilinks.map((link) => link.target)).toEqual(["Kept"]);
  });

  test("extracts section IDs, revisions, and duplicate errors", () => {
    const note = parseMarkdown(`# One\n\n<!-- cortex:section id="sec-11111111-1111-4111-8111-111111111111" -->\n\nText\n\n## Two\n\n<!-- cortex:section id="sec-11111111-1111-4111-8111-111111111111" -->`);
    expect(note.sections).toHaveLength(2);
    expect(note.sections[0].revision).toMatch(/^[0-9a-f]{64}$/);
    expect(note.diagnostics.some((item) => item.code === "duplicate-section-id")).toBe(true);
  });

  test("adds missing section markers without changing non-heading content", () => {
    const result = addMissingSectionMarkers("# One\n\nText\n\n## Two\n\nMore");
    expect(result.added).toHaveLength(2);
    expect(result.body).toContain("cortex:section id=\"sec-");
    expect(result.body).toContain("Text");
    expect(result.body).toContain("More");
  });

  test("uses hierarchy-aware section ranges for nested headings", () => {
    const text = [
      "# Parent",
      "",
      "<!-- cortex:section id=\"sec-11111111-1111-4111-8111-111111111111\" -->",
      "",
      "Parent body",
      "",
      "## Child",
      "",
      "<!-- cortex:section id=\"sec-22222222-2222-4222-8222-222222222222\" -->",
      "",
      "Child body",
      "",
      "# Sibling",
      "",
      "<!-- cortex:section id=\"sec-33333333-3333-4333-8333-333333333333\" -->",
      "",
      "Sibling body",
    ].join("\n");
    const parsed = parseMarkdown(text);
    const parent = findSections(parsed, { id: "sec-11111111-1111-4111-8111-111111111111" });
    expect(parent).toHaveLength(1);
    expect(getSectionBody(text, parent[0], true)).toContain("Child body");
    expect(getSectionBody(text, parent[0], true)).not.toContain("Sibling body");

    const child = findSections(parsed, { id: "sec-22222222-2222-4222-8222-222222222222" });
    expect(child).toHaveLength(1);
    const replaced = replaceSectionBody(text, child[0], "Updated child");
    expect(replaced).toContain("Updated child");
    expect(replaced).toContain("Parent body");
    expect(replaced).toContain("## Child");
    expect(replaced).toContain("Sibling body");
  });

  test("reconciliation uses the same nested section ranges", () => {
    const base = [
      "---",
      "id: 77777777-7777-4777-8777-777777777777",
      "title: Nested merge",
      "type: note",
      "created_at: 2026-01-01T00:00:00Z",
      "updated_at: 2026-01-01T00:00:00Z",
      "---",
      "",
      "# Parent",
      "",
      "<!-- cortex:section id=\"sec-44444444-4444-4444-8444-444444444444\" -->",
      "",
      "Parent body",
      "",
      "## Child",
      "",
      "<!-- cortex:section id=\"sec-55555555-5555-4555-8555-555555555555\" -->",
      "",
      "Child body",
      "",
      "# Sibling",
      "",
      "<!-- cortex:section id=\"sec-66666666-6666-4666-8666-666666666666\" -->",
      "",
      "Sibling body",
    ].join("\n");
    const local = base.replace("Child body", "Local child");
    const remote = base.replace("Sibling body", "Remote sibling");
    const result = reconcileMarkdown(base, local, remote);
    expect(result.status).toBe("merged");
    if (result.status === "merged") {
      expect(result.markdown).toContain("Local child");
      expect(result.markdown).toContain("Remote sibling");
      expect(result.markdown).toContain("# Sibling");
    }
  });
});

describe("identities and vaults", () => {
  test("normalizes repository-relative node IDs", () => {
    const root = "/tmp/project";
    expect(repositoryRelativePath(root, "/tmp/project/src/index.ts")).toBe("src/index.ts");
    expect(projectNodeId()).toBe("project:root");
    expect(directoryNodeId(root, "/tmp/project/src")).toBe("dir:src");
    expect(fileNodeId(root, "/tmp/project/src/index.ts")).toBe("file:src/index.ts");
    expect(noteNodeId("abc")).toBe("note:abc");
  });

  test("initializes a separate Git vault and scans the sample content", () => {
    const root = initVault(join(temporaryDirectory(), "vault"));
    const scan = scanVault(root);
    expect(scan.noteCount).toBe(2);
    expect(scan.linkCount).toBe(1);
    expect(scan.sectionCount).toBe(2);
    expect(scan.diagnostics.some((item) => item.code === "unresolved-wikilink")).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".cortex/");
  });

  test("migration is reviewable, idempotent, and supports dry-run", () => {
    const root = initVault(join(temporaryDirectory(), "vault"));
    const legacyPath = join(root, "legacy.md");
    writeFileSync(legacyPath, "# Legacy Note\n\n[[Project Map]]\n");
    const dryRun = migrateVault(root, true);
    const legacyDryRun = dryRun.find((change) => change.filePath === legacyPath);
    expect(legacyDryRun?.changed).toBe(true);
    expect(readFileSync(legacyPath, "utf8")).not.toContain("id:");

    migrateVault(root, false);
    const migrated = readFileSync(legacyPath, "utf8");
    expect(migrated).toContain("id:");
    expect(migrated).toContain("cortex:section id=\"sec-");
    const second = migrateVault(root, true).find((change) => change.filePath === legacyPath);
    expect(second?.changed).toBe(false);
  });

  test("reports unresolved links and invalid attachment targets", () => {
    const root = initVault(join(temporaryDirectory(), "vault"));
    const frontmatter = createFrontmatter({
      title: "Broken Note",
      applies_to: [{ target: "missing/file.ts", relation: "documents" }],
    });
    writeFileSync(join(root, "broken.md"), `${serializeFrontmatter(frontmatter)}# Broken Note\n\n[[Missing Note]]\n`);
    const scan = scanVault(root);
    expect(scan.diagnostics.some((item) => item.code === "unresolved-wikilink")).toBe(true);
    expect(scan.diagnostics.some((item) => item.code === "invalid-applies-to-target")).toBe(true);
  });

  test("resolves a wikilink written as the target's filename stem, without a matching alias", () => {
    const root = initVault(join(temporaryDirectory(), "vault"));
    const target = createFrontmatter({ title: "Something Else Entirely" });
    writeFileSync(join(root, "notes", "my-target-note.md"), `${serializeFrontmatter(target)}# Something Else Entirely\n\nBody.\n`);
    const linker = createFrontmatter({ title: "Linker Note" });
    writeFileSync(join(root, "linker.md"), `${serializeFrontmatter(linker)}# Linker Note\n\n[[my-target-note]]\n`);
    const scan = scanVault(root);
    expect(scan.diagnostics.some((item) => item.code === "unresolved-wikilink")).toBe(false);
  });

  test("does not flag attachment targets that belong to a workspace repository", () => {
    const root = initVault(join(temporaryDirectory(), "vault"));
    const frontmatter = createFrontmatter({
      title: "Repo Note",
      // A repository-scoped target resolves against that repository's root, so checking
      // it against the vault would always fail and produce a permanent false warning.
      applies_to: [{ target: "src/core/workspace.ts", relation: "documents", repository: "cortex" }],
    });
    writeFileSync(join(root, "repo-note.md"), `${serializeFrontmatter(frontmatter)}# Repo Note\n\nBody.\n`);
    const scan = scanVault(root);
    expect(scan.diagnostics.some((item) => item.code === "invalid-applies-to-target")).toBe(false);
  });
});
