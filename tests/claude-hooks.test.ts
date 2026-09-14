import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, reindexChangedPath } from "../src/core/claude-context.js";
import { initVault } from "../src/core/vault.js";

function temporaryVault(): string {
  return initVault(join(mkdtempSync(join(tmpdir(), "cortex-phase2b-")), "vault"));
}

function runHook(vault: string, command: string, input?: unknown) {
  return spawnSync(process.execPath, ["run", "src/claude-hooks.ts", command], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_PROJECT_DIR: vault, CORTEX_VAULT_ROOT: "" },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
}

describe("Phase 2b Claude integration", () => {
  test("builds a bounded factual startup context and rebuilds only when needed", () => {
    const vault = temporaryVault();
    const secret = "DO NOT INCLUDE THIS NOTE BODY IN STARTUP CONTEXT";
    writeFileSync(join(vault, "notes", "engine.md"), readFileSync(join(vault, "notes", "engine.md"), "utf8") + "\n" + secret + "\n");

    const first = buildSessionContext(vault);
    expect(first.rebuilt).toBe(true);
    expect(first.tokenEstimate).toBeLessThanOrEqual(600);
    expect(first.context).toContain("Cortex project:");
    expect(first.context).toContain("Counts:");
    expect(first.context).toContain("project_map/get_context");
    expect(first.context).not.toContain(secret);

    const second = buildSessionContext(vault);
    expect(second.rebuilt).toBe(false);
    expect(second.context).toContain("Index: current");

    writeFileSync(join(vault, "notes", "engine.md"), readFileSync(join(vault, "notes", "engine.md"), "utf8") + "\nNew session refresh marker.\n");
    const refreshed = buildSessionContext(vault);
    expect(refreshed.rebuilt).toBe(true);
    expect(refreshed.context).toContain("Index: rebuilt");

    const dbPath = join(vault, ".cortex", "index.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    expect(buildSessionContext(vault).rebuilt).toBe(true);
  });

  test("hash-checks edits, handles deletes, and ignores runtime paths", () => {
    const vault = temporaryVault();
    const notePath = join(vault, "notes", "engine.md");
    buildSessionContext(vault);

    writeFileSync(notePath, readFileSync(notePath, "utf8") + "\nHook refresh marker.\n");
    expect(reindexChangedPath(vault, notePath).status).toBe("reindexed");
    expect(reindexChangedPath(vault, notePath)).toMatchObject({ status: "skipped", reason: "content-unchanged" });

    unlinkSync(notePath);
    expect(reindexChangedPath(vault, notePath).status).toBe("reindexed");
    expect(reindexChangedPath(vault, join(vault, ".cortex", "index.sqlite"))).toMatchObject({ status: "skipped", reason: "ignored-path" });
    expect(() => reindexChangedPath(vault, join(vault, "..", "outside.md"))).toThrow("outside");
  });

  test("speaks the Claude hook JSON contract and fails open", () => {
    const vault = temporaryVault();
    const session = runHook(vault, "session-start");
    expect(session.status).toBe(0);
    const sessionPayload = JSON.parse(session.stdout);
    expect(sessionPayload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(sessionPayload.hookSpecificOutput.additionalContext).toContain("Cortex project:");

    const changedPath = join(vault, "project-map.md");
    writeFileSync(changedPath, readFileSync(changedPath, "utf8") + "\nHook process edit.\n");
    const reindex = runHook(vault, "reindex", { tool_input: { file_path: changedPath } });
    expect(reindex.status).toBe(0);
    expect(reindex.stdout).toBe("");

    const warning = runHook(join(vault, "..", "missing-vault"), "reindex", { tool_input: { file_path: "/tmp/not-in-vault.md" } });
    expect(warning.status).toBe(0);
    expect(warning.stderr).toContain("Cortex hook warning:");
    expect(JSON.parse(warning.stdout).hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  test("keeps the project configuration and skill discoverable", () => {
    const mcp = JSON.parse(readFileSync(join(process.cwd(), ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cortex.command).toBe("bun");

    // Claude Code does not expand ${CLAUDE_PROJECT_DIR} inside .mcp.json, so the
    // launch command must be fully resolved or the server dies on startup.
    const args: string[] = mcp.mcpServers.cortex.args;
    expect(args.join(" ")).not.toContain("${");
    expect(args).toContain(join(process.cwd(), "src", "cli.ts"));

    // The vault is a separate repository, so it must be named explicitly rather
    // than inferred from an ambient CORTEX_VAULT_ROOT that only exists in some shells.
    expect(args).toContain("--vault");
    expect(existsSync(args[args.indexOf("--vault") + 1] ?? "")).toBe(true);
    expect(readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8")).toContain("project_map");
    expect(readFileSync(join(process.cwd(), ".claude", "skills", "notes", "SKILL.md"), "utf8")).toContain("patch_section");
  });
});
