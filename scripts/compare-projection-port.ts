import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { initVault, vaultFiles } from "../src/core/vault.js";

type FileEntry = { path: string; bytes: number };
type Inventory = { files: FileEntry[]; file_count: number; markdown_count: number; total_bytes: number };

function numberArg(args: string[], name: string, fallback: number): number {
  const value = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function jsInventory(root: string): Inventory {
  const files = vaultFiles(root).map((absolute) => ({ path: relative(root, absolute).replaceAll("\\", "/"), bytes: statSync(absolute).size }));
  return {
    files,
    file_count: files.length,
    markdown_count: files.filter((entry) => entry.path.toLowerCase().endsWith(".md")).length,
    total_bytes: files.reduce((total, entry) => total + entry.bytes, 0),
  };
}

function fingerprint(inventory: Inventory): string {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

function sampleVault(noteCount: number): string {
  const root = join(mkdtempSync(join(tmpdir(), "cortex-s6-port-")), "vault");
  const vault = initVault(root);
  for (let index = 0; index < noteCount; index += 1) {
    const path = join(vault, "notes", `fixture-${String(index).padStart(5, "0")}.md`);
    writeFileSync(path, `---\nid: ${crypto.randomUUID()}\ntitle: Fixture ${index}\ntype: note\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n\n# Fixture ${index}\n\nBody ${index}.\n`);
  }
  for (let index = 0; index < noteCount * 2; index += 1) {
    const path = join(vault, "src", `${String(index).padStart(5, "0")}.ts`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `export const fixture${index} = ${index};\n`);
  }
  mkdirSync(join(vault, ".cortex"), { recursive: true });
  writeFileSync(join(vault, ".cortex", "ignored.sqlite"), "projection");
  mkdirSync(join(vault, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(vault, "node_modules", "ignored", "package.js"), "ignored");
  return vault;
}

function rustInventory(root: string, binary: string): Inventory {
  const result = Bun.spawnSync([binary, root], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Rust projection probe failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString()) as Inventory;
}

function measure(repetitions: number, operation: () => Inventory): { medianMs: number; p95Ms: number; samples: number[] } {
  const samples: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    operation();
    samples.push(Math.round((performance.now() - started) * 100) / 100);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return { medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0, p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0, samples };
}

const args = process.argv.slice(2);
const noteCount = numberArg(args, "notes", 1_000);
const repetitions = numberArg(args, "repetitions", 5);
const vault = args.find((arg) => arg.startsWith("--vault="))?.slice("--vault=".length) ?? sampleVault(noteCount);
const baselinePath = args.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
if (!existsSync(vault)) throw new Error(`Vault does not exist: ${vault}`);

const binary = resolve("ui/src-tauri/target/debug/projection_probe");
const buildStarted = performance.now();
const build = Bun.spawnSync(["cargo", "build", "--quiet", "--manifest-path", "ui/src-tauri/Cargo.toml", "--features", "projection-probe", "--bin", "projection_probe"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`Rust projection probe build failed: ${build.stderr.toString()}`);
const buildMs = Math.round((performance.now() - buildStarted) * 100) / 100;

const js = jsInventory(resolve(vault));
const rust = rustInventory(resolve(vault), binary);
const parity = JSON.stringify(js) === JSON.stringify(rust);
const jsTiming = measure(repetitions, () => jsInventory(resolve(vault)));
const rustTiming = measure(repetitions, () => rustInventory(resolve(vault), binary));
const baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) as { environment?: { sourceRevision?: string }; results?: Array<{ id: string; index: Record<string, { timing: unknown }> }> } : undefined;
const report = {
  schema: "cortex.s6.projection-port.v1",
  vault: resolve(vault),
  fixture: { notes: noteCount, source: args.some((arg) => arg.startsWith("--vault=")) ? "provided" : "generated" },
  parity: { exact: parity, javascriptFingerprint: fingerprint(js), rustFingerprint: fingerprint(rust), fileCount: js.file_count, markdownCount: js.markdown_count, totalBytes: js.total_bytes },
  timing: { buildMs, javascript: jsTiming, rust: rustTiming, isolatedSpeedup: jsTiming.medianMs > 0 ? jsTiming.medianMs / Math.max(rustTiming.medianMs, 0.01) : 0 },
  residualProfile: baseline?.results?.[0] ? { sourceRevision: baseline.environment?.sourceRevision, fixture: baseline.results[0].id, index: baseline.results[0].index } : null,
  migrationCost: { scope: "file-inventory primitive only", rustSourceLines: readFileSync("ui/src-tauri/src/bin/projection_probe.rs", "utf8").split(/\r?\n/).length, newRuntimeDependencies: 0, productionIntegration: false, cargoBuildMs: buildMs },
  decision: parity ? "Keep the Rust port isolated; do not rewrite the projection backend until a parser/graph port demonstrates end-to-end gain beyond the already-bounded S3 path." : "Reject the port until semantic parity is restored.",
};
console.log(JSON.stringify(report, null, 2));
