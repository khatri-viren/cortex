import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../src/core/vault.js";
import { VaultIndexer } from "../src/core/indexer.js";
import { GitAdapter } from "../src/core/git.js";
import { startWatcher } from "../src/core/watcher.js";

function tempVault(): string {
  return initVault(join(mkdtempSync(join(tmpdir(), "cortex-phase1-")), "vault"));
}

function git(vault: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", vault, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe("Phase 1 indexer", () => {
  test("builds notes, tables, FTS, and the project graph", () => {
    const vault = tempVault();
    writeFileSync(join(vault, "package.json"), JSON.stringify({ dependencies: { yaml: "^2.9.0" }, devDependencies: { typescript: "^5.9.0" } }));
    writeFileSync(join(vault, "src.ts"), "export const value = 1;\n");
    writeFileSync(join(vault, "src.test.ts"), "import { value } from './src';\ntest('value', () => value);\n");
    const indexer = new VaultIndexer(vault);
    const report = indexer.fullRebuild();
    expect(report.noteCount).toBe(2);
    expect(report.tableRowCount).toBe(0);
    expect(report.graphNodeCount).toBeGreaterThanOrEqual(8);
    expect(report.graphEdgeCount).toBeGreaterThanOrEqual(8);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'backend'").get() as { count: number }).count).toBe(1);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM graph_edges WHERE kind = 'imports'").get() as { count: number }).count).toBe(1);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM graph_edges WHERE kind = 'depends_on'").get() as { count: number }).count).toBeGreaterThanOrEqual(2);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM graph_edges WHERE kind = 'tested_by'").get() as { count: number }).count).toBe(1);
    expect(indexer.store.noteByPath("notes/engine.md")).toMatchObject({ path: "notes/engine.md", title: "Engine Notes" });
    expect(indexer.store.noteById(indexer.store.noteByPath("notes/engine.md")!.id)?.aliases).toContain("Backend Notes");
    expect(indexer.store.searchNotes("backend", 20).hits.some((hit) => hit.path === "notes/engine.md")).toBe(true);
    expect(indexer.store.graphNodeIdByPath("src.ts")).toBe("file:src.ts");
    expect(indexer.store.fileHash("notes/engine.md")).toMatch(/^[0-9a-f]{64}$/);
    indexer.close();
  });

  test("incrementally updates and removes note projections without stale search rows", () => {
    const vault = tempVault();
    const notePath = join(vault, "notes", "engine.md");
    const indexer = new VaultIndexer(vault);
    indexer.fullRebuild();
    const original = readFileSync(notePath, "utf8");
    writeFileSync(notePath, `${original}\nNow see [[Project Map]].\n`);
    const update = indexer.incrementalRebuild([notePath]);
    expect(update.mode).toBe("incremental");
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM links WHERE target_title = 'Project Map' AND status = 'resolved'").get() as { count: number }).count).toBe(1);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'diagnostics'").get() as { count: number }).count).toBe(1);

    unlinkSync(notePath);
    indexer.incrementalRebuild([notePath]);
    expect(indexer.store.counts().noteCount).toBe(1);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM links WHERE target_title = 'Engine Notes' AND status = 'unresolved'").get() as { count: number }).count).toBe(1);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'diagnostics'").get() as { count: number }).count).toBe(0);
    indexer.close();
  });

  test("invalid Markdown is represented by diagnostics and does not remain searchable", () => {
    const vault = tempVault();
    const brokenPath = join(vault, "broken.md");
    writeFileSync(brokenPath, "# Broken\n\nThis should not enter the note index.\n");
    const indexer = new VaultIndexer(vault);
    const report = indexer.fullRebuild();
    expect(report.diagnostics.some((item) => item.code === "missing-frontmatter")).toBe(true);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM notes WHERE path = 'broken.md'").get() as { count: number }).count).toBe(0);
    expect((indexer.store.db.query("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'broken'").get() as { count: number }).count).toBe(0);
    indexer.close();
  });

  test("a full rebuild reproduces the same projection after deleting the database", () => {
    const vault = tempVault();
    const indexer = new VaultIndexer(vault);
    const first = indexer.fullRebuild();
    const firstCounts = indexer.store.counts();
    indexer.close();
    const dbPath = join(vault, ".cortex", "index.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    const rebuilt = new VaultIndexer(vault);
    const second = rebuilt.fullRebuild();
    expect(second.noteCount).toBe(first.noteCount);
    expect(rebuilt.store.counts()).toEqual(firstCounts);
    rebuilt.close();
  });
});

describe("Git adapter", () => {
  test("reports status, history, diff, and restores a clean path", () => {
    const vault = tempVault();
    git(vault, "config", "user.name", "Cortex Test");
    git(vault, "config", "user.email", "cortex@example.test");
    git(vault, "add", ".");
    git(vault, "commit", "-m", "base");
    const notePath = "project-map.md";
    const absolutePath = join(vault, notePath);
    const base = readFileSync(absolutePath, "utf8");
    writeFileSync(absolutePath, `${base}\nChanged locally.\n`);
    const adapter = new GitAdapter(vault);
    expect(adapter.status().some((entry) => entry.path === notePath)).toBe(true);
    expect(adapter.diff(notePath)).toContain("Changed locally");
    expect(() => adapter.restore(notePath, "HEAD")).toThrow("dirty");
    git(vault, "add", notePath);
    git(vault, "commit", "-m", "change");
    const history = adapter.history(notePath);
    expect(history.length).toBeGreaterThanOrEqual(2);

    // Git terminates its last record with a newline; every parsed commit must be real.
    expect(history.every((commit) => Boolean(commit.hash && commit.author && commit.date && commit.subject))).toBe(true);

    adapter.restore(notePath, "HEAD~1");
    expect(readFileSync(absolutePath, "utf8")).toBe(base);
  });

  test("returns no commits for a path that git does not track", () => {
    const vault = tempVault();
    git(vault, "config", "user.name", "Cortex Test");
    git(vault, "config", "user.email", "cortex@example.test");
    git(vault, "add", ".");
    git(vault, "commit", "-m", "base");
    writeFileSync(join(vault, "untracked.md"), "# Untracked\n");
    expect(new GitAdapter(vault).history("untracked.md")).toEqual([]);
  });
});

describe("watcher", () => {
  test("delivers a filesystem event and persists a snapshot", async () => {
    const vault = tempVault();
    let handle: Awaited<ReturnType<typeof startWatcher>> | undefined;
    const eventPromise = new Promise<string>((resolve) => {
      void startWatcher(vault, async (events) => {
        const watched = events.find((event) => event.path.endsWith("watched.md"));
        if (watched) resolve(watched.path);
      }).then((value) => {
        handle = value;
        writeFileSync(join(vault, "notes", "watched.md"), readFileSync(join(vault, "project-map.md"), "utf8"));
      });
    });
    const eventPath = await Promise.race([
      eventPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("watcher event timeout")), 3000)),
    ]);
    expect(eventPath.endsWith("watched.md")).toBe(true);
    await handle?.stop();
    await handle?.flushSnapshot();
    expect(existsSync(join(vault, ".cortex", "watcher.snapshot"))).toBe(true);
  });
});
