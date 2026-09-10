import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

type ToolCall = {
  id: string;
  session: string;
  tool: string;
  input: unknown;
  order: number;
};

type ToolResult = {
  id: string;
  session: string;
  explicitIsError: boolean;
  isError: boolean;
  value: unknown;
  order: number;
};

type Pair = { call: ToolCall; result?: ToolResult };

const RAW_SCHEMA_ERROR = /(?:schema|validation|invalid\s+(?:arguments?|input)|expected\s+(?:object|string|number|boolean)|additional propert|zod)/i;
const TIMEOUT_ERROR = /(?:timeout|timed out|deadline exceeded|ETIMEDOUT)/i;
const PROVIDER_CAP = /\b(?:output|result|response|content|message).{0,48}\b(?:too large|maximum(?: size| output)?|size limit|output limit|result limit|cap(?:ped)?|truncat(?:ed|ion)|omitted by provider)\b/i;
const PLACEHOLDER = /(?:<[^>\n]{0,100}(?:placeholder|omitted|truncated)[^>\n]*>|\[(?:output|result|content|response)[^\]\n]{0,100}(?:omitted|truncated|placeholder)[^\]\n]*\]|…[^\n]{0,80}(?:output|result|content).{0,30}(?:omitted|truncated)…)/i;
const NATIVE_FALLBACK = /^(?:read|grep|glob|bash|shell|terminal|exec)(?:$|[(_\-]|\s)/i;
const EMPTY_RESULT_ARRAYS = new Set(["hits", "notes", "nodes", "edges", "commits", "diagnostics", "rows", "matches", "repositories", "changed_paths"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  return Object.values(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function resultValue(object: JsonObject): unknown {
  return object.content ?? object.result ?? object.output ?? object.structuredContent;
}

function errorValue(value: unknown): JsonObject | undefined {
  if (isObject(value)) {
    if (isObject(value.error)) return value.error;
    if (typeof value.code === "string" || typeof value.message === "string") return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = errorValue(item);
      if (found) return found;
    }
  }
  return undefined;
}

function collect(root: unknown): { calls: ToolCall[]; results: ToolResult[] } {
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  const visited = new Set<unknown>();
  let order = 0;
  const visit = (value: unknown, session = "default") => {
    if (value === null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    const object = value as JsonObject;
    const nextSession = typeof object.session_id === "string"
      ? object.session_id
      : typeof object.sessionId === "string" ? object.sessionId : session;
    const type = typeof object.type === "string" ? object.type : "";
    const callId = typeof object.id === "string" ? object.id : undefined;
    const resultId = typeof object.tool_use_id === "string"
      ? object.tool_use_id
      : typeof object.toolUseId === "string" ? object.toolUseId : typeof object.id === "string" ? object.id : undefined;
    const tool = typeof object.name === "string" ? object.name : typeof object.tool_name === "string" ? object.tool_name : undefined;
    if (callId && tool && (type === "tool_use" || type === "tool_call" || type === "function_call" || object.tool_input !== undefined)) {
      calls.push({ id: callId, session: nextSession, tool, input: object.input ?? object.arguments ?? object.tool_input, order: order++ });
    }
    const explicitIsError = object.is_error === true || object.isError === true;
    const rawContent = resultValue(object);
    const isError = explicitIsError || Boolean(errorValue(rawContent));
    if (resultId && (type === "tool_result" || type === "tool_response" || object.is_error !== undefined || object.isError !== undefined) && (object.tool_use_id !== undefined || object.toolUseId !== undefined || type === "tool_result")) {
      results.push({ id: resultId, session: nextSession, explicitIsError, isError, value: rawContent, order: order++ });
    }
    for (const child of children(value)) visit(child, nextSession);
  };
  visit(root);
  return { calls, results };
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(payloadText).join("\n");
  return JSON.stringify(value) ?? "";
}

function structuredError(value: unknown): { code?: string; message: string } | undefined {
  const error = errorValue(value);
  if (!error) return undefined;
  return typeof error.code === "string" || typeof error.message === "string"
    ? { code: typeof error.code === "string" ? error.code : undefined, message: typeof error.message === "string" ? error.message : JSON.stringify(error) ?? "" }
    : undefined;
}

function hasProviderCap(value: unknown): boolean {
  const text = payloadText(value);
  return PROVIDER_CAP.test(text) || PLACEHOLDER.test(text);
}

function classify(pair: Pair): string {
  if (!pair.result) return "missing_result";
  const text = payloadText(pair.result.value);
  const error = structuredError(pair.result.value);
  if (error?.code) {
    if (error.code === "CONFLICT") return "service_conflict";
    if (error.code === "INDEX_SYNC_FAILED") return "indexing_failure";
    if (error.code === "NOT_FOUND") return "semantic_not_found";
    if (["AMBIGUOUS_NOTE", "AMBIGUOUS_GRAPH_NODE", "AMBIGUOUS_SECTION"].includes(error.code)) return "semantic_ambiguity";
    if (error.code === "INVALID_INPUT") return "client_input_error";
    return `cortex_${error.code.toLocaleLowerCase()}`;
  }
  if (TIMEOUT_ERROR.test(text)) return "provider_timeout";
  if (RAW_SCHEMA_ERROR.test(text)) return "client_schema_error";
  if (hasProviderCap(pair.result.value)) return "provider_output_cap";
  return pair.result.isError ? "unclassified_error" : "success";
}

function emptyResultFields(value: unknown): string[] {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([key, item]) => (EMPTY_RESULT_ARRAYS.has(key) && Array.isArray(item) && item.length === 0) || ((key === "result" || key === "output") && item === ""))
    .map(([key]) => key);
}

function loadRecords(path: string): unknown {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { type: "unparseable", line }; }
    });
  }
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function isFailure(category: string): boolean {
  return category !== "success";
}

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun run bench/mcp-replay.ts <transcript.json|transcript.jsonl>");
  const { calls, results } = collect(loadRecords(path));
  const resultQueues = new Map<string, ToolResult[]>();
  for (const result of results) {
    const key = `${result.session}\u0000${result.id}`;
    resultQueues.set(key, [...(resultQueues.get(key) ?? []), result]);
  }
  const pairs: Pair[] = calls.map((call) => ({ call, result: resultQueues.get(`${call.session}\u0000${call.id}`)?.shift() }));
  const unmatchedResults = [...resultQueues.values()].reduce((total, queue) => total + queue.length, 0);
  const counts = new Map<string, {
    calls: number;
    paired_calls: number;
    failures: number;
    explicit_is_error: number;
    output_bytes: number;
    categories: Record<string, number>;
    error_codes: Record<string, number>;
    raw_sdk_validation_errors: number;
    provider_output_caps: number;
    provider_timeouts: number;
    placeholder_substitutions: number;
    empty_result_fields: Record<string, number>;
    fallback_after_error: number;
  }>();
  const topCategories: Record<string, number> = {};
  const topErrorCodes: Record<string, number> = {};
  const topEmptyFields: Record<string, number> = {};
  const fallbackPairs: Array<{ tool: string; category: string; next_tool?: string; fallback: boolean }> = [];
  let explicitIsError = 0;
  let rawSchemaErrors = 0;
  let providerOutputCaps = 0;
  let providerTimeouts = 0;
  let placeholderSubstitutions = 0;

  for (const [index, pair] of pairs.entries()) {
    const category = classify(pair);
    increment(topCategories, category);
    const tool = counts.get(pair.call.tool) ?? {
      calls: 0,
      paired_calls: 0,
      failures: 0,
      explicit_is_error: 0,
      output_bytes: 0,
      categories: {},
      error_codes: {},
      raw_sdk_validation_errors: 0,
      provider_output_caps: 0,
      provider_timeouts: 0,
      placeholder_substitutions: 0,
      empty_result_fields: {},
      fallback_after_error: 0,
    };
    tool.calls += 1;
    tool.paired_calls += pair.result ? 1 : 0;
    if (isFailure(category)) tool.failures += 1;
    increment(tool.categories, category);
    if (pair.result) {
      tool.output_bytes += Buffer.byteLength(stringValue(pair.result.value), "utf8");
      if (pair.result.explicitIsError) {
        tool.explicit_is_error += 1;
        explicitIsError += 1;
      }
      const error = structuredError(pair.result.value);
      if (error?.code) {
        increment(tool.error_codes, error.code);
        increment(topErrorCodes, error.code);
      }
      if (category === "client_schema_error") {
        tool.raw_sdk_validation_errors += 1;
        rawSchemaErrors += 1;
      }
      if (category === "provider_output_cap") {
        tool.provider_output_caps += 1;
        providerOutputCaps += 1;
      }
      if (category === "provider_timeout") {
        tool.provider_timeouts += 1;
        providerTimeouts += 1;
      }
      if (hasProviderCap(pair.result.value) && PLACEHOLDER.test(payloadText(pair.result.value))) {
        tool.placeholder_substitutions += 1;
        placeholderSubstitutions += 1;
      }
      for (const field of emptyResultFields(pair.result.value)) {
        increment(tool.empty_result_fields, field);
        increment(topEmptyFields, field);
      }
    }
    const next = pairs[index + 1];
    const fallback = Boolean(next && isFailure(category) && (NATIVE_FALLBACK.test(next.call.tool) || next.call.tool === pair.call.tool));
    if (fallback) tool.fallback_after_error += 1;
    if (isFailure(category) && next) fallbackPairs.push({ tool: pair.call.tool, category, next_tool: next.call.tool, fallback });
    counts.set(pair.call.tool, tool);
  }
  const missingResults = pairs.filter((pair) => !pair.result).length;
  const totalFailures = pairs.filter((pair) => isFailure(classify(pair))).length;
  console.log(JSON.stringify({
    baseline: { paired_calls: 1_488, errors: 305, error_rate: 0.2050 },
    replay: {
      calls: calls.length,
      paired_calls: pairs.filter((pair) => pair.result).length,
      missing_results: missingResults,
      unmatched_results: unmatchedResults,
      explicit_is_error: explicitIsError,
      failures: totalFailures,
      error_rate: calls.length ? totalFailures / calls.length : 0,
      structured_error_codes: topErrorCodes,
      raw_sdk_validation_errors: rawSchemaErrors,
      provider_output_caps: providerOutputCaps,
      provider_timeouts: providerTimeouts,
      placeholder_substitutions: placeholderSubstitutions,
      empty_result_fields: topEmptyFields,
      fallback_after_error: fallbackPairs.filter((entry) => entry.fallback).length,
      inferred_recovery: fallbackPairs,
      categories: topCategories,
      tools: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tool, value]) => [tool, {
        ...value,
        failure_rate: value.calls ? value.failures / value.calls : 0,
      }])),
    },
  }, null, 2));
}

if (import.meta.main) main();
