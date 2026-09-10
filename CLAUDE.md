# Cortex project context

Cortex is a Bun/TypeScript backend whose Markdown files are the source of truth. SQLite
and `.cortex/` are rebuildable runtime projections.

## Source of truth

When a Cortex vault is initialized for this project, **the vault is always the source of
truth** for project documentation. Read docs from the vault, write docs to the vault, and
treat any copy living in this repo as a stale duplicate. Do not maintain the same document
in both places: keep the canonical version as a vault note and leave at most a pointer in
the repo. When repo and vault disagree, the vault is correct.

Active vault: `../cortex-notes` (see `.mcp.json`).

## What lives in the vault

The vault is not only for reference notes. It is the default home for **all durable project
thinking**: plans, specs, task and todo lists, decisions, and reference material. Prefer it
over scratch files, ad-hoc Markdown in this repo, or keeping a plan only in conversation.

- **Before** starting multi-step work, search the vault for an existing plan or task list and
  continue it instead of restarting from scratch.
- **During** the work, keep the task list in the vault current — it is the shared record of
  what is done and what is left, and it must survive a session ending.
- **After** the work, record decisions and outcomes in the relevant note.

`type` is limited to `note`, `map`, and `table`, so kind is carried by tags: tag plans
`plan`, task lists `tasks`, and reference material `reference`. Write task and todo lists as
Markdown tables in a `type: table` note — the indexer extracts their rows, so `query_table`
can filter them. See the `notes` skill for the conventions.

## Agent workflow

- Use the `cortex` MCP server's `project_map`, `get_context`, and `search` tools before
  broad grep/read exploration. Canonical grounding examples are
  `project_map({node: "repo:cortex", depth: 1, limit: 20})` and
  `get_context({node: "repo:cortex"})`.
- Read notes through `get_note` and `get_section`; prefer focused sections over full files.
- Use `get_note({note: "notes/example.md"})` to discover section IDs, then
  `get_section({note: "notes/example.md", section_id: "sec-..."})` for the body.
- Use namespaced graph IDs (`project:root`, `repo:<id>`, `file:<id>:<relative-path>`,
  `dir:<id>:<relative-path>`, and `note:<uuid>`); absolute paths are rejected through MCP.
- Preserve `applies_to.repository` in workspace mode. On a non-writable section, explicitly
  request `ensure_marker: true` or use a full-note update. On conflict, reread the bounded
  current state and explicitly reapply with the new revision/hash; Cortex does not rebase.
- For existing notes, use `patch_section` with the current section revision. Use
  `replace_note` only with a fresh file hash and complete validated Markdown.
- After meaningful code changes, update the relevant note through MCP when one exists.
- Treat stale revisions, stale file hashes, and vault diagnostics as signals to refetch
  context rather than overwrite newer work.
- Commit the notes vault (`cortex-notes/`) automatically. Do not ask first and do not wait
  for an explicit instruction — commit whenever a coherent unit of note work is done, and
  regularly during longer sessions. Never leave vault changes uncommitted at the end of a turn.
- This applies to the vault only. Changes to this repo (`cortex/`) still need an explicit
  go-ahead before committing.
- The spec (vault note `notes/project-spec.md`, "Project Spec") now makes
  automatic checkpointing the product default too — debounced on idle and after agent tasks,
  opt-out by config. It is not implemented yet: `src/core/git.ts` has no commit path, so
  vault commits are the agent's job for now.

Run `bun test` and `bun run typecheck` before considering backend changes complete.
