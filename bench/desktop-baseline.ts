import { createFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { VaultIndexer } from "../src/core/indexer.js";
import { initVault } from "../src/core/vault.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { IndexReport } from "../src/core/index-types.js";

type FixtureSpec = {
  id: string;
  notes: number;
  repositoryFiles: number;
};

type Timing = {
  samples: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
};

type RunMeasurement = {
  timing: Timing;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  maxRssBytes: number;
  requests: number;
  reports: Array<{
    mode: IndexReport["mode"];
    changedPathCount: number;
    changedPathSample: string[];
    noteCount: number;
    sectionCount: number;
    linkCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    diagnosticCount: number;
    errorCount: number;
    warningCount: number;
    work: IndexReport["work"];
  }>;
};

type FixtureResult = {
  id: string;
  notes: number;
  repositoryFiles: number;
  index: {
    coldCliFullRebuild: RunMeasurement;
    warmFullRebuild: RunMeasurement;
    noOpTenPathBatch: RunMeasurement;
    tenNoteBodyEditBatch: RunMeasurement;
    sourceOpen: RunMeasurement;
    search: RunMeasurement;
  };
  packagedSidecar?: {
    bundle: string;
    launchToHealth: Timing;
    requests: Record<string, Timing>;
  };
};

type Arguments = {
  fixtures: FixtureSpec[];
  launchRepetitions: number;
  operationRepetitions: number;
  output?: string;
  bundle?: string;
};

const root = process.cwd();

function numberArgument(value: string | undefined, fallback: number, minimum = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function fixtureFromId(id: string): FixtureSpec {
  if (id === "F-100") return { id, notes: 100, repositoryFiles: 0 };
  if (id === "F-1K") return { id, notes: 1_000, repositoryFiles: 0 };
  if (id === "F-10K") return { id, notes: 10_000, repositoryFiles: 100_000 };
  throw new Error(`Unknown fixture '${id}'. Use F-100, F-1K, or F-10K.`);
}

function parseArguments(args: string[]): Arguments {
  const values = new Map(args.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")] as const;
  }));
  const fixtureIds = (values.get("fixtures") ?? process.env.CORTEX_BASELINE_FIXTURES ?? "F-100,F-1K")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const repositoryFilesOverride = process.env.CORTEX_BASELINE_REPO_FILES;
  const fixtures = fixtureIds.map((id) => {
    const fixture = fixtureFromId(id);
    if (repositoryFilesOverride !== undefined) fixture.repositoryFiles = numberArgument(repositoryFilesOverride, fixture.repositoryFiles, 0);
    return fixture;
  });
  return {
    fixtures,
    launchRepetitions: numberArgument(values.get("launch-repetitions") ?? process.env.CORTEX_BASELINE_LAUNCH_REPS, 30),
    operationRepetitions: numberArgument(values.get("operation-repetitions") ?? process.env.CORTEX_BASELINE_OPERATION_REPS, 300),
    output: values.get("output"),
    bundle: values.get("bundle") ?? process.env.CORTEX_BASELINE_BUNDLE,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}

function rss(): number {
  return process.memoryUsage().rss;
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function safeCommandOutput(command: string[]): string | undefined {
  try {
    return commandOutput(command) || undefined;
  } catch {
    return undefined;
  }
}

function createFixture(spec: FixtureSpec): { root: string; notePaths: string[] } {
  const fixtureRoot = join(tmpdir(), `cortex-desktop-baseline-${spec.id.toLowerCase()}-${crypto.randomUUID()}`);
  const vault = initVault(fixtureRoot);
  const notePaths: string[] = [];
  for (let index = 0; index < spec.notes; index += 1) {
    const relativePath = join("notes", `benchmark-${String(index).padStart(5, "0")}.md`);
    const absolutePath = join(vault, relativePath);
    const title = `Benchmark Note ${index}`;
    const previous = index === 0 ? "Project Map" : `Benchmark Note ${index - 1}`;
    const frontmatter = createFrontmatter({ title, tags: ["benchmark", index % 2 === 0 ? "even" : "odd"] });
    const body = `# ${title}\n\nThis deterministic fixture records note ${index}. See [[${previous}]].\n\n## Section ${index % 10}\n\nA stable paragraph for search and source-open measurements.\n`;
    writeFileSync(absolutePath, serializeFrontmatter(frontmatter) + body);
    notePaths.push(absolutePath);
  }
  for (let index = 0; index < spec.repositoryFiles; index += 1) {
    const relativePath = join("src", "fixture", `${String(index).padStart(6, "0")}.ts`);
    const absolutePath = join(vault, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, `export const fixture${index} = ${index};\n`);
  }
  return { root: vault, notePaths };
}

function compactReport(report: IndexReport): RunMeasurement["reports"][number] {
  const errorCount = report.diagnostics.filter((item) => item.severity === "error").length;
  return {
    mode: report.mode,
    changedPathCount: report.changedPaths.length,
    changedPathSample: report.changedPaths.slice(0, 3),
    noteCount: report.noteCount,
    sectionCount: report.sectionCount,
    linkCount: report.linkCount,
    graphNodeCount: report.graphNodeCount,
    graphEdgeCount: report.graphEdgeCount,
    diagnosticCount: report.diagnostics.length,
    errorCount,
    warningCount: report.diagnostics.length - errorCount,
    work: report.work,
  };
}

function measure<T>(repetitions: number, operation: () => T): { values: T[]; timing: Timing; rssBeforeBytes: number; rssAfterBytes: number; maxRssBytes: number } {
  const values: T[] = [];
  const durations: number[] = [];
  const rssBeforeBytes = rss();
  let maxRssBytes = rssBeforeBytes;
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    values.push(operation());
    durations.push(Math.round((performance.now() - started) * 100) / 100);
    maxRssBytes = Math.max(maxRssBytes, rss());
  }
  return { values, timing: summarize(durations), rssBeforeBytes, rssAfterBytes: rss(), maxRssBytes };
}

function measurementFromReports(
  result: ReturnType<typeof measure<IndexReport>>,
  requests: number,
): RunMeasurement {
  return {
    timing: result.timing,
    rssBeforeBytes: result.rssBeforeBytes,
    rssAfterBytes: result.rssAfterBytes,
    maxRssBytes: result.maxRssBytes,
    requests,
    reports: result.values.map(compactReport),
  };
}

function measurementOnly<T>(result: ReturnType<typeof measure<T>>, requests: number): RunMeasurement {
  return {
    timing: result.timing,
    rssBeforeBytes: result.rssBeforeBytes,
    rssAfterBytes: result.rssAfterBytes,
    maxRssBytes: result.maxRssBytes,
    requests,
    reports: [],
  };
}

function runCliFullRebuild(vault: string): IndexReport {
  const started = performance.now();
  // Keep the large JSON report out of a bounded subprocess pipe. F-10K has
  // 110,000 changed paths on a cold rebuild and can exceed the pipe buffer.
  const reportPath = join(tmpdir(), `cortex-desktop-baseline-report-${crypto.randomUUID()}.json`);
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "index", "--vault", vault], { cwd: root, stdout: Bun.file(reportPath), stderr: "pipe" });
  if (result.exitCode !== 0) {
    rmSync(reportPath, { force: true });
    throw new Error(`CLI baseline failed: ${result.stderr.toString().trim()}`);
  }
  const stdout = readFileSync(reportPath, "utf8");
  rmSync(reportPath, { force: true });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`CLI baseline returned no JSON report: ${stdout.slice(0, 500)}`);
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as IndexReport;
  return { ...parsed, durationMs: Math.round((performance.now() - started) * 100) / 100 };
}

