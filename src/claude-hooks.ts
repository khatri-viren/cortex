import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildSessionContext, reindexChangedPath, retryOnce } from "./core/claude-context.js";

type HookInput = {
  tool_input?: { file_path?: string; path?: string };
  file_path?: string;
  path?: string;
};

function vaultRoot(): string {
  return resolve(process.env.CORTEX_VAULT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

async function readInput(): Promise<HookInput> {
  const raw = await new Response(Bun.stdin.stream()).text();
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as HookInput : {};
  } catch {
    return {};
  }
}

function output(event: "SessionStart" | "PostToolUse", additionalContext: string): void {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

function warning(event: "SessionStart" | "PostToolUse", cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error("Cortex hook warning: " + message);
  output(event, "Cortex freshness warning: " + message);
}

async function runSessionStart(): Promise<void> {
  try {
    const result = buildSessionContext(vaultRoot());
    output("SessionStart", result.context);
  } catch (cause) {
    warning("SessionStart", cause);
  }
}

function changedPath(input: HookInput): string | undefined {
  return input.tool_input?.file_path ?? input.tool_input?.path ?? input.file_path ?? input.path;
}

async function runReindex(): Promise<void> {
  const input = await readInput();
  const path = changedPath(input);
  if (!path) return;
  try {
    await retryOnce(() => reindexChangedPath(vaultRoot(), path));
  } catch (cause) {
    warning("PostToolUse", cause);
  }
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "session-start":
      await runSessionStart();
      return;
    case "reindex":
      await runReindex();
      return;
    default:
      throw new Error("Usage: bun run src/claude-hooks.ts <session-start|reindex>");
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
