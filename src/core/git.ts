import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { requireGitVault } from "./vault.js";

export type GitStatusEntry = {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
};

export type GitCommit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

function runGit(vaultRoot: string, args: string[]): string {
  const root = requireGitVault(vaultRoot);
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

export class GitAdapter {
  readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = requireGitVault(vaultRoot);
    const topLevel = runGit(this.vaultRoot, ["rev-parse", "--show-toplevel"]).trim();
    if (resolve(realpathSync(topLevel)) !== resolve(realpathSync(this.vaultRoot))) throw new Error("Vault Git root does not match the configured vault path.");
  }

  status(): GitStatusEntry[] {
    const output = runGit(this.vaultRoot, ["status", "--porcelain=v1", "-z"]);
    const entries: GitStatusEntry[] = [];
    const parts = output.split("\0").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const record = parts[index];
      const indexState = record[0] ?? " ";
      const worktreeState = record[1] ?? " ";
      const path = record.slice(3);
      if (indexState === "R" || indexState === "C" || worktreeState === "R" || worktreeState === "C") {
        const originalPath = parts[++index];
        entries.push({ index: indexState, worktree: worktreeState, path, originalPath });
      } else {
        entries.push({ index: indexState, worktree: worktreeState, path });
      }
    }
    return entries;
  }

  history(path: string, limit = 20): GitCommit[] {
    const output = runGit(this.vaultRoot, ["log", `-${limit}`, "--follow", "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", "--", path]);
    return output.split("\x1e").filter(Boolean).map((record) => {
      const [hash, author, date, subject] = record.replace(/\n$/, "").split("\x1f");
      return { hash, author, date, subject };
    });
  }

  diff(path: string, revision?: string): string {
    return revision
      ? runGit(this.vaultRoot, ["diff", `${revision}^`, revision, "--", path])
      : runGit(this.vaultRoot, ["diff", "--", path]);
  }

  restore(path: string, revision: string): void {
    const dirty = this.status().some((entry) => entry.path === path || entry.originalPath === path);
    if (dirty) throw new Error(`Refusing to restore dirty path '${path}'. Commit or discard local changes first.`);
    runGit(this.vaultRoot, ["restore", "--source", revision, "--", path]);
  }
}
