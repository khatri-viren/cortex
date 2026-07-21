export const NOTE_TYPES = ["note", "map", "table"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const ATTACHMENT_RELATIONS = [
  "documents",
  "owns",
  "implements",
  "depends_on",
  "related_to",
] as const;
export type AttachmentRelation = (typeof ATTACHMENT_RELATIONS)[number];

export type AppliesTo = {
  target: string;
  relation: AttachmentRelation;
};

export type NoteFrontmatter = {
  id: string;
  title: string;
  type: NoteType;
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  applies_to: AppliesTo[];
  extra: Record<string, unknown>;
};

export type DiagnosticSeverity = "error" | "warning";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
};

export type SourceLocation = {
  line: number;
  column: number;
};

export type Wikilink = {
  target: string;
  section?: string;
  display?: string;
  location: SourceLocation;
};

export type TableData = {
  sectionId?: string;
  headers: string[];
  rows: string[][];
  startLine: number;
};

export type Section = {
  id?: string;
  level: number;
  heading: string;
  startLine: number;
  endLine: number;
  revision: string;
};

export type ParsedNote = {
  filePath?: string;
  frontmatter?: NoteFrontmatter;
  wikilinks: Wikilink[];
  sections: Section[];
  tables: TableData[];
  diagnostics: Diagnostic[];
  body: string;
};

export type VaultScan = {
  vaultRoot: string;
  files: string[];
  notes: ParsedNote[];
  noteCount: number;
  linkCount: number;
  sectionCount: number;
  diagnostics: Diagnostic[];
};
