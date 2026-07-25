import { parseMarkdown } from "./markdown.js";

export type ReconcileResult =
  | { status: "merged"; markdown: string; changedSections: string[] }
  | { status: "conflict"; conflicts: string[] };

type SectionBody = { id: string; body: string };

function markedSections(markdown: string): Map<string, SectionBody> {
  const parsed = parseMarkdown(markdown);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections = new Map<string, SectionBody>();
  for (const section of parsed.sections) {
    if (!section.id) continue;
    const start = section.startLine - 1;
    const end = sectionDirectEnd(lines, start, section.level);
    const marker = lines.slice(start + 1, end).findIndex((line) => /^\s*<!--\s*cortex:section\s+id="sec-[0-9a-f-]+"\s*-->\s*$/i.test(line));
    if (marker < 0) continue;
    sections.set(section.id, {
      id: section.id,
      body: lines.slice(start + 1 + marker + 1, end).join("\n"),
    });
  }
  return sections;
}

function sectionDirectEnd(lines: string[], start: number, _level: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading) return index;
  }
  return lines.length;
}

function outsideHead(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => /^#{1,6}\s+/.test(line));
  return (heading < 0 ? lines : lines.slice(0, heading)).join("\n");
}

function sectionIds(markdown: string): Set<string> {
  return new Set(markedSections(markdown).keys());
}

function hasStructuralDiagnostics(markdown: string): boolean {
  return parseMarkdown(markdown).diagnostics.some((item) =>
    item.severity === "error" || item.code === "missing-section-id" || item.code === "duplicate-section-id",
  );
}

function replaceSectionBody(markdown: string, sectionId: string, body: string): string {
  const parsed = parseMarkdown(markdown);
  const section = parsed.sections.find((item) => item.id === sectionId);
  if (!section) return markdown;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = section.startLine - 1;
  const end = sectionDirectEnd(lines, start, section.level);
  const marker = lines.slice(start + 1, end).findIndex((line) => /^\s*<!--\s*cortex:section\s+id="sec-[0-9a-f-]+"\s*-->\s*$/i.test(line));
  if (marker < 0) return markdown;
  const markerLine = start + 1 + marker;
  const replacement = body.length === 0 ? [] : body.split("\n");
  return [...lines.slice(0, markerLine + 1), ...replacement, ...lines.slice(end)].join("\n");
}

export function reconcileMarkdown(base: string, local: string, remote: string): ReconcileResult {
  if (hasStructuralDiagnostics(base) || hasStructuralDiagnostics(local) || hasStructuralDiagnostics(remote)) {
    return { status: "conflict", conflicts: ["document-structure"] };
  }

  const baseIds = sectionIds(base);
  const localIds = sectionIds(local);
  const remoteIds = sectionIds(remote);
  if (baseIds.size !== localIds.size || baseIds.size !== remoteIds.size || [...baseIds].some((id) => !localIds.has(id) || !remoteIds.has(id))) {
    return { status: "conflict", conflicts: ["section-structure"] };
  }

  const baseSections = markedSections(base);
  const localSections = markedSections(local);
  const remoteSections = markedSections(remote);
  const conflicts: string[] = [];
  const localChanged = new Set<string>();
  const remoteChanged = new Set<string>();

  for (const id of baseIds) {
    const baseBody = baseSections.get(id)?.body;
    const localBody = localSections.get(id)?.body;
    const remoteBody = remoteSections.get(id)?.body;
    if (localBody !== baseBody) localChanged.add(id);
    if (remoteBody !== baseBody) remoteChanged.add(id);
    if (localBody !== baseBody && remoteBody !== baseBody && localBody !== remoteBody) conflicts.push(id);
  }

  const baseHead = outsideHead(base);
  const localHead = outsideHead(local);
  const remoteHead = outsideHead(remote);
  const localHeadChanged = localHead !== baseHead;
  const remoteHeadChanged = remoteHead !== baseHead;
  if (localHeadChanged && remoteHeadChanged && localHead !== remoteHead) conflicts.push("frontmatter-or-preamble");
  if ((localHeadChanged && remoteChanged.size > 0) || (remoteHeadChanged && localChanged.size > 0)) conflicts.push("mixed-structure");
  if (conflicts.length > 0) return { status: "conflict", conflicts: [...new Set(conflicts)] };

  let merged = local;
  const changedSections: string[] = [];
  for (const id of remoteChanged) {
    if (localChanged.has(id)) continue;
    merged = replaceSectionBody(merged, id, remoteSections.get(id)?.body ?? "");
    changedSections.push(id);
  }
  return { status: "merged", markdown: merged, changedSections };
}
