import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { parseMarkdown } from "./markdown.js";
import type { Diagnostic, VaultScan } from "./types.js";

export const RUNTIME_DIRECTORY = ".cortex";

export function isGitVault(vaultRoot: string): boolean {
  return existsSync(join(resolve(vaultRoot), ".git"));
}

export function requireGitVault(vaultRoot: string): string {
  const root = resolve(vaultRoot);
  if (!isGitVault(root)) throw new Error(`Vault is not a Git repository: ${root}`);
  return root;
}

function markdownFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === RUNTIME_DIRECTORY || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

export function scanVault(vaultRoot: string): VaultScan {
  const root = requireGitVault(vaultRoot);
  const files = markdownFiles(root);
  const notes = files.map((filePath) => parseMarkdown(readFileSync(filePath, "utf8"), filePath));
  const diagnostics: Diagnostic[] = [];
  for (const note of notes) diagnostics.push(...note.diagnostics);

  const knownTitles = new Map<string, string>();
  for (const note of notes) {
    if (!note.frontmatter) continue;
    const values = [note.frontmatter.title, ...note.frontmatter.aliases];
    for (const value of values) knownTitles.set(value.toLocaleLowerCase(), note.filePath ?? "");
  }
  for (const note of notes) {
    if (note.frontmatter) {
      for (const attachment of note.frontmatter.applies_to) {
        // Targets naming a workspace repository resolve against that repository's root,
        // not the vault, and are validated by resolveWorkspaceAttachments instead.
        if (attachment.repository) continue;
        const targetPath = attachment.target.split("#", 1)[0];
        const absoluteTarget = join(root, targetPath || ".");
        if (!existsSync(absoluteTarget)) {
          diagnostics.push({ severity: "warning", code: "invalid-applies-to-target", message: `Attachment target '${attachment.target}' does not exist.`, filePath: note.filePath });
        }
      }
    }
    for (const link of note.wikilinks) {
      if (!knownTitles.has(link.target.toLocaleLowerCase())) {
        diagnostics.push({ severity: "warning", code: "unresolved-wikilink", message: `Unresolved wikilink '${link.target}'.`, filePath: note.filePath, line: link.location.line, column: link.location.column });
      }
    }
  }

  return {
    vaultRoot: root,
    files,
    notes,
    noteCount: notes.length,
    linkCount: notes.reduce((count, note) => count + note.wikilinks.length, 0),
    sectionCount: notes.reduce((count, note) => count + note.sections.length, 0),
    diagnostics,
  };
}

export function initVault(targetPath: string): string {
  const root = resolve(targetPath);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`Refusing to initialize non-empty directory: ${root}`);
  mkdirSync(root, { recursive: true });
  const git = spawnSync("git", ["init", root], { encoding: "utf8" });
  if (git.status !== 0) throw new Error(git.stderr || "git init failed");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), `${RUNTIME_DIRECTORY}/\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n*.log\n*.lock\n`);

  const map = createFrontmatter({ title: "Project Map", type: "map", tags: ["architecture"] });
  const note = createFrontmatter({ title: "Engine Notes", type: "note", aliases: ["Backend Notes"] });
  const mapBody = `# Project Map\n\n<!-- cortex:section id="sec-${crypto.randomUUID()}" -->\n\nThis vault describes the project structure. See [[Engine Notes]].\n`;
  const noteBody = `# Engine Notes\n\n<!-- cortex:section id="sec-${crypto.randomUUID()}" -->\n\nThe Bun backend owns parsing and vault diagnostics.\n`;
  writeFileSync(join(root, "project-map.md"), serializeFrontmatter(map) + mapBody);
  writeFileSync(join(root, "notes", "engine.md"), serializeFrontmatter(note) + noteBody);
  return root;
}

export function vaultHasExpectedGitIgnore(vaultRoot: string): boolean {
  const path = join(requireGitVault(vaultRoot), ".gitignore");
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  return content.includes(`${RUNTIME_DIRECTORY}/`) && content.includes("*.sqlite");
}
