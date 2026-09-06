import { arch, cpus, platform, release, totalmem } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

type Timing = {
  samples: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
};

type Sample = { processMs: number; windowMs: number };

type Arguments = { bundle: string; repetitions: number; output?: string };

const root = process.cwd();

function parseArguments(args: string[]): Arguments {
  const values = new Map(args.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")] as const;
  }));
  const bundle = values.get("bundle") ?? process.env.CORTEX_BASELINE_BUNDLE;
  if (!bundle) throw new Error("Usage: bun run desktop:native-baseline -- --bundle=<Cortex.app> [--repetitions=3]");
  const repetitions = Number(values.get("repetitions") ?? process.env.CORTEX_NATIVE_REPS ?? 3);
  return { bundle: resolve(bundle), repetitions: Number.isFinite(repetitions) ? Math.max(1, Math.floor(repetitions)) : 3, output: values.get("output") };
}

function command(command: string[], allowFailure = false): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(values: number[]): Timing {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}

function processIsAlive(executable: string): boolean {
  return Bun.spawnSync(["pgrep", "-f", executable], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

function windowCount(): number | undefined {
  const script = 'tell application "System Events" to if exists process "Cortex" then tell process "Cortex" to count windows';
  const result = Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return undefined;
  const count = Number(result.stdout.toString().trim());
  return Number.isFinite(count) ? count : undefined;
}

async function waitFor(executable: string, predicate: () => boolean, timeoutMs: number): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return Math.round((performance.now() - started) * 100) / 100;
    await Bun.sleep(25);
  }
  throw new Error(`Cortex did not reach the requested native readiness state within ${timeoutMs}ms (${executable}).`);
}

async function stopExisting(executable: string): Promise<void> {
  if (!processIsAlive(executable)) return;
  command(["pkill", "-TERM", "-f", executable], true);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processIsAlive(executable)) await Bun.sleep(50);
  if (processIsAlive(executable)) command(["pkill", "-KILL", "-f", executable], true);
}

async function run(args: Arguments): Promise<void> {
  if (platform() !== "darwin") throw new Error("The native desktop harness currently supports macOS only.");
  if (!existsSync(args.bundle)) throw new Error(`Bundle does not exist: ${args.bundle}`);
  const executable = join(args.bundle, "Contents", "MacOS", "app");
  if (!existsSync(executable)) throw new Error(`Bundle executable does not exist: ${executable}`);

  const samples: Sample[] = [];
  let accessibilityObserved = true;
  for (let index = 0; index < args.repetitions; index += 1) {
    await stopExisting(executable);
    const started = performance.now();
    command(["open", "-n", args.bundle]);
    const processMs = await waitFor(executable, () => processIsAlive(executable), 20_000);
    const windowStarted = performance.now();
    let windowMs: number | undefined;
    try {
      windowMs = await waitFor(executable, () => (windowCount() ?? 0) > 0, 20_000);
    } catch {
      accessibilityObserved = false;
    }
    samples.push({ processMs: Math.round((performance.now() - started) * 100) / 100, windowMs: windowMs === undefined ? -1 : Math.round((windowStarted + windowMs - started) * 100) / 100 });
    await stopExisting(executable);
  }

  const output = args.output ? resolve(args.output) : join(root, "bench", "results", `desktop-native-baseline-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(join(output, ".."), { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: "packaged-native-window",
    bundle: basename(args.bundle),
    environment: { platform: platform(), macOsRelease: release(), architecture: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length, totalMemoryBytes: totalmem(), bunVersion: Bun.version, nodeVersion: process.version },
    readiness: {
      processLaunch: summarize(samples.map((sample) => sample.processMs)),
      nativeWindow: summarize(samples.map((sample) => sample.windowMs).filter((value) => value >= 0)),
      nativeWindowStatus: accessibilityObserved ? "measured via macOS System Events window availability" : `partial: measured ${samples.filter((sample) => sample.windowMs >= 0).length}/${samples.length}; at least one poll was denied or timed out`,
      note: "Window availability is the native launch/first-paint proxy; the harness does not claim React content readiness until a future in-app marker is added.",
    },
    samples,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, processLaunch: report.readiness.processLaunch, nativeWindow: report.readiness.nativeWindow, nativeWindowStatus: report.readiness.nativeWindowStatus }));
}

if (import.meta.main) await run(parseArguments(process.argv.slice(2)));
