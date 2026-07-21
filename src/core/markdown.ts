import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { parseFrontmatter } from "./frontmatter.js";
import type { Diagnostic, Section, SourceLocation, Wikilink } from "./types.js";
import type { ParsedNote } from "./types.js";

const SECTION_MARKER_RE = /^\s*<!--\s*cortex:section\s+id="(sec-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\s*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function lineLocation(lines: string[], lineIndex: number, characterIndex: number, lineOffset: number): SourceLocation {
  return { line: lineIndex + 1 + lineOffset, column: characterIndex + 1 };
}

function parseWikilinks(body: string, lineOffset: number): Wikilink[] {
  const links: Wikilink[] = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceCharacter = "";

  lines.forEach((line, lineIndex) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const character = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceCharacter = character;
      } else if (fenceCharacter === character) {
        inFence = false;
      }
      return;
    }
    if (inFence) return;

    for (const match of line.matchAll(WIKILINK_RE)) {
      const raw = match[1].trim();
      const [beforeDisplay, display] = raw.split("|", 2);
      const [target, section] = beforeDisplay.split("#", 2);
      if (!target.trim()) continue;
      links.push({
        target: target.trim(),
        section: section?.trim() || undefined,
        display: display?.trim() || undefined,
        location: lineLocation(lines, lineIndex, match.index ?? 0, lineOffset),
      });
    }
  });

  return links;
}

function revision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseSections(text: string, lineOffset: number): { sections: Section[]; diagnostics: Diagnostic[] } {
  const lines = text.split(/\r?\n/);
  const headings: Array<{ lineIndex: number; level: number; heading: string }> = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = line.match(HEADING_RE);
    if (match) headings.push({ lineIndex, level: match[1].length, heading: match[2].trim() });
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const sections: Section[] = headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLineIndex = next?.lineIndex ?? lines.length;
    let markerIndex = heading.lineIndex + 1;
    while (markerIndex < endLineIndex && lines[markerIndex].trim() === "") markerIndex += 1;
    const marker = markerIndex < endLineIndex ? lines[markerIndex].match(SECTION_MARKER_RE) : undefined;
    const id = marker?.[1];
    if (!id) diagnostics.push({ severity: "warning", code: "missing-section-id", message: `Heading '${heading.heading}' has no section ID.`, line: heading.lineIndex + 1 + lineOffset });
    if (id && seen.has(id)) diagnostics.push({ severity: "error", code: "duplicate-section-id", message: `Section ID '${id}' is duplicated.`, line: markerIndex + 1 + lineOffset });
    if (id) seen.add(id);
    const content = lines.slice(heading.lineIndex, endLineIndex).join("\n");
    return {
      id,
      level: heading.level,
      heading: heading.heading,
      startLine: heading.lineIndex + 1 + lineOffset,
      endLine: endLineIndex + lineOffset,
      revision: revision(content),
    };
  });

  return { sections, diagnostics };
}

export function parseMarkdown(text: string, filePath?: string): ParsedNote {
  const parsedFrontmatter = parseFrontmatter(text);
  const diagnostics = parsedFrontmatter.diagnostics.map((item) => ({ ...item, filePath }));
  try {
    unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(text);
  } catch (cause) {
    diagnostics.push({ severity: "error", code: "invalid-markdown", message: cause instanceof Error ? cause.message : String(cause), filePath });
  }
  const sectionResult = parseSections(parsedFrontmatter.body, parsedFrontmatter.bodyLineOffset);
  diagnostics.push(...sectionResult.diagnostics.map((item) => ({ ...item, filePath })));
  return {
    filePath,
    frontmatter: parsedFrontmatter.frontmatter,
    wikilinks: parseWikilinks(parsedFrontmatter.body, parsedFrontmatter.bodyLineOffset),
    sections: sectionResult.sections,
    diagnostics,
    body: parsedFrontmatter.body,
  };
}

export function addMissingSectionMarkers(body: string): { body: string; added: string[] } {
  const lines = body.split(/\r?\n/);
  const added: string[] = [];
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    output.push(line);
    const heading = line.match(HEADING_RE);
    if (!heading) {
      index += 1;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead += 1;
    if (lookahead < lines.length && SECTION_MARKER_RE.test(lines[lookahead])) {
      index += 1;
      continue;
    }
    const id = `sec-${crypto.randomUUID()}`;
    added.push(id);
    if (index + 1 < lines.length && lines[index + 1].trim() === "") output.push(lines[index + 1]);
    output.push(`<!-- cortex:section id="${id}" -->`);
    index += 1;
  }
  return { body: output.join("\n"), added };
}
