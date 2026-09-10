import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { parseFrontmatter } from "./frontmatter.js";
import type { Diagnostic, Section, SourceLocation, TableData, Wikilink } from "./types.js";
import type { ParsedNote } from "./types.js";

const SECTION_MARKER_RE = /^\s*<!--\s*cortex:section\s+id="(sec-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"\s*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function lineLocation(lineIndex: number, characterIndex: number, lineOffset: number): SourceLocation {
  return { line: lineIndex + 1 + lineOffset, column: characterIndex + 1 };
}

// Inline code spans are prose about syntax, not links: `[[Note Title]]` must not index as a
// wikilink. A backtick run opens a span and the next run of the same length closes it.
function inlineCodeRanges(line: string): Array<[number, number]> {
  const runs = Array.from(line.matchAll(/`+/g), (match) => ({ index: match.index ?? 0, length: match[0].length }));
  const ranges: Array<[number, number]> = [];
  let index = 0;

  while (index < runs.length) {
    const opener = runs[index];
    const closer = runs.findIndex((run, position) => position > index && run.length === opener.length);
    if (closer === -1) {
      index += 1;
      continue;
    }
    ranges.push([opener.index, runs[closer].index + runs[closer].length]);
    index = closer + 1;
  }

  return ranges;
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

    const codeRanges = inlineCodeRanges(line);
    for (const match of line.matchAll(WIKILINK_RE)) {
      const start = match.index ?? 0;
      if (codeRanges.some(([from, to]) => start >= from && start + match[0].length <= to)) continue;
      const raw = match[1].trim();
      const [beforeDisplay, display] = raw.split("|", 2);
      const [target, section] = beforeDisplay.split("#", 2);
      if (!target.trim()) continue;
      links.push({
        target: target.trim(),
        section: section?.trim() || undefined,
        display: display?.trim() || undefined,
        location: lineLocation(lineIndex, start, lineOffset),
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

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTables(body: string, sections: Section[], lineOffset: number): TableData[] {
  const lines = body.split(/\r?\n/);
  const tables: TableData[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes("|") || !isTableDelimiter(lines[index + 1])) continue;
    const headers = splitTableRow(lines[index]);
    const rows: string[][] = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length && lines[rowIndex].trim() && lines[rowIndex].includes("|")) {
      rows.push(splitTableRow(lines[rowIndex]));
      rowIndex += 1;
    }
    const absoluteLine = index + 1 + lineOffset;
    const sectionId = sections.find((section) => section.startLine <= absoluteLine && absoluteLine <= section.endLine)?.id;
    tables.push({ sectionId, headers, rows, startLine: absoluteLine });
    index = rowIndex - 1;
  }
  return tables;
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
    tables: parseTables(parsedFrontmatter.body, sectionResult.sections, parsedFrontmatter.bodyLineOffset),
    diagnostics,
    body: parsedFrontmatter.body,
  };
}

export type SectionSelector = {
  id?: string;
  heading?: string;
};

export type SectionRange = {
  lines: string[];
  start: number;
  end: number;
  marker: number;
  bodyStart: number;
};

export type ReadableSectionRange = Omit<SectionRange, "marker"> & {
  marker?: number;
};

/** Return all sections matching an ID or case-insensitive heading selector. */
export function findSections(parsed: ParsedNote, selector: SectionSelector): Section[] {
  if (selector.id) return parsed.sections.filter((section) => section.id === selector.id);
  if (selector.heading === undefined) return [];
  const heading = selector.heading.toLocaleLowerCase();
  return parsed.sections.filter((section) => section.heading.toLocaleLowerCase() === heading);
}

/**
 * Locate the canonical writable range for a parsed section.
 *
 * Section.endLine comes from parseSections, which ends a section at the next
 * heading of the same or lower level. Keeping the range calculation here means
 * patching and reconciliation use the same hierarchy-aware document model.
 */
export function locateSection(text: string, section: Section, directBody = false): SectionRange | undefined {
  const range = locateReadableSection(text, section, directBody);
  if (range.marker === undefined) return undefined;
  return range as SectionRange;
}

/**
 * Locate a section for reading. Unlike locateSection, this range does not
 * require a Cortex marker. A marker is a write protocol, not a prerequisite
 * for inspecting Markdown authored outside Cortex.
 */
export function locateReadableSection(text: string, section: Section, directBody = false): ReadableSectionRange {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(0, section.startLine - 1);
  const hierarchicalEnd = Math.min(Math.max(start, section.endLine), lines.length);
  const directEnd = lines.slice(start + 1, hierarchicalEnd).findIndex((line) => HEADING_RE.test(line));
  const end = directBody && directEnd >= 0 ? start + 1 + directEnd : hierarchicalEnd;
  // A marker belongs to this heading only when it is the first non-empty line
  // after that heading. Scanning the complete hierarchy range would mistake a
  // child section's marker for a writable marker on a markerless parent.
  let marker: number | undefined;
  let markerIndex = start + 1;
  while (markerIndex < hierarchicalEnd && lines[markerIndex]!.trim() === "") markerIndex += 1;
  if (markerIndex < hierarchicalEnd && SECTION_MARKER_RE.test(lines[markerIndex]!)) marker = markerIndex;
  return { lines, start, end, marker, bodyStart: marker === undefined ? start + 1 : marker + 1 };
}

/** Extract a section body using the canonical marker and hierarchy-aware range. */
export function getSectionBody(text: string, section: Section, trim = false, directBody = false): string | undefined {
  const range = locateSection(text, section, directBody);
  if (!range) return undefined;
  const body = range.lines.slice(range.bodyStart, range.end).join("\n");
  return trim ? body.replace(/^\n+|\n+$/g, "") : body;
}

/** Extract a section body whether or not the section has a writable marker. */
export function getReadableSectionBody(text: string, section: Section, trim = false, directBody = false): string {
  const range = locateReadableSection(text, section, directBody);
  const body = range.lines.slice(range.bodyStart, range.end).join("\n");
  return trim ? body.replace(/^\n+|\n+$/g, "") : body;
}

/**
 * Insert the write marker for one uniquely selected markerless section.
 * Callers are responsible for revision checks and write serialization.
 */
export function insertSectionMarker(text: string, section: Section, id = `sec-${crypto.randomUUID()}`): { text: string; id: string; inserted: boolean } {
  const range = locateReadableSection(text, section);
  if (range.marker !== undefined) return { text, id: section.id ?? id, inserted: false };
  const lines = range.lines;
  const insertionPoint = range.start + 1;
  lines.splice(insertionPoint, 0, `<!-- cortex:section id="${id}" -->`);
  return { text: lines.join("\n"), id, inserted: true };
}

/** Extract only the content owned directly by a section, excluding child headings. */
export function getSectionDirectBody(text: string, section: Section, trim = false): string | undefined {
  return getSectionBody(text, section, trim, true);
}

/**
 * Replace a section body while preserving the marker and all content outside
 * the section. A section ID or parsed Section may be supplied; an ID is
 * resolved against the current document so sequential replacements remain
 * safe after earlier changes.
 */
export function replaceSectionBody(text: string, section: Section | string, body: string, directBody = false): string {
  const parsed = parseMarkdown(text);
  const resolved = typeof section === "string"
    ? parsed.sections.find((candidate) => candidate.id === section)
    : parsed.sections.find((candidate) => candidate.id === section.id);
  if (!resolved) return text;
  const range = locateSection(text, resolved, directBody);
  if (!range) return text;
  const normalizedBody = body.replace(/\r\n/g, "\n");
  const replacement = normalizedBody.length === 0 ? [] : normalizedBody.split("\n");
  return [...range.lines.slice(0, range.bodyStart), ...replacement, ...range.lines.slice(range.end)].join("\n");
}

/** Replace only a section's direct body, preserving nested child sections. */
export function replaceSectionDirectBody(text: string, section: Section | string, body: string): string {
  return replaceSectionBody(text, section, body, true);
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