function runIndexMeasurements(fixture: { root: string; notePaths: string[] }, args: Arguments): FixtureResult["index"] {
  const coldCli = measure(args.launchRepetitions, () => runCliFullRebuild(fixture.root));
  const coldCliMeasurement = measurementFromReports(coldCli, args.launchRepetitions);

  const indexer = new VaultIndexer(fixture.root);
  try {
    const warmFull = measure(3, () => indexer.fullRebuild());
    const selectedPaths = fixture.notePaths.slice(0, 10);
    const noOp = measure(args.operationRepetitions, () => indexer.incrementalRebuild(selectedPaths));
    const bodyEdits = measure(Math.max(3, Math.min(args.operationRepetitions, 30)), () => {
      for (const path of selectedPaths) appendFileSync(path, "\nMeasured body edit.\n");
      return indexer.incrementalRebuild(selectedPaths);
    });
    const sourceOpen = measure(args.operationRepetitions, () => {
      const path = selectedPaths[0];
      if (!path) throw new Error("Fixture did not create a note.");
      return indexer.store.noteByPath(path.slice(fixture.root.length + 1));
    });
    const search = measure(args.operationRepetitions, () => indexer.store.searchNotes("stable paragraph", 20));
    return {
      coldCliFullRebuild: coldCliMeasurement,
      warmFullRebuild: measurementFromReports(warmFull, 3),
      noOpTenPathBatch: measurementFromReports(noOp, args.operationRepetitions),
      tenNoteBodyEditBatch: measurementFromReports(bodyEdits, bodyEdits.values.length),
      sourceOpen: measurementOnly(sourceOpen, args.operationRepetitions),
      search: measurementOnly(search, args.operationRepetitions),
    };
  } finally {
    indexer.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free loopback port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The packaged sidecar may still be indexing or binding its port.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Packaged sidecar did not become healthy on port ${port}.`);
}

async function stopProcess(child: Bun.Subprocess): Promise<void> {
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runPackagedSidecar(bundle: string, vault: string, repetitions: number): Promise<NonNullable<FixtureResult["packagedSidecar"]>> {
  const sidecar = join(bundle, "Contents", "MacOS", "cortex-sidecar");
  const uiDist = join(bundle, "Contents", "Resources", "dist");
  if (!existsSync(sidecar) || !existsSync(uiDist)) throw new Error(`Bundle is missing the sidecar or UI resources: ${bundle}`);
  const port = await freePort();
  const launch = measure(repetitions, () => {
    const started = performance.now();
    const child = Bun.spawn([sidecar, "dev", "--vault", vault, "--port", String(port)], {
      cwd: uiDist,
      env: { ...Bun.env, CORTEX_PACKAGED: "1", CORTEX_UI_DIST: uiDist },
      stdout: "ignore",
      stderr: "ignore",
    });
    return { child, started };
  });
  const launchSamples: number[] = [];
  const requests: Record<string, Timing> = {};
  for (const item of launch.values) {
    await waitForHealth(port);
    launchSamples.push(Math.round((performance.now() - item.started) * 100) / 100);
    const endpoints = [
      ["health", `http://127.0.0.1:${port}/api/health`],
      ["notes", `http://127.0.0.1:${port}/api/notes?limit=20`],
      ["source", `http://127.0.0.1:${port}/api/note?selector=project-map.md&source=true`],
      ["search", `http://127.0.0.1:${port}/api/search?query=backend&limit=20`],
    ] as const;
    for (const [name, url] of endpoints) {
      const endpointSamples: number[] = [];
      for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
        const requestStarted = performance.now();
        const response = await fetch(url);
        await response.arrayBuffer();
        endpointSamples.push(Math.round((performance.now() - requestStarted) * 100) / 100);
      }
      requests[name] = summarize(endpointSamples);
    }
    await stopProcess(item.child);
  }
  return { bundle, launchToHealth: summarize(launchSamples), requests };
}

