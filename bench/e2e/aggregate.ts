import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type RunResult = {
  task: string;
  condition: "cortex" | "baseline";
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
  tool_counts?: Record<string, number>;
  tool_failures?: Record<string, number>;
  tool_output_bytes?: Record<string, number>;
  retry_count?: number;
  fallback_used?: boolean;
  output_cap_events?: number;
  timeout_events?: number;
};

const resultsFile = process.argv[2];
if (!resultsFile) {
  console.error("usage: bun run bench/e2e/aggregate.ts <results.jsonl>");
  process.exit(1);
}

const lines = readFileSync(resultsFile, "utf8").split("\n").filter((line) => line.trim().length > 0);
const rows = lines.map((line) => JSON.parse(line) as RunResult);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pctDelta(baseline: number, cortex: number): number {
  if (baseline === 0) return 0;
  return Math.round(((baseline - cortex) / baseline) * 10000) / 100;
}

type ConditionAgg = {
  n: number;
  cost_usd: number;
  total_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  num_turns: number;
  wall_ms: number;
  correct_rate: number;
  error_rate: number;
  tool_counts: Record<string, number>;
  tool_failures: Record<string, number>;
  tool_output_bytes: Record<string, number>;
  retry_count: number;
  fallback_rate: number;
  output_cap_events: number;
  timeout_events: number;
};

function medianCounters(rows: RunResult[], field: "tool_counts" | "tool_failures" | "tool_output_bytes"): Record<string, number> {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row[field] ?? {})) keys.add(key);
  return Object.fromEntries([...keys].sort().map((key) => [
    key,
    median(rows.map((row) => row[field]?.[key] ?? 0)),
  ]));
}

function aggregateCondition(rows: RunResult[]): ConditionAgg {
  return {
    n: rows.length,
    cost_usd: median(rows.map((r) => r.cost_usd)),
    total_tokens: median(rows.map((r) => r.total_tokens)),
    input_tokens: median(rows.map((r) => r.input_tokens)),
    cache_read_tokens: median(rows.map((r) => r.cache_read_tokens)),
    cache_creation_tokens: median(rows.map((r) => r.cache_creation_tokens)),
    output_tokens: median(rows.map((r) => r.output_tokens)),
    num_turns: median(rows.map((r) => r.num_turns)),
    wall_ms: median(rows.map((r) => r.wall_ms)),
    correct_rate: rows.length === 0 ? 0 : rows.filter((r) => r.correct).length / rows.length,
    error_rate: rows.length === 0 ? 0 : rows.filter((r) => r.is_error).length / rows.length,
    tool_counts: medianCounters(rows, "tool_counts"),
    tool_failures: medianCounters(rows, "tool_failures"),
    tool_output_bytes: medianCounters(rows, "tool_output_bytes"),
    retry_count: median(rows.map((r) => r.retry_count ?? 0)),
    fallback_rate: rows.length === 0 ? 0 : rows.filter((r) => r.fallback_used === true).length / rows.length,
    output_cap_events: median(rows.map((r) => r.output_cap_events ?? 0)),
    timeout_events: median(rows.map((r) => r.timeout_events ?? 0)),
  };
}

const taskIds = [...new Set(rows.map((r) => r.task))];

const summary = taskIds.map((task) => {
  const taskRows = rows.filter((r) => r.task === task);
  const cortexRows = taskRows.filter((r) => r.condition === "cortex");
  const baselineRows = taskRows.filter((r) => r.condition === "baseline");
  const cortex = aggregateCondition(cortexRows);
  const baseline = aggregateCondition(baselineRows);

  return {
    task,
    cortex,
    baseline,
    deltas: {
      cost_pct_saved: pctDelta(baseline.cost_usd, cortex.cost_usd),
      tokens_pct_saved: pctDelta(baseline.total_tokens, cortex.total_tokens),
      wall_ms_pct_saved: pctDelta(baseline.wall_ms, cortex.wall_ms),
      turns_delta: cortex.num_turns - baseline.num_turns,
    },
    correctness_flag: cortex.correct_rate < 1 || baseline.correct_rate < 1 ? "REVIEW" : "OK",
  };
});

const outFile = join(join(resultsFile, ".."), "summary.json");
writeFileSync(outFile, JSON.stringify({ generated_from: resultsFile, tasks: summary }, null, 2));

console.log(`Summary written to ${outFile}\n`);
console.log(
  "task".padEnd(28),
  "cost$saved".padEnd(12),
  "tok%saved".padEnd(11),
  "time%saved".padEnd(12),
  "turnsΔ".padEnd(8),
  "flag",
);
for (const row of summary) {
  console.log(
    row.task.padEnd(28),
    `${row.deltas.cost_pct_saved}%`.padEnd(12),
    `${row.deltas.tokens_pct_saved}%`.padEnd(11),
    `${row.deltas.wall_ms_pct_saved}%`.padEnd(12),
    String(row.deltas.turns_delta).padEnd(8),
    row.correctness_flag,
  );
}
