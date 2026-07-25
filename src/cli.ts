import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, requireGitVault, scanVault, vaultHasExpectedGitIgnore } from "./core/vault.js";
import { migrateVault } from "./core/migration.js";
import { parseMarkdown } from "./core/markdown.js";
import { VaultIndexer } from "./core/indexer.js";
import { GitAdapter } from "./core/git.js";
import { MCP_TOOL_NAMES, runMcpServer } from "./mcp/server.js";
import { createApiServer } from "./api/server.js";
import { VaultRuntime } from "./mcp/service.js";
import { initializeWorkspaceManifest, loadWorkspaceConfig, removeWorkspaceRepository } from "./core/workspace.js";
import { WorkspaceIndexer } from "./core/workspace-indexer.js";
import { setupClaudeWorkspaceConfig } from "./core/claude-workspace.js";

type CliOptions = {
  command: string;
  positionals: string[];
  vault?: string;
  workspace?: string;
  include: string[];
  dryRun: boolean;
  check: boolean;
  port?: number;
};

function parseCli(args: string[]): CliOptions {
  const [command = "help", ...rest] = args;
  const positionals: string[] = [];
  let vault: string | undefined;
  let workspace: string | undefined;
  const include: string[] = [];
  let port: number | undefined;
  let dryRun = false;
  let check = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--vault") vault = rest[++index];
    else if (arg === "--workspace") workspace = rest[++index];
    else if (arg === "--include") include.push(...(rest[++index] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--port") port = Number(rest[++index]);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--help" || arg === "-h") positionals.push("--help");
    else positionals.push(arg);
  }

  return { command, positionals, vault, workspace, include, dryRun, check, port };
}

function vaultArgument(options: CliOptions): string {
  const value = options.vault ?? process.env.CORTEX_VAULT_ROOT ?? process.env.CLAUDE_PROJECT_DIR;
  if (!value) throw new Error("A vault is required. Pass --vault <path>, set CORTEX_VAULT_ROOT, or run from a Claude project with CLAUDE_PROJECT_DIR.");
  return resolve(value);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): void {
  console.log(`Cortex Phase 3\n\nCommands:\n  dev [--vault <path>] [--workspace <path>] [--port <port>]\n  parse <file>\n  index --vault <path> [--workspace <path>]\n  vault:init <path>\n  vault:check --vault <path>\n  migrate --vault <path> [--dry-run]\n  mcp --vault <path> [--workspace <path>] [--check]\n  workspace:init --vault <path> --workspace <path> [--include <repo,repo>]\n  workspace:check --vault <path>\n  workspace:remove-repository --vault <path> <repository-id>\n  workspace:setup-claude --vault <path> --workspace <path>\n  git:status --vault <path>\n  git:history --vault <path> <note-path>\n  git:diff --vault <path> <note-path> [revision]\n  git:restore --vault <path> <note-path> <revision>`);
}

