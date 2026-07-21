import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, requireGitVault, scanVault, vaultHasExpectedGitIgnore } from "./core/vault.js";
import { migrateVault } from "./core/migration.js";
import { parseMarkdown } from "./core/markdown.js";

type CliOptions = {
  command: string;
  positionals: string[];
  vault?: string;
  dryRun: boolean;
  check: boolean;
  port?: number;
};

function parseCli(args: string[]): CliOptions {
  const [command = "help", ...rest] = args;
  const positionals: string[] = [];
  let vault: string | undefined;
  let port: number | undefined;
  let dryRun = false;
  let check = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--vault") vault = rest[++index];
    else if (arg === "--port") port = Number(rest[++index]);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--help" || arg === "-h") positionals.push("--help");
    else positionals.push(arg);
  }

  return { command, positionals, vault, dryRun, check, port };
}

function vaultArgument(options: CliOptions): string {
  const value = options.vault ?? process.env.CORTEX_VAULT_ROOT;
  if (!value) throw new Error("A vault is required. Pass --vault <path> or set CORTEX_VAULT_ROOT.");
  return resolve(value);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): void {
  console.log(`Cortex Phase 0\n\nCommands:\n  dev [--vault <path>] [--port <port>]\n  parse <file>\n  index --vault <path>\n  vault:init <path>\n  vault:check --vault <path>\n  migrate --vault <path> [--dry-run]\n  mcp --vault <path> --check`);
}

async function runDev(options: CliOptions): Promise<void> {
  const vaultRoot = requireGitVault(vaultArgument(options));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", phase: 0, vaultRoot });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(JSON.stringify({ status: "ready", phase: 0, vaultRoot, url: `http://${server.hostname}:${server.port}` }));
}

function runParse(options: CliOptions): void {
  const filePath = options.positionals.find((value) => value !== "--help");
  if (!filePath) throw new Error("Usage: bun run parse -- <file>");
  if (!existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
  print(parseMarkdown(readFileSync(filePath, "utf8"), resolve(filePath)));
}

function runIndex(options: CliOptions): void {
  const scan = scanVault(vaultArgument(options));
  print({
    vaultRoot: scan.vaultRoot,
    files: scan.files,
    noteCount: scan.noteCount,
    linkCount: scan.linkCount,
    sectionCount: scan.sectionCount,
    diagnostics: scan.diagnostics,
  });
  if (scan.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
}

function runCheck(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  const scan = scanVault(vaultRoot);
  const diagnostics = [...scan.diagnostics];
  if (!vaultHasExpectedGitIgnore(vaultRoot)) {
    diagnostics.push({ severity: "warning", code: "invalid-gitignore", message: "Vault .gitignore does not cover runtime data.", filePath: `${vaultRoot}/.gitignore` });
  }
  print({ vaultRoot: scan.vaultRoot, diagnostics, ok: !diagnostics.some((item) => item.severity === "error") });
  if (diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
}

function runMigrate(options: CliOptions): void {
  const changes = migrateVault(vaultArgument(options), options.dryRun);
  print({ dryRun: options.dryRun, changedCount: changes.filter((item) => item.changed).length, changes });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.positionals.includes("--help") || options.command === "help") {
    help();
    return;
  }

  switch (options.command) {
    case "dev":
      await runDev(options);
      return;
    case "parse":
      runParse(options);
      return;
    case "index":
      runIndex(options);
      return;
    case "vault:init":
      if (!options.positionals[0]) throw new Error("Usage: bun run vault:init -- <path>");
      print({ vaultRoot: initVault(options.positionals[0]) });
      return;
    case "vault:check":
      runCheck(options);
      return;
    case "migrate":
      runMigrate(options);
      return;
    case "mcp":
      requireGitVault(vaultArgument(options));
      if (!options.check) throw new Error("Phase 0 only supports 'mcp --check'; full MCP starts in Phase 2.");
      print({ status: "ready", phase: 0, transport: "stdio", tools: [] });
      return;
    default:
      help();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
