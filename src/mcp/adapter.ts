import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ServiceError } from "../core/errors.js";

export type McpDeprecationWarning = {
  code: "DEPRECATED_FIELD";
  field: string;
  canonical_field: string;
  replacement: string;
  message: string;
};

export type McpNormalization<T> = {
  args: T;
  warnings: McpDeprecationWarning[];
};

/**
 * Historical argument names accepted at the MCP boundary. The values are the
 * canonical names consumed by the Cortex runtime. Keep this map deliberately
 * small: compatibility belongs at the ingress seam, not in core interfaces.
 */
export const MCP_FIELD_ALIASES = {
  get_note: { path: "note", note_id: "note", id: "note", title: "note" },
  get_section: { path: "note", section: "section_id", id: "section_id" },
  patch_section: {
    path: "note",
    revision: "expected_revision",
    body: "new_content",
    content: "new_content",
    section: "section_id",
    id: "section_id",
  },
  replace_note: { path: "note", hash: "expected_file_hash", expected_hash: "expected_file_hash", body: "markdown", content: "markdown" },
  query_table: { path: "note" },
  create_note: { note: "path", markdown: "body" },
  get_history: { path: "note" },
  get_diff: { path: "note", expected_revision: "revision" },
  restore_note: { path: "note", expected_revision: "revision" },
  get_repo_history: { note: "path" },
  get_repo_diff: { note: "path", expected_revision: "revision" },
  restore_repo_path: { note: "path", expected_revision: "revision" },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

const aliasesByTool: Readonly<Record<string, Readonly<Record<string, string>>>> = MCP_FIELD_ALIASES;

const RAW_INGRESS_FIELD = "__cortex_raw_ingress";

type RawArguments = Record<string, unknown>;

function isObjectRecord(value: unknown): value is RawArguments {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: RawArguments, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Build the schema exposed to the MCP SDK. The SDK uses the same schema both
 * to generate tools/list and to validate a call before invoking the handler.
 * Cortex needs those responsibilities separated: clients must see the precise
 * canonical contract, while the handler must receive raw values so it can
 * normalize deprecated aliases and return Cortex's structured INVALID_INPUT.
 *
 * The preprocess marker lets direct callers and future transports preserve a
 * malformed non-object value until Cortex can turn it into INVALID_INPUT. The
 * MCP protocol currently requires an arguments object, so this is primarily a
 * defensive boundary for SDK and adapter callers.
 */
export function rawObjectIngressSchema(schema: z.AnyZodObject): z.AnyZodObject {
  const rawShape = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, z.any().optional()]),
  ) as z.ZodRawShape;

  const rawParser = z.preprocess(
    (value) => isObjectRecord(value) ? value : { [RAW_INGRESS_FIELD]: value },
    z.object(rawShape).passthrough(),
  );

  // Keep an actual ZodObject so the MCP SDK can derive the complete JSON
  // Schema. Override only its async parse entrypoint, which is the one the SDK
  // invokes before dispatching to the handler. The canonical schema passed to
  // normalizeMcpArguments remains untouched.
  const advertisedSchema = z.object(schema.shape);
  Object.defineProperty(advertisedSchema, "safeParseAsync", {
    configurable: true,
    value: rawParser.safeParseAsync.bind(rawParser),
  });
  return advertisedSchema;
}

export class McpIngressError extends ServiceError {
  readonly warnings: McpDeprecationWarning[];

  constructor(message: string, details?: Record<string, unknown>, warnings: McpDeprecationWarning[] = []) {
    super("INVALID_INPUT", message, details);
    this.warnings = warnings;
  }
}

function deprecationWarning(toolName: string, field: string, replacement: string): McpDeprecationWarning {
  return {
    code: "DEPRECATED_FIELD",
    field,
    canonical_field: replacement,
    replacement,
    message: `Argument '${field}' for tool '${toolName}' is deprecated; use '${replacement}' instead.`,
  };
}

function normalizeInput(rawArguments: unknown): unknown {
  if (!isObjectRecord(rawArguments)) return rawArguments;
  if (Object.keys(rawArguments).length === 1 && hasOwn(rawArguments, RAW_INGRESS_FIELD)) {
    return rawArguments[RAW_INGRESS_FIELD];
  }
  return rawArguments;
}

function validationIssues(error: z.ZodError): Array<{ path: Array<string | number>; code: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }));
}

/**
 * Normalize one raw MCP call into the canonical runtime argument shape.
 * Unknown fields remain errors, while only aliases in MCP_FIELD_ALIASES are
 * accepted. Equal canonical/alias duplicates are harmless but still produce a
 * warning; differing values are rejected deterministically.
 */
export function normalizeMcpArguments<T extends z.AnyZodObject>(
  toolName: string,
  rawArguments: unknown,
  schema: T,
  aliases: Readonly<Record<string, string>> | undefined = aliasesByTool[toolName],
): McpNormalization<z.output<T>> {
  const input = normalizeInput(rawArguments);
  const object = input === undefined ? {} : input;
  const warnings: McpDeprecationWarning[] = [];

  if (!isObjectRecord(object)) {
    throw new McpIngressError(`Arguments for tool '${toolName}' must be an object.`, {
      received_type: valueType(object),
    });
  }

  const normalized: RawArguments = { ...object };
  for (const [alias, canonical] of Object.entries(aliases ?? {})) {
    if (!hasOwn(normalized, alias)) continue;

    const aliasValue = normalized[alias];
    if (hasOwn(normalized, canonical) && !isDeepStrictEqual(normalized[canonical], aliasValue)) {
      throw new McpIngressError(
        `Arguments for tool '${toolName}' contain conflicting values for '${canonical}' and deprecated alias '${alias}'.`,
        {
          canonical_field: canonical,
          alias_field: alias,
          conflicting_fields: [canonical, alias],
        },
        warnings,
      );
    }

    if (!hasOwn(normalized, canonical)) normalized[canonical] = aliasValue;
    delete normalized[alias];
    warnings.push(deprecationWarning(toolName, alias, canonical));
  }

  const parsed = schema.strict().safeParse(normalized);
  if (!parsed.success) {
    throw new McpIngressError(
      `Invalid arguments for tool '${toolName}'.`,
      { issues: validationIssues(parsed.error) },
      warnings,
    );
  }

  return { args: parsed.data, warnings };
}
