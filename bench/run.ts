import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Task = {
  id: string;
  description: string;
  baseline: string[][];
  mcp: Array<{ tool: string; arguments: Record<string, unknown> }>;
};

type Measurement = {
  calls: number;
  returned_tokens: number;
  wall_ms: number;
};

const root = process.cwd();
const tasks = JSON.parse(readFileSync(join(root, "bench", "tasks.json"), "utf8")) as Task[];
const repetitions = Number(process.env.CORTEX_BENCH_REPETITIONS ?? 3);

function tokenEstimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function runBaseline(commands: string[][]): Measurement {
  const started = performance.now();
  let returnedTokens = 0;
  for (const command of commands) {
    const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    returnedTokens += tokenEstimate({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() });
  }
  return { calls: commands.length, returned_tokens: returnedTokens, wall_ms: Math.round((performance.now() - started) * 100) / 100 };
}

async function runMcp(client: Client, calls: Task["mcp"]): Promise<Measurement> {
  const started = performance.now();
  let returnedTokens = 0;
  for (const call of calls) {
    const result = await client.callTool({ name: call.tool, arguments: call.arguments });
    returnedTokens += tokenEstimate(result);
  }
  return { calls: calls.length, returned_tokens: returnedTokens, wall_ms: Math.round((performance.now() - started) * 100) / 100 };
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/cli.ts", "mcp", "--vault", root],
  cwd: root,
  stderr: "pipe",
});
const client = new Client({ name: "cortex-benchmark", version: "1.0.0" });

try {
  await client.connect(transport);
  const results = [];
  for (const task of tasks) {
    const baselineRuns = [];
    const mcpRuns = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      baselineRuns.push(runBaseline(task.baseline));
      mcpRuns.push(await runMcp(client, task.mcp));
    }
    results.push({
      id: task.id,
      description: task.description,
      repetitions,
      baseline: {
        calls: median(baselineRuns.map((run) => run.calls)),
        returned_tokens: median(baselineRuns.map((run) => run.returned_tokens)),
        wall_ms: median(baselineRuns.map((run) => run.wall_ms)),
      },
      mcp: {
        calls: median(mcpRuns.map((run) => run.calls)),
        returned_tokens: median(mcpRuns.map((run) => run.returned_tokens)),
        wall_ms: median(mcpRuns.map((run) => run.wall_ms)),
      },
    });
  }
  console.log(JSON.stringify({ vault: root, results }, null, 2));
} finally {
  await client.close();
}
