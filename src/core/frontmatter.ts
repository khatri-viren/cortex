import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ATTACHMENT_RELATIONS,
  NOTE_TYPES,
  type AppliesTo,
  type Diagnostic,
  type NoteFrontmatter,
  type NoteType,
} from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type FrontmatterParseResult = {
  frontmatter?: NoteFrontmatter;
  raw: Record<string, unknown>;
  body: string;
  bodyLineOffset: number;
  diagnostics: Diagnostic[];
  hadBlock: boolean;
};

const error = (code: string, message: string): Diagnostic => ({ severity: "error", code, message });
const warning = (code: string, message: string): Diagnostic => ({ severity: "warning", code, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339_UTC_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function parseFrontmatter(text: string): FrontmatterParseResult {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return {
      raw: {},
      body: text,
      bodyLineOffset: 0,
      diagnostics: [error("missing-frontmatter", "Markdown file is missing a YAML frontmatter block.")],
      hadBlock: false,
    };
  }

  const diagnostics: Diagnostic[] = [];
  let rawValue: unknown;
  try {
    rawValue = parseYaml(match[1]);
  } catch (cause) {
    diagnostics.push(error("invalid-frontmatter-yaml", cause instanceof Error ? cause.message : String(cause)));
    return { raw: {}, body: text.slice(match[0].length), bodyLineOffset: match[0].split(/\r?\n/).length - 1, diagnostics, hadBlock: true };
  }

  if (!isRecord(rawValue)) {
    diagnostics.push(error("invalid-frontmatter-shape", "Frontmatter must contain a YAML object."));
    return { raw: {}, body: text.slice(match[0].length), bodyLineOffset: match[0].split(/\r?\n/).length - 1, diagnostics, hadBlock: true };
  }

  const raw = rawValue;
  const requiredFields = ["id", "title", "type", "created_at", "updated_at"];
  for (const field of requiredFields) {
    if (!(field in raw)) diagnostics.push(error(`missing-${field}`, `Frontmatter is missing required field '${field}'.`));
  }

  if (typeof raw.id !== "string" || !UUID_RE.test(raw.id)) {
    diagnostics.push(error("invalid-id", "'id' must be a UUID."));
  }
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    diagnostics.push(error("invalid-title", "'title' must be a non-empty string."));
  }
  if (typeof raw.type !== "string" || !NOTE_TYPES.includes(raw.type as NoteType)) {
    diagnostics.push(error("invalid-type", `'type' must be one of: ${NOTE_TYPES.join(", ")}.`));
  }
  for (const field of ["created_at", "updated_at"] as const) {
    if (!isUtcTimestamp(raw[field])) diagnostics.push(error(`invalid-${field}`, `'${field}' must be an RFC3339 UTC timestamp.`));
  }
  if (raw.aliases !== undefined && !isStringArray(raw.aliases)) {
    diagnostics.push(error("invalid-aliases", "'aliases' must be an array of strings."));
  }
  if (raw.tags !== undefined && !isStringArray(raw.tags)) {
    diagnostics.push(error("invalid-tags", "'tags' must be an array of strings."));
  }

  const appliesTo: AppliesTo[] = [];
  if (raw.applies_to !== undefined) {
    if (!Array.isArray(raw.applies_to)) {
      diagnostics.push(error("invalid-applies-to", "'applies_to' must be an array."));
    } else {
      for (const [index, item] of raw.applies_to.entries()) {
        if (!isRecord(item) || typeof item.target !== "string" || typeof item.relation !== "string") {
          diagnostics.push(error("invalid-applies-to-entry", `'applies_to[${index}]' must have target and relation strings.`));
          continue;
        }
        if (!ATTACHMENT_RELATIONS.includes(item.relation as (typeof ATTACHMENT_RELATIONS)[number])) {
          diagnostics.push(error("invalid-applies-to-relation", `'applies_to[${index}].relation' is not supported.`));
          continue;
        }
        if (item.repository !== undefined && (typeof item.repository !== "string" || item.repository.trim().length === 0)) {
          diagnostics.push(error("invalid-applies-to-repository", `'applies_to[${index}].repository' must be a non-empty string.`));
          continue;
        }
        appliesTo.push({ target: item.target, relation: item.relation as AppliesTo["relation"], ...(item.repository ? { repository: item.repository as string } : {}) });
      }
    }
  }

  const known = new Set(["id", "title", "type", "created_at", "updated_at", "aliases", "tags", "applies_to"]);
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)));
  for (const key of Object.keys(extra)) diagnostics.push(warning("unknown-frontmatter-key", `Unknown frontmatter key '${key}' was preserved.`));

  const hasErrors = diagnostics.some((item) => item.severity === "error");
  const frontmatter = hasErrors
    ? undefined
    : {
        id: raw.id as string,
        title: (raw.title as string).trim(),
        type: raw.type as NoteType,
        created_at: raw.created_at as string,
        updated_at: raw.updated_at as string,
        aliases: (raw.aliases as string[] | undefined) ?? [],
        tags: (raw.tags as string[] | undefined) ?? [],
        applies_to: appliesTo,
        extra,
      };

  return { frontmatter, raw, body: text.slice(match[0].length), bodyLineOffset: match[0].split(/\r?\n/).length - 1, diagnostics, hadBlock: true };
}

export function createFrontmatter(input: Partial<Pick<NoteFrontmatter, "title" | "type" | "aliases" | "tags" | "applies_to">> = {}): NoteFrontmatter {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title?.trim() || "Untitled note",
    type: input.type ?? "note",
    created_at: now,
    updated_at: now,
    aliases: input.aliases ?? [],
    tags: input.tags ?? [],
    applies_to: input.applies_to ?? [],
    extra: {},
  };
}

export function serializeFrontmatter(frontmatter: NoteFrontmatter): string {
  const data: Record<string, unknown> = {
    id: frontmatter.id,
    title: frontmatter.title,
    type: frontmatter.type,
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at,
  };
  data.aliases = frontmatter.aliases;
  data.tags = frontmatter.tags;
  if (frontmatter.applies_to.length > 0) {
    data.applies_to = frontmatter.applies_to.map((item) => (item.repository ? { repository: item.repository, target: item.target, relation: item.relation } : { target: item.target, relation: item.relation }));
  }
  Object.assign(data, frontmatter.extra);
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n`;
}
