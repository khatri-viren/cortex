import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { initVault } from "../src/core/vault.js";

interface SmokeArguments {
  bundle: string;
}

function parseArguments(args: string[]): SmokeArguments {
  const bundle = args.find((arg) => arg.startsWith("--bundle="))?.slice("--bundle=".length);
  if (!bundle) throw new Error("Usage: bun run scripts/packaged-smoke.ts --bundle=<Cortex.app>");
  return { bundle: resolve(bundle) };
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

async function waitForHealth(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {
      // The packaged sidecar may still be indexing or binding its port.
    }
    await Bun.sleep(150);
  }
  throw new Error(`Packaged sidecar did not become healthy on port ${port}.`);
}

function markdownSnapshot(root: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === ".git" || entry === ".cortex") continue;
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (entry.endsWith(".md")) files.push(path);
    }
  };
  visit(root);
  return files.sort().map((path) => `${path.slice(root.length)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`).join("\n");
}

async function stopProcess(process: Bun.Subprocess): Promise<void> {
  process.kill("SIGTERM");
  await Promise.race([process.exited, Bun.sleep(3_000)]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

async function runSmoke(args: SmokeArguments): Promise<void> {
  const sidecar = join(args.bundle, "Contents", "MacOS", "cortex-sidecar");
  const uiDist = join(args.bundle, "Contents", "Resources", "dist");
  const tempRoot = join(Bun.env.TMPDIR ?? "/tmp", `cortex-packaged-smoke-${crypto.randomUUID()}`);
  const vaultA = join(tempRoot, "vault-a");
  const vaultB = join(tempRoot, "vault-b");
  const children: Bun.Subprocess[] = [];
  try {
    if (!statSync(sidecar).isFile() || !statSync(uiDist).isDirectory()) throw new Error("Bundle is missing the release sidecar or UI resources.");
    initVault(vaultA);
    initVault(vaultB);
    const snapshots = [markdownSnapshot(vaultA), markdownSnapshot(vaultB)];
    const ports = await Promise.all([freePort(), freePort()]);
    for (const [vault, port] of [[vaultA, ports[0]], [vaultB, ports[1]]] as const) {
      const child = Bun.spawn([sidecar, "dev", "--vault", vault, "--port", String(port)], {
        cwd: uiDist,
        env: { ...Bun.env, CORTEX_PACKAGED: "1", CORTEX_UI_DIST: uiDist },
        stdout: "ignore",
        stderr: "ignore",
      });
      children.push(child);
    }
    const health = await Promise.all(ports.map(waitForHealth));
    if (health.some((item) => item.status !== "ok")) throw new Error("A packaged vault runtime did not report status=ok.");
    const responses = await Promise.all(ports.map((port) => fetch(`http://127.0.0.1:${port}/`)));
    if (responses.some((response) => !response.ok)) throw new Error("A packaged runtime did not serve the bundled UI.");
    const html = await Promise.all(responses.map((response) => response.text()));
    if (html.some((document) => !document.toLowerCase().includes("<!doctype html>"))) throw new Error("A packaged runtime did not serve an HTML document.");
    if (markdownSnapshot(vaultA) !== snapshots[0] || markdownSnapshot(vaultB) !== snapshots[1]) throw new Error("Packaged runtime changed vault Markdown.");
    console.log(`Packaged two-vault smoke passed for ${basename(args.bundle)} on ports ${ports.join(" and ")}.`);
  } finally {
    await Promise.all(children.map(stopProcess));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await runSmoke(parseArguments(process.argv.slice(2)));
