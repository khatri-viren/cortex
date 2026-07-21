import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../src/core/vault.js";

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI smoke tests", () => {
  test("parse and index emit JSON", () => {
    const vault = initVault(join(mkdtempSync(join(tmpdir(), "cortex-cli-")), "vault"));
    const parse = runCli(["parse", join(vault, "project-map.md")]);
    expect(parse.exitCode).toBe(0);
    expect(JSON.parse(parse.stdout.toString()).frontmatter.title).toBe("Project Map");

    const index = runCli(["index", "--vault", vault]);
    expect(index.exitCode).toBe(0);
    expect(JSON.parse(index.stdout.toString()).noteCount).toBe(2);
  });

  test("vault check and MCP check succeed", () => {
    const vault = initVault(join(mkdtempSync(join(tmpdir(), "cortex-cli-")), "vault"));
    const check = runCli(["vault:check", "--vault", vault]);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout.toString()).ok).toBe(true);

    const mcp = runCli(["mcp", "--vault", vault, "--check"]);
    expect(mcp.exitCode).toBe(0);
    expect(JSON.parse(mcp.stdout.toString()).transport).toBe("stdio");
  });
});
