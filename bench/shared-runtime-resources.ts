import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault } from "../src/core/vault.js";
import { initializeWorkspaceManifest } from "../src/core/workspace.js";

const binary = resolve(process.argv[2] ?? "/Applications/Cortex.app/Contents/MacOS/cortex-sidecar");
const duration = Number(process.argv[3] ?? 1800);
const reportPath = resolve(process.argv[4] ?? "/tmp/cortex-shared-runtime-resources.json");
const root = mkdtempSync(join(tmpdir(), "cortex-shared-resources-"));
const vault = initVault(join(root, "vault"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
for (let r = 0; r < 13; r++) {
  const repo = join(workspace, "repo-" + r);
  mkdirSync(repo);
  if (spawnSync("git", ["init", "-q", repo]).status !== 0) throw new Error("git init failed");
  for (let f = 0; f < 1000; f++) writeFileSync(join(repo, "file-" + f + ".ts"), `export const value = ${f};\n`);
}
const manifest = initializeWorkspaceManifest(vault, workspace);
for (let n = 0; n < 100; n++) {
  writeFileSync(join(vault, "notes", "benchmark-" + n + ".md"),
    `---\nid: ${crypto.randomUUID()}\ntitle: Benchmark ${n}\ntype: note\ncreated_at: 2026-10-22T00:00:00.000Z\nupdated_at: 2026-10-22T00:00:00.000Z\n---\n# Benchmark ${n}\n\nDeterministic fixture.\n`);
}
type Usage = { pid: number; cpuSeconds: number; rss: number; footprint: number; writes: number };
const sampler = `import ctypes,json,sys
class Usage(ctypes.Structure):
 _fields_=[("uuid",ctypes.c_uint8*16)]+[(name,ctypes.c_uint64) for name in ["user","system","idle","interrupt","pageins","wired","resident","footprint","start","exit","child_user","child_system","child_idle","child_interrupt","child_pageins","child_elapsed","read","written"]]
lib=ctypes.CDLL("/usr/lib/libproc.dylib")
rows=[]
for pid in json.loads(sys.argv[1]):
 usage=Usage()
 if lib.proc_pid_rusage(pid,2,ctypes.byref(usage)) != 0: raise RuntimeError("Process disappeared: "+str(pid))
 rows.append(dict(pid=pid,cpuSeconds=(usage.user+usage.system)/1e9,rss=usage.resident,footprint=usage.footprint,writes=usage.written))
print(json.dumps(rows))`;
function usage(pids: number[]): Usage[] {
  const result = spawnSync("python3", ["-c", sampler, JSON.stringify(pids)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}
let interrupted = false;
process.once("SIGTERM", () => { interrupted = true; });
process.once("SIGINT", () => { interrupted = true; });
const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
let desktop: Bun.Subprocess | undefined;
let ownerPid: number | undefined;
let endpoint: { pid: number; port: number; token: string };
const env: Record<string, string> = { ...process.env as Record<string, string>, CORTEX_PACKAGED: "1" };
// Intentionally omit NODE_PATH/UI/Chromium overrides: prove a standalone MCP
// launch resolves installed resources while its cwd is outside the checkout.
delete env.NODE_PATH; delete env.CORTEX_UI_DIST; delete env.CORTEX_CHROMIUM_PATH; delete env.CORTEX_PACKAGED_CHROMIUM_PATH;
async function connect() {
  const transport = new StdioClientTransport({ command: binary, args: ["mcp", "--vault", vault], env, cwd: root, stderr: "ignore" });
  const client = new Client({ name: "resource-validation", version: "1" });
  transports.push(transport); clients.push(client);
  await client.connect(transport);
}
async function api(path: string) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}` + path, { headers: { authorization: "Bearer " + endpoint.token } });
  if (!response.ok) throw new Error("API failed: " + response.status);
  return response.json() as Promise<Record<string, any>>;
}
try {
  await connect();
  endpoint = JSON.parse(readFileSync(join(vault, ".cortex/runtime-owner/owner.json"), "utf8"));
  ownerPid = endpoint.pid;
  for (let n = 0; n < 480; n++) {
    const health = await api("/api/health");
    if (health.workspace.phase === "error") throw new Error(health.workspace.error);
    if (health.workspace.phase === "current") {
      if (health.watchers.vault !== "native" || health.watchers.workspace.native !== 13) throw new Error("Native watchers are not active");
      break;
    }
    if (n === 479) throw new Error("Projection warming timed out");
    await Bun.sleep(250);
  }
  await Bun.sleep(3000);
  const baseline = usage([ownerPid, transports[0].pid!]);
  await Promise.all(Array.from({ length: 11 }, connect));
  const socket = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  desktop = Bun.spawn([binary, "dev", "--vault", vault, "--port", String(port)], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
  for (let n = 0; n < 200; n++) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()) as { sharedRuntime?: { pid: number } };
      if (health.sharedRuntime?.pid === ownerPid) break;
    } catch {}
    if (n === 199) throw new Error("Desktop proxy failed");
    await Bun.sleep(50);
  }
  const status = await api("/_runtime/status");
  if (status.sessions !== 12 || status.leases !== 13) throw new Error("Incorrect client ownership counts");
  const current = (await api("/api/changes?since=0")).sequence;
  const edited = join(workspace, "repo-0/file-0.ts");
  writeFileSync(edited, "import { value } from './file-1.js'; export const changed = value;\n");
  for (let n = 0; n < 200; n++) {
    const changes = await api("/api/changes?since=" + current);
    if (changes.sequence > current && changes.changes.some((change: any) => change.events.some((event: any) => event.repository === "repo-0"))) break;
    if (n === 199) throw new Error("Packaged repository change was not indexed");
    await Bun.sleep(50);
  }
  await Bun.sleep(5000);
  const pids = [ownerPid, ...transports.map(transport => transport.pid!), desktop.pid];
  const snapshots: Array<{ elapsed: number; usage: Usage[] }> = [];
  const start = performance.now();
  let announced = -1;
  console.log(JSON.stringify({ phase: "idle-start", durationSeconds: duration, ownerPid, clients: 12, desktop: 1, repositories: manifest.repositories.length, repositoryFiles: 13000, notes: 100 }));
  while (true) {
    if (interrupted) throw new Error("Resource certification interrupted");
    const elapsed = (performance.now() - start) / 1000;
    snapshots.push({ elapsed, usage: usage(pids) });
    const status = await api("/_runtime/status");
    if (status.pid !== ownerPid || status.sessions !== 12 || status.leases !== 13) throw new Error("Ownership or session count changed during idle run");
    const minute = Math.floor(elapsed / 60);
    if (minute !== announced) {
      announced = minute;
      writeFileSync(reportPath + ".progress", JSON.stringify({ elapsedSeconds: elapsed, ownerPid, samples: snapshots.length, last: snapshots.at(-1) }));
      console.log(JSON.stringify({ phase: "idle-progress", elapsedSeconds: Math.round(elapsed), samples: snapshots.length }));
    }
    if (elapsed >= duration) break;
    await Bun.sleep(Math.min(5000, (duration - elapsed) * 1000));
  }
  const first = snapshots[0], last = snapshots.at(-1)!;
  const seconds = last.elapsed - first.elapsed;
  const perProcess = last.usage.map(end => {
    const begin = first.usage.find(row => row.pid === end.pid)!;
    return { pid: end.pid, role: end.pid === ownerPid ? "owner" : end.pid === desktop!.pid ? "desktop-bridge" : "mcp-bridge",
      averageCpuPercentOfOneCore: (end.cpuSeconds - begin.cpuSeconds) / seconds * 100,
      diskBytesWritten: end.writes - begin.writes, initialFootprintMiB: begin.footprint / 1048576,
      finalFootprintMiB: end.footprint / 1048576,
      maxFootprintMiB: Math.max(...snapshots.map(sample => sample.usage.find(row => row.pid === end.pid)!.footprint)) / 1048576 };
  });
  const result = { binary, fixture: { repositories: 13, repositoryFiles: 13000, notes: 100, clients: 12, desktopBridges: 1 },
    durationSeconds: seconds, baselineOneClient: baseline, perProcess,
    aggregateCpuPercentOfOneCore: perProcess.reduce((n, row) => n + row.averageCpuPercentOfOneCore, 0),
    aggregateDiskBytesWritten: perProcess.reduce((n, row) => n + row.diskBytesWritten, 0),
    initialFootprintMiB: perProcess.reduce((n, row) => n + row.initialFootprintMiB, 0),
    finalFootprintMiB: perProcess.reduce((n, row) => n + row.finalFootprintMiB, 0),
    snapshots };
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase: "complete", reportPath, aggregateCpuPercentOfOneCore: result.aggregateCpuPercentOfOneCore, aggregateDiskBytesWritten: result.aggregateDiskBytesWritten, finalFootprintMiB: result.finalFootprintMiB }));
  if (perProcess.find(row => row.pid === ownerPid)!.averageCpuPercentOfOneCore >= 1) throw new Error("Owner failed the proposed idle CPU budget");
} finally {
  if (desktop) { desktop.kill("SIGTERM"); await desktop.exited; }
  await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  if (ownerPid) {
    // Leave no fixture watcher running after deleting its source roots.
    try { process.kill(ownerPid, "SIGTERM"); } catch {}
    for (let n = 0; n < 100; n++) { try { process.kill(ownerPid, 0); } catch { break; } await Bun.sleep(30); }
  }
  rmSync(root, { recursive: true, force: true });
}