function environment(): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    sourceRevision: safeCommandOutput(["git", "rev-parse", "HEAD"]),
    branch: safeCommandOutput(["git", "branch", "--show-current"]),
    workingTreeDirty: safeCommandOutput(["git", "status", "--porcelain"]) !== undefined,
    platform: platform(),
    osRelease: release(),
    architecture: arch(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    homeDirectoryRecorded: Boolean(homedir()),
    bunVersion: Bun.version,
    nodeVersion: process.version,
    cwd: root,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const results: FixtureResult[] = [];
  for (const spec of args.fixtures) {
    const fixture = createFixture(spec);
    try {
      const result: FixtureResult = {
        id: spec.id,
        notes: spec.notes,
        repositoryFiles: spec.repositoryFiles,
        index: runIndexMeasurements(fixture, args),
      };
      if (args.bundle) result.packagedSidecar = await runPackagedSidecar(resolve(args.bundle), fixture.root, Math.min(3, args.launchRepetitions));
      results.push(result);
      console.log(`${spec.id}: collected ${args.launchRepetitions} CLI launch and ${args.operationRepetitions} interactive samples.`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const generatedAt = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = resolve(args.output ?? join(root, "bench", "results", `desktop-baseline-${generatedAt}.json`));
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify({
    schema: "cortex.desktop-baseline.v1",
    environment: environment(),
    protocol: {
      launchRepetitions: args.launchRepetitions,
      operationRepetitions: args.operationRepetitions,
      fixtureIds: args.fixtures.map((fixture) => fixture.id),
      packagedBundle: args.bundle ? basename(args.bundle) : null,
      nativeWindowMeasurement: "captured by companion scripts/native-desktop-baseline.ts; this protocol runner remains API/sidecar focused",
      noteContentsLogged: false,
    },
    results,
  }, null, 2) + "\n");
  console.log(`Desktop baseline written to ${output}`);
}

if (import.meta.main) await main();
