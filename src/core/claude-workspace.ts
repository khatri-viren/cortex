import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of the Cortex installation itself. The CLI and hook scripts live here,
 * which is not the vault: a vault holds Markdown and has no `src/`.
 */
function cortexInstallRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export type ClaudeWorkspaceSetupResult = {
  workspaceRoot: string;
  vaultRoot: string;
  written: string[];
  skipped: string[];
};

function writeIfMissing(path: string, content: string, written: string[], skipped: string[]): void {
  if (existsSync(path)) {
    skipped.push(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  written.push(path);
}

export function setupClaudeWorkspaceConfig(vaultRoot: string, workspaceRoot: string): ClaudeWorkspaceSetupResult {
  const root = resolve(workspaceRoot);
  const vault = resolve(vaultRoot);
  const install = cortexInstallRoot();
  const written: string[] = [];
  const skipped: string[] = [];

  const mcpConfig = {
    mcpServers: {
      cortex: {
        type: "stdio",
        command: "bun",
        args: ["run", join(install, "src", "cli.ts"), "mcp", "--vault", vault, "--workspace", root],
        env: {},
      },
    },
  };
  writeIfMissing(join(root, ".mcp.json"), `${JSON.stringify(mcpConfig, null, 2)}\n`, written, skipped);

  const hookCommand = (script: string) =>
    `CORTEX_VAULT_ROOT="${vault}" CORTEX_WORKSPACE_ROOT="${root}" bun run "${join(install, "src", "claude-hooks.ts")}" ${script}`;

  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCommand("session-start"), timeout: 5 }] },
      ],
      PostToolUse: [
        { matcher: "Edit|Write", hooks: [{ type: "command", command: hookCommand("reindex"), timeout: 3 }] },
      ],
    },
  };
  writeIfMissing(join(root, ".claude", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, written, skipped);

  return { workspaceRoot: root, vaultRoot: vault, written, skipped };
}
