# Cortex

A local-first, version-controlled notes system where **Markdown files are the source of
truth** — and every note is wired into a live graph of the code it documents. Humans get a
fast, Obsidian-style editor and graph view; agents get a structured
[MCP](https://modelcontextprotocol.io) interface that puts the right note in front of them
the moment they touch the file or module it explains, instead of re-deriving that context
from scratch.

## Why

The usual agent-notes loop is lossy: an agent writes docs into a folder, a human copies them
into Notion for a readable UI, the agent edits, and the copy goes stale — so nobody trusts it
and nobody reads it. Cortex removes the copy step. Notes live as plain Markdown under Git,
SQLite is just a rebuildable index over them, and read-before / update-after discipline is
enforced deterministically (hooks + MCP tools), not left to the model to remember.

Notes aren't a side channel next to the code graph — they're part of it. A note's
`applies_to` frontmatter creates real graph edges (`documents`, `implements`, `owns`) linking
it to the file or module it's about, stored in the same SQLite projection as the codebase's
directory, import, and dependency structure. Call `project_map` or `search` and you land on
the note attached to the code in question, not a folder of Markdown to search by hand. For
an agent starting cold — a new session, a subagent with no prior context — that's the
difference between re-deriving a decision from five files and reading the one paragraph that
already explains it.

## How it works

- **Storage** — Markdown + YAML frontmatter, in a Git repo (a "vault"). This is the only
  source of truth; everything else is derived and safe to delete and rebuild.
- **Indexer** — parses notes and builds a SQLite (FTS5) index: full-text search, backlinks,
  a project graph linking notes to the code they document, and queryable tables.
- **MCP server** — exposes bounded, token-efficient tools (`get_note`, `get_section`,
  `patch_section`, `search`, `project_map`, `graph_query`, `get_context`, `query_table`,
  and more) so an agent can pull a compact slice of context instead of grepping and reading
  whole files.
- **Web UI** — a Vite/React app with a CodeMirror-based editor, a Markdown reading mode, and
  an interactive graph view with drill-down navigation between notes and code.
- **Git-backed history** — every note change is versioned; history, diffs, and restores are
  exposed through the same MCP interface.

## Requirements

- [Bun](https://bun.sh) (runtime, package manager, test runner, and SQLite driver)

## Getting started

```bash
bun install

# Point Cortex at a vault (a Git repo of Markdown notes) and start the backend + UI
bun run dev --vault /path/to/your-notes-vault
```

This starts the local API/UI server (default `http://localhost:4170`) and, if built,
serves the web UI from `ui/dist`. To work on the UI with hot reload instead:

```bash
bun run ui:dev
```

### Initialize a new vault

```bash
bun run vault:init /path/to/new-vault
```

### Use it with Claude Code

Point an MCP client at the CLI's `mcp` command, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/cortex/src/cli.ts", "mcp", "--vault", "/path/to/your-notes-vault"]
    }
  }
}
```

## CLI

```
dev [--vault <path>] [--workspace <path>] [--port <port>]   Start the backend + UI server
parse <file>                                                  Parse a single Markdown file
index --vault <path> [--workspace <path>]                     Rebuild the SQLite index
vault:init <path>                                             Initialize a new vault
vault:check --vault <path>                                    Validate vault integrity
migrate --vault <path> [--dry-run]                            Run vault migrations
mcp --vault <path> [--workspace <path>] [--check]             Start the MCP server
workspace:init --vault <path> --workspace <path> [--include <repo,repo>]
workspace:check --vault <path>
workspace:remove-repository --vault <path> <repository-id>
workspace:setup-claude --vault <path> --workspace <path>
git:status --vault <path>
git:history --vault <path> <note-path>
git:diff --vault <path> <note-path> [revision]
git:restore --vault <path> <note-path> <revision>
```

## Development

```bash
bun test          # run the test suite
bun run typecheck  # type-check the backend
bun run ui:build   # build the web UI
bun run e2e        # Playwright end-to-end tests for the UI
bun run benchmark  # run the indexing/query benchmarks in bench/
```

## Project layout

```
src/
  core/     vault, indexer, SQLite store, project graph, workspace, Git adapter
  mcp/      MCP server and tool implementations
  api/      local HTTP/SSE API for the web UI
  cli.ts    command-line entry point
ui/         Vite/React web UI (editor, reader, graph view)
tests/      backend test suite (bun test)
bench/      indexing/query benchmarks
```

## Status

Early and under active development. Interfaces and the on-disk index format may change.

## License

[MIT](./LICENSE)