async function runDev(options: CliOptions): Promise<void> {
  const vaultRoot = requireGitVault(vaultArgument(options));
  const runtime = await VaultRuntime.start(vaultRoot, { workspaceRoot: options.workspace });
  const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui", "dist");
  const server = createApiServer(runtime, options.port ?? 4170, uiDist);
  const shutdown = async () => {
    server.stop();
    await runtime.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  console.log(JSON.stringify({ status: "ready", phase: 3, vaultRoot, url: String("http://") + server.hostname + ":" + server.port, index: runtime.indexer.store.counts(), workspace: runtime.workspaceStatus() }));
}

function runParse(options: CliOptions): void {
  const filePath = options.positionals.find((value) => value !== "--help");
  if (!filePath) throw new Error("Usage: bun run parse -- <file>");
  if (!existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
  print(parseMarkdown(readFileSync(filePath, "utf8"), resolve(filePath)));
}

function runIndex(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  const indexer = new VaultIndexer(vaultRoot);
  try {
    const report = indexer.fullRebuild();
    let workspaceReport;
    if (options.workspace || process.env.CORTEX_WORKSPACE_ROOT || existsSync(resolve(vaultRoot, "workspace.yaml"))) {
      const workspace = loadWorkspaceConfig(vaultRoot, options.workspace);
      const workspaceIndexer = new WorkspaceIndexer(indexer.store, workspace);
      workspaceReport = workspaceIndexer.fullRebuild();
    }
    print(workspaceReport ? { ...report, workspace: workspaceReport } : report);
    if (report.diagnostics.some((item) => item.severity === "error") || workspaceReport?.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
  } finally {
    indexer.close();
  }
}

function runWorkspaceInit(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  if (!options.workspace) throw new Error("Usage: bun run workspace:init -- --vault <path> --workspace <path> [--include <repo,repo>]");
  const workspace = initializeWorkspaceManifest(vaultRoot, options.workspace, options.include);
  print({ workspaceRoot: workspace.workspaceRoot, repositories: workspace.repositories, diagnostics: workspace.diagnostics });
}

function runWorkspaceCheck(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  const workspace = loadWorkspaceConfig(vaultRoot, options.workspace);
  print({ workspaceRoot: workspace.workspaceRoot, workspaceExists: workspace.workspaceExists, repositories: workspace.repositories, diagnostics: workspace.diagnostics });
  if (workspace.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
}

function runWorkspaceRemoveRepository(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  const repositoryId = options.positionals[0];
  if (!repositoryId) throw new Error("Usage: bun run workspace:remove-repository -- --vault <path> <repository-id>");
  print({ manifest: removeWorkspaceRepository(vaultRoot, repositoryId) });
}

function runWorkspaceSetupClaude(options: CliOptions): void {
  const vaultRoot = requireGitVault(vaultArgument(options));
  const workspace = loadWorkspaceConfig(vaultRoot, options.workspace);
  print(setupClaudeWorkspaceConfig(vaultRoot, workspace.workspaceRoot));
}

function runCheck(options: CliOptions): void {
  const vaultRoot = vaultArgument(options);
  const scan = scanVault(vaultRoot);
  const diagnostics = [...scan.diagnostics];
  if (!vaultHasExpectedGitIgnore(vaultRoot)) {
    diagnostics.push({ severity: "warning", code: "invalid-gitignore", message: "Vault .gitignore does not cover runtime data.", filePath: `${vaultRoot}/.gitignore` });
  }
  let index;
  const indexer = new VaultIndexer(vaultRoot);
  try {
    index = indexer.store.counts();
  } finally {
    indexer.close();
  }
  print({ vaultRoot: scan.vaultRoot, diagnostics, index, ok: !diagnostics.some((item) => item.severity === "error") });
  if (diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
}

function runMigrate(options: CliOptions): void {
  const changes = migrateVault(vaultArgument(options), options.dryRun);
  print({ dryRun: options.dryRun, changedCount: changes.filter((item) => item.changed).length, changes });
}

function runGit(options: CliOptions): void {
  const git = new GitAdapter(vaultArgument(options));
  const path = options.positionals[0];
  switch (options.command) {
    case "git:status":
      print(git.status());
      return;
    case "git:history":
      if (!path) throw new Error("Usage: bun run git:history -- --vault <path> <note-path>");
      print(git.history(path));
      return;
    case "git:diff":
      if (!path) throw new Error("Usage: bun run git:diff -- --vault <path> <note-path> [revision]");
      print({ path, diff: git.diff(path, options.positionals[1]) });
      return;
    case "git:restore":
      if (!path || !options.positionals[1]) throw new Error("Usage: bun run git:restore -- --vault <path> <note-path> <revision>");
      git.restore(path, options.positionals[1]);
      const indexer = new VaultIndexer(git.vaultRoot);
      try {
        const report = indexer.incrementalRebuild([resolve(git.vaultRoot, path)]);
        print({ restored: path, revision: options.positionals[1], index: report });
      } finally {
        indexer.close();
      }
      return;
  }
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
    case "workspace:init":
      runWorkspaceInit(options);
      return;
    case "workspace:check":
      runWorkspaceCheck(options);
      return;
    case "workspace:remove-repository":
      runWorkspaceRemoveRepository(options);
      return;
    case "workspace:setup-claude":
      runWorkspaceSetupClaude(options);
      return;
    case "git:status":
    case "git:history":
    case "git:diff":
    case "git:restore":
      runGit(options);
      return;
    case "mcp":
      if (options.check) {
        const vaultRoot = requireGitVault(vaultArgument(options));
        print({ status: "ready", phase: 3, transport: "stdio", vaultRoot, tools: MCP_TOOL_NAMES });
      } else {
        await runMcpServer(vaultArgument(options), { workspaceRoot: options.workspace });
      }
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
