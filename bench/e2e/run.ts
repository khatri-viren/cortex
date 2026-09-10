import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

type Task = { id: string; prompt: string; expected_facts: string[] };
type Condition = "cortex" | "baseline";

type ModelUsageEntry = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
};

type ClaudeJsonOutput = {
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type StreamObject = Record<string, unknown>;

type ToolTraceEvent = {
  kind: "call" | "result";
  name?: string;
  id?: string;
  is_error?: boolean;
  output_bytes?: number;
  output_cap?: boolean;
  timeout?: boolean;
};

type ToolTrace = {
  tool_counts: Record<string, number>;
  tool_failures: Record<string, number>;
  tool_output_bytes: Record<string, number>;
  retry_count: number;
  fallback_used: boolean;
  output_cap_events: number;
  timeout_events: number;
};

type RunResult = {
  task: string;
  condition: Condition;
  repetition: number;
  wall_ms: number;
  is_error: boolean;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  num_turns: number;
  correct: boolean;
  session_id: string | null;
  result_excerpt: string;
  tool_counts: Record<string, number>;
  tool_failures: Record<string, number>;
  tool_output_bytes: Record<string, number>;
  retry_count: number;
  fallback_used: boolean;
  output_cap_events: number;
  timeout_events: number;
};

const root = process.cwd();
const tasks = JSON.parse(readFileSync(join(root, "bench/e2e/tasks.json"), "utf8")) as Task[];
const repetitions = Number(process.env.CORTEX_E2E_REPS ?? 3);
const onlyTasks = process.env.CORTEX_E2E_TASKS?.split(",");
const selectedTasks = onlyTasks ? tasks.filter((task) => onlyTasks.includes(task.id)) : tasks;

const CORTEX_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(rg *)",
  "Bash(sed *)",
  "mcp__cortex__search",
  "mcp__cortex__get_context",
  "mcp__cortex__get_note",
  "mcp__cortex__get_section",
  "mcp__cortex__project_map",
  "mcp__cortex__graph_query",
  "mcp__cortex__query_table",
  "mcp__cortex__list_notes",
  "mcp__cortex__workspace_status",
  "mcp__cortex__vault_check",
  "mcp__cortex__get_history",
  "mcp__cortex__get_diff",
  "mcp__cortex__get_repo_history",
  "mcp__cortex__get_repo_diff",
].join(" ");

const BASELINE_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(rg *)", "Bash(sed *)"].join(" ");

function buildArgs(condition: Condition, prompt: string): string[] {
  // stream-json is required for attribution: the single-result JSON format
  // omits the individual tool_use/tool_result events needed to measure tool
  // failures, response sizes, retries, and native-tool fallback.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (condition === "cortex") {
    args.push("--allowedTools", CORTEX_ALLOWED_TOOLS);
  } else {
    args.push("--safe-mode", "--allowedTools", BASELINE_ALLOWED_TOOLS);
  }
  return args;
}

function sumModelUsage(
  modelUsage: ClaudeJsonOutput["modelUsage"],
  usage: ClaudeJsonOutput["usage"],
): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
} {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  for (const entry of Object.values(modelUsage ?? {})) {
    totals.input_tokens += entry.inputTokens ?? 0;
    totals.output_tokens += entry.outputTokens ?? 0;
    totals.cache_read_tokens += entry.cacheReadInputTokens ?? 0;
    totals.cache_creation_tokens += entry.cacheCreationInputTokens ?? 0;
  }
  if (Object.keys(modelUsage ?? {}).length === 0 && usage) {
    totals.input_tokens += usage.input_tokens ?? 0;
    totals.output_tokens += usage.output_tokens ?? 0;
    totals.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
    totals.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
  }
  return totals;
}

function checkCorrectness(result: string | undefined, expectedFacts: string[]): boolean {
  if (!result) return false;
  return expectedFacts.every((pattern) => new RegExp(pattern, "i").test(result));
}

