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
  const args = ["-p", prompt, "--output-format", "json"];
  if (condition === "cortex") {
    args.push("--allowedTools", CORTEX_ALLOWED_TOOLS);
  } else {
    args.push("--safe-mode", "--allowedTools", BASELINE_ALLOWED_TOOLS);
  }
  return args;
}

function sumModelUsage(modelUsage: ClaudeJsonOutput["modelUsage"]): {
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
  return totals;
}

function checkCorrectness(result: string | undefined, expectedFacts: string[]): boolean {
  if (!result) return false;
  return expectedFacts.every((pattern) => new RegExp(pattern, "i").test(result));
}

function runOne(task: Task, condition: Condition, repetition: number): RunResult {
  const args = buildArgs(condition, task.prompt);
  const started = performance.now();
  const spawned = Bun.spawnSync(["claude", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const wallMs = Math.round((performance.now() - started) * 100) / 100;

  const stdout = spawned.stdout.toString();
  const stderr = spawned.stderr.toString();

  let parsed: ClaudeJsonOutput | null = null;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonOutput;
  } catch {
    console.error(`[${task.id}/${condition}/rep${repetition}] failed to parse JSON output. stderr: ${stderr.slice(0, 500)}`);
  }

  const usage = sumModelUsage(parsed?.modelUsage);
  const totalTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const correct = checkCorrectness(parsed?.result, task.expected_facts);

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
