import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createFrontmatter, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { addMissingSectionMarkers } from "./markdown.js";
import { scanVault } from "./vault.js";

export type MigrationChange = {
  filePath: string;
  changed: boolean;
  reasons: string[];
  nextContent?: string;
};

function titleFromBody(body: string, filePath: string): string {
  const heading = body.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : basename(filePath, ".md").replace(/[-_]/g, " ");
}

export function planMigration(vaultRoot: string): MigrationChange[] {
  const scan = scanVault(vaultRoot);
  return scan.files.map((filePath) => {
    const original = readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(original);
    const reasons: string[] = [];
    let body = parsed.body;
    let frontmatter = parsed.frontmatter;

    if (!frontmatter) {
      frontmatter = createFrontmatter({ title: titleFromBody(body, filePath) });
      reasons.push("add frontmatter");
    } else {
      const next = { ...frontmatter };
      if (!next.id) { next.id = crypto.randomUUID(); reasons.push("add id"); }
      if (!next.title) { next.title = titleFromBody(body, filePath); reasons.push("add title"); }
      if (!next.type) { next.type = "note"; reasons.push("add type"); }
      if (!next.created_at) { next.created_at = new Date().toISOString(); reasons.push("add created_at"); }
      if (!next.updated_at) { next.updated_at = next.created_at; reasons.push("add updated_at"); }
      if (!("aliases" in parsed.raw)) { next.aliases = []; reasons.push("add aliases"); }
      frontmatter = next;
    }

    const markerResult = addMissingSectionMarkers(body);
    if (markerResult.added.length > 0) {
      body = markerResult.body;
      reasons.push(`add ${markerResult.added.length} section marker(s)`);
    }
    const nextContent = reasons.length > 0 ? serializeFrontmatter(frontmatter) + body : original;
    return { filePath, changed: reasons.length > 0, reasons, nextContent };
  });
}

export function migrateVault(vaultRoot: string, dryRun: boolean): MigrationChange[] {
  const changes = planMigration(vaultRoot);
  if (!dryRun) {
    for (const change of changes) {
      if (change.changed && change.nextContent !== undefined) writeFileSync(change.filePath, change.nextContent);
    }
  }
  return changes;
}