function isObject(value: unknown): value is StreamObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseStreamObjects(stdout: string): StreamObject[] {
  const objects: StreamObject[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isObject(parsed)) objects.push(parsed);
    } catch {
      // Claude may print a human-readable diagnostic around a stream event.
      // Keep parsing later JSON lines so one noisy line does not erase the
      // final result or the tool attribution already collected.
    }
  }
  return objects;
}

function eventBlocks(event: StreamObject): StreamObject[] {
  const blocks: StreamObject[] = [];
  const message = isObject(event.message) ? event.message : undefined;
  for (const candidate of [event.content, message?.content]) {
    if (!Array.isArray(candidate)) continue;
    for (const block of candidate) if (isObject(block)) blocks.push(block);
  }
  if (isObject(event.tool_use)) blocks.push({ type: "tool_use", ...event.tool_use });
  if (isObject(event.tool_result)) blocks.push({ type: "tool_result", ...event.tool_result });
  return blocks;
}

function toolUse(block: StreamObject): { name: string; id?: string } | undefined {
  const type = stringValue(block.type);
  if (type !== "tool_use" && type !== "tool_call" && type !== "function_call") return undefined;
  const functionValue = isObject(block.function) ? block.function : undefined;
  const name = stringValue(block.name) ?? stringValue(functionValue?.name);
  if (!name) return undefined;
  const id = stringValue(block.id) ?? stringValue(block.tool_use_id) ?? stringValue(block.toolUseId);
  return { name, ...(id ? { id } : {}) };
}

function toolResult(block: StreamObject): { id?: string; is_error: boolean; output_bytes: number; text: string } | undefined {
  const type = stringValue(block.type);
  if (type !== "tool_result" && type !== "tool_response") return undefined;
  const id = stringValue(block.tool_use_id) ?? stringValue(block.toolUseId) ?? stringValue(block.id);
  const isError = block.is_error === true || block.isError === true || block.error !== undefined;
  const output = block.content ?? block.output ?? block.result ?? block.error ?? block;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { ...(id ? { id } : {}), is_error: isError, output_bytes: Buffer.byteLength(text, "utf8"), text };
}

function outputLooksLikeCap(text: string): boolean {
  return /output.{0,24}(?:cap|limit|large|size)|result.{0,24}(?:too large|size)|(?:placeholder|truncated).{0,24}(?:output|result)/i.test(text);
}

function outputLooksLikeTimeout(text: string): boolean {
  return /(?:timeout|timed out|deadline exceeded|connection closed)/i.test(text);
}

function analyzeToolTrace(events: StreamObject[]): ToolTrace {
  const sequence: ToolTraceEvent[] = [];
  const callsById = new Map<string, { name: string; sequenceIndex: number }>();
  const pendingCalls: Array<{ name: string; sequenceIndex: number }> = [];

  for (const event of events) {
    for (const block of eventBlocks(event)) {
      const call = toolUse(block);
      if (call) {
        const item: ToolTraceEvent = { kind: "call", name: call.name, ...(call.id ? { id: call.id } : {}) };
        const sequenceIndex = sequence.push(item) - 1;
        const pending = { name: call.name, sequenceIndex };
        pendingCalls.push(pending);
        if (call.id) callsById.set(call.id, pending);
        continue;
      }
      const result = toolResult(block);
      if (!result) continue;
      const pending = result.id ? callsById.get(result.id) : pendingCalls.shift();
      const item: ToolTraceEvent = {
        kind: "result",
        ...(pending ? { name: pending.name } : {}),
        ...(result.id ? { id: result.id } : {}),
        is_error: result.is_error || outputLooksLikeCap(result.text) || outputLooksLikeTimeout(result.text),
        output_bytes: result.output_bytes,
        output_cap: outputLooksLikeCap(result.text),
        timeout: outputLooksLikeTimeout(result.text),
      };
      sequence.push(item);
      if (pending) {
        const index = pendingCalls.findIndex((candidate) => candidate.sequenceIndex === pending.sequenceIndex);
        if (index >= 0) pendingCalls.splice(index, 1);
      }
    }
  }

  const toolCounts: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};
  const toolOutputBytes: Record<string, number> = {};
  let retryCount = 0;
  let fallbackUsed = false;
  let outputCapEvents = 0;
  let timeoutEvents = 0;
  const failedCortexTools = new Set<string>();
  const callNamesById = new Map<string, string>();

  for (const event of sequence) {
    if (event.kind === "call" && event.name) {
      toolCounts[event.name] = (toolCounts[event.name] ?? 0) + 1;
      if (event.id) callNamesById.set(event.id, event.name);
      if (failedCortexTools.has(event.name)) {
        retryCount += 1;
        failedCortexTools.delete(event.name);
      }
      if (failedCortexTools.size > 0 && /^(?:Read|Grep|Glob|Bash)(?:\(|$)/.test(event.name)) {
        fallbackUsed = true;
        failedCortexTools.clear();
      }
      continue;
    }
    if (event.kind !== "result") continue;
    const name = event.name ?? (event.id ? callNamesById.get(event.id) : undefined);
    if (!name) continue;
    toolOutputBytes[name] = (toolOutputBytes[name] ?? 0) + (event.output_bytes ?? 0);
    if (event.output_cap) outputCapEvents += 1;
    if (event.timeout) timeoutEvents += 1;
    if (!event.is_error) continue;
    toolFailures[name] = (toolFailures[name] ?? 0) + 1;
    if (name.startsWith("mcp__cortex__")) failedCortexTools.add(name);
  }

  return {
    tool_counts: toolCounts,
    tool_failures: toolFailures,
    tool_output_bytes: toolOutputBytes,
    retry_count: retryCount,
    fallback_used: fallbackUsed,
    output_cap_events: outputCapEvents,
    timeout_events: timeoutEvents,
  };
}

function extractResult(events: StreamObject[]): ClaudeJsonOutput | null {
  const result = [...events].reverse().find((event) => event.type === "result" || event.subtype === "success" || event.result !== undefined);
  return result ? result as ClaudeJsonOutput : null;
}

function runOne(task: Task, condition: Condition, repetition: number): RunResult {
  const args = buildArgs(condition, task.prompt);
  const started = performance.now();
  const spawned = Bun.spawnSync(["claude", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const wallMs = Math.round((performance.now() - started) * 100) / 100;

  const stdout = spawned.stdout.toString();
  const stderr = spawned.stderr.toString();

  const events = parseStreamObjects(stdout);
  let parsed = extractResult(events);
  if (!parsed) {
    try {
      parsed = JSON.parse(stdout) as ClaudeJsonOutput;
    } catch {
      console.error(`[${task.id}/${condition}/rep${repetition}] failed to parse Claude output. stderr: ${stderr.slice(0, 500)}`);
    }
  }

  const usage = sumModelUsage(parsed?.modelUsage, parsed?.usage);
  const totalTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const correct = checkCorrectness(parsed?.result, task.expected_facts);
  const trace = analyzeToolTrace(events);

  return {
    task: task.id,
    condition,
    repetition,
    wall_ms: wallMs,
    is_error: parsed?.is_error ?? true,
    cost_usd: parsed?.total_cost_usd ?? 0,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    total_tokens: totalTokens,
    num_turns: parsed?.num_turns ?? 0,
    correct,
    session_id: parsed?.session_id ?? null,
    result_excerpt: (parsed?.result ?? "").slice(0, 200),
    ...trace,
  };
}

const resultsDir = join(root, "bench/e2e/results");
mkdirSync(resultsDir, { recursive: true });
const outFile = join(resultsDir, `run-${process.env.CORTEX_E2E_RUN_ID ?? "latest"}.jsonl`);

for (const task of selectedTasks) {
  for (const condition of ["cortex", "baseline"] as Condition[]) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const result = runOne(task, condition, repetition);
      appendFileSync(outFile, `${JSON.stringify(result)}\n`);
      console.log(
        `[${result.task}/${result.condition}/rep${result.repetition}] ` +
          `cost=$${result.cost_usd.toFixed(4)} tokens=${result.total_tokens} turns=${result.num_turns} ` +
          `wall_ms=${result.wall_ms} correct=${result.correct} error=${result.is_error}`,
      );
    }
  }
}

console.log(`\nResults written to ${outFile}`);
